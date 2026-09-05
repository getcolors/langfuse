terraform {
  required_providers {
    vultr = { source = "vultr/vultr", version = "~> 2.0" }
  }
}

provider "vultr" {
  # api key comes from VULTR_API_KEY in the environment
}

locals {
  ssh_sources  = <{ ssh-sources-hcl|safe }>
  # Resolved from Cloudflare's published ranges by the package when
  # `vultr-http-sources` is the symbolic value `cloudflare`, and recorded with
  # a checksum in http-sources.json beside this file.
  http_sources = <{ http-sources-hcl|safe }>
  vpc_block    = split("/", "<{ vultr-vpc-subnet }>")[0]
  vpc_prefix   = tonumber(split("/", "<{ vultr-vpc-subnet }>")[1])
  # What the app host needs from ClickHouse (HTTP for queries, native for the
  # migration runner) and what the three replicas need from each other (native
  # for distributed queries, interserver for part exchange, Keeper, raft).
  app_clickhouse_ports      = <{ app-clickhouse-ports-hcl|safe }>
  clickhouse_internal_ports = <{ clickhouse-internal-ports-hcl|safe }>
  clickhouse_node_count     = <{ clickhouse-node-count }>
}

<% if ssh-keygen %># The machine keypair this deployment generated and owns (SSH Keypair
# Standard): the account resource is named after the profile and lives in this
# stack's state, which is what makes its ownership decidable. One key for every
# machine — the deployment is one thing, and a key per machine would multiply
# the thing the standard exists to make singular. Never reference a literal key
# id here in keygen mode.
resource "vultr_ssh_key" "machine" {
  name    = "<{ profile }>"
  # fileexists: a delete after a completed delete renders this stack with the
  # key files already gone (the keypair cleanup is the last step) and tofu
  # evaluates file() even while destroying an empty state. A real create has
  # generated the file in preflight before this renders, so the empty branch
  # is never applied.
  ssh_key = fileexists("<{ ssh-public-key-path }>") ? trimspace(file("<{ ssh-public-key-path }>")) : ""
}

<% endif %># The private network carrying every database connection. Nothing on those
# ports is ever published: the firewall groups below open 22 everywhere, 80 and
# 443 on the app host only, and the service ports only to the specific peer
# that needs them.
#
# `vultr_vpc`, not `vultr_vpc2`: Vultr has retired the VPC 2.0 API while the
# provider still ships the resource and its documentation.
resource "vultr_vpc" "langfuse" {
  region         = "<{ vultr-region }>"
  description    = "<{ compute-name }>"
  v4_subnet      = local.vpc_block
  v4_subnet_mask = local.vpc_prefix
}

# One firewall group per role, because a Vultr firewall group filters the
# PRIVATE interface as well as the public one — and does so selectively: ICMP
# passes, TCP does not. One shared group would either open every database port
# to every VPC member (a compromised Redis reaching Keeper) or open nothing
# east-west at all. East-west rules are sourced from the peer's actual
# address, `/32`, never from the subnet.
resource "vultr_firewall_group" "app" {
  description = "<{ compute-name }>-app-firewall"
}
resource "vultr_firewall_group" "neon" {
  description = "<{ compute-name }>-neon-firewall"
}
resource "vultr_firewall_group" "redis" {
  description = "<{ compute-name }>-redis-firewall"
}
resource "vultr_firewall_group" "clickhouse" {
  description = "<{ compute-name }>-clickhouse-firewall"
}

# 22 carries convergence and recovery on every host. Key-only by an sshd
# drop-in the play installs and a gate asserts.
resource "vultr_firewall_rule" "ssh_app" {
  for_each          = toset(local.ssh_sources)
  firewall_group_id = vultr_firewall_group.app.id
  protocol          = "tcp"
  port              = "22"
  ip_type           = strcontains(each.value, ":") ? "v6" : "v4"
  subnet            = split("/", each.value)[0]
  subnet_size       = tonumber(split("/", each.value)[1])
}
resource "vultr_firewall_rule" "ssh_neon" {
  for_each          = toset(local.ssh_sources)
  firewall_group_id = vultr_firewall_group.neon.id
  protocol          = "tcp"
  port              = "22"
  ip_type           = strcontains(each.value, ":") ? "v6" : "v4"
  subnet            = split("/", each.value)[0]
  subnet_size       = tonumber(split("/", each.value)[1])
}
resource "vultr_firewall_rule" "ssh_redis" {
  for_each          = toset(local.ssh_sources)
  firewall_group_id = vultr_firewall_group.redis.id
  protocol          = "tcp"
  port              = "22"
  ip_type           = strcontains(each.value, ":") ? "v6" : "v4"
  subnet            = split("/", each.value)[0]
  subnet_size       = tonumber(split("/", each.value)[1])
}
resource "vultr_firewall_rule" "ssh_clickhouse" {
  for_each          = toset(local.ssh_sources)
  firewall_group_id = vultr_firewall_group.clickhouse.id
  protocol          = "tcp"
  port              = "22"
  ip_type           = strcontains(each.value, ":") ? "v6" : "v4"
  subnet            = split("/", each.value)[0]
  subnet_size       = tonumber(split("/", each.value)[1])
}

# 80 as well as 443, on the app host only: Caddy answers the ACME HTTP-01
# challenge on 80, and with the record proxied that challenge arrives from a
# Cloudflare address, which these rules admit. The validator refuses the
# unproxied combination, whose failure is a certificate that is never issued.
resource "vultr_firewall_rule" "http" {
  for_each          = toset(local.http_sources)
  firewall_group_id = vultr_firewall_group.app.id
  protocol          = "tcp"
  port              = "80"
  ip_type           = strcontains(each.value, ":") ? "v6" : "v4"
  subnet            = split("/", each.value)[0]
  subnet_size       = tonumber(split("/", each.value)[1])
}
resource "vultr_firewall_rule" "https" {
  for_each          = toset(local.http_sources)
  firewall_group_id = vultr_firewall_group.app.id
  protocol          = "tcp"
  port              = "443"
  ip_type           = strcontains(each.value, ":") ? "v6" : "v4"
  subnet            = split("/", each.value)[0]
  subnet_size       = tonumber(split("/", each.value)[1])
}

# --- instances ---------------------------------------------------------------
#
# `label` is the console name and updates in place. There is deliberately no
# `hostname`: Vultr implements a hostname change as an OS reinstall, so the
# provider marks that attribute ForceNew, and editing the name would destroy
# the instance and its disk rather than rename it. SSH keys are likewise
# ForceNew: rotation is a rebuild, never an edit on a machine whose disk you
# intend to keep.

resource "vultr_instance" "neon" {
  label             = "<{ compute-name }>-neon"
  region            = "<{ vultr-region }>"
  plan              = "<{ vultr-plan-neon }>"
  os_id             = <{ vultr-os-id }>
  firewall_group_id = vultr_firewall_group.neon.id
  vpc_ids           = [vultr_vpc.langfuse.id]
<% if ssh-keygen %>  ssh_key_ids = [vultr_ssh_key.machine.id]
<% else %>  ssh_key_ids = ["<{ vultr-ssh-keys }>"]
<% endif %>  connection {
    type = "ssh"
    user = "root"
    host = self.main_ip
<% if ssh-keygen %>    private_key = file("<{ ssh-private-key-path }>")
<% endif %>  }
  provisioner "remote-exec" {
    inline = ["ls"]
  }
  lifecycle { prevent_destroy = <{ compute-prevent-destroy }> }
}

resource "vultr_instance" "redis" {
  label             = "<{ compute-name }>-redis"
  region            = "<{ vultr-region }>"
  plan              = "<{ vultr-plan-redis }>"
  os_id             = <{ vultr-os-id }>
  firewall_group_id = vultr_firewall_group.redis.id
  vpc_ids           = [vultr_vpc.langfuse.id]
<% if ssh-keygen %>  ssh_key_ids = [vultr_ssh_key.machine.id]
<% else %>  ssh_key_ids = ["<{ vultr-ssh-keys }>"]
<% endif %>  connection {
    type = "ssh"
    user = "root"
    host = self.main_ip
<% if ssh-keygen %>    private_key = file("<{ ssh-private-key-path }>")
<% endif %>  }
  provisioner "remote-exec" {
    inline = ["ls"]
  }
  lifecycle { prevent_destroy = <{ compute-prevent-destroy }> }
}

resource "vultr_instance" "clickhouse" {
  count             = local.clickhouse_node_count
  label             = "<{ compute-name }>-clickhouse-${count.index}"
  region            = "<{ vultr-region }>"
  plan              = "<{ vultr-plan-clickhouse }>"
  os_id             = <{ vultr-os-id }>
  firewall_group_id = vultr_firewall_group.clickhouse.id
  vpc_ids           = [vultr_vpc.langfuse.id]
<% if ssh-keygen %>  ssh_key_ids = [vultr_ssh_key.machine.id]
<% else %>  ssh_key_ids = ["<{ vultr-ssh-keys }>"]
<% endif %>  connection {
    type = "ssh"
    user = "root"
    host = self.main_ip
<% if ssh-keygen %>    private_key = file("<{ ssh-private-key-path }>")
<% endif %>  }
  provisioner "remote-exec" {
    inline = ["ls"]
  }
  lifecycle { prevent_destroy = <{ compute-prevent-destroy }> }
}

resource "vultr_instance" "app" {
  label             = "<{ compute-name }>-app"
  region            = "<{ vultr-region }>"
  plan              = "<{ vultr-plan-app }>"
  os_id             = <{ vultr-os-id }>
  firewall_group_id = vultr_firewall_group.app.id
  vpc_ids           = [vultr_vpc.langfuse.id]
<% if ssh-keygen %>  ssh_key_ids = [vultr_ssh_key.machine.id]
<% else %>  ssh_key_ids = ["<{ vultr-ssh-keys }>"]
<% endif %>  connection {
    type = "ssh"
    user = "root"
    host = self.main_ip
<% if ssh-keygen %>    private_key = file("<{ ssh-private-key-path }>")
<% endif %>  }
  provisioner "remote-exec" {
    inline = ["ls"]
  }
  lifecycle { prevent_destroy = <{ compute-prevent-destroy }> }
}

# --- east-west, per peer address ---------------------------------------------
#
# `count` over static lengths rather than `for_each` over addresses: the
# addresses are known only after apply, and a for_each keyed on them fails the
# plan with "value depends on resource attributes that cannot be determined
# until apply". Every rule below is a `/32` from an instance's VPC address.

# The app host reaches the Neon compute node and nothing else on that host.
resource "vultr_firewall_rule" "neon_from_app" {
  firewall_group_id = vultr_firewall_group.neon.id
  protocol          = "tcp"
  port              = "<{ neon-compute-port }>"
  ip_type           = "v4"
  subnet            = vultr_instance.app.internal_ip
  subnet_size       = 32
}

# The app host reaches Redis and nothing else on that host.
resource "vultr_firewall_rule" "redis_from_app" {
  firewall_group_id = vultr_firewall_group.redis.id
  protocol          = "tcp"
  port              = "<{ redis-port-value }>"
  ip_type           = "v4"
  subnet            = vultr_instance.app.internal_ip
  subnet_size       = 32
}

# The app host reaches ClickHouse's client ports — never Keeper, never raft.
resource "vultr_firewall_rule" "clickhouse_from_app" {
  count             = length(local.app_clickhouse_ports)
  firewall_group_id = vultr_firewall_group.clickhouse.id
  protocol          = "tcp"
  port              = local.app_clickhouse_ports[count.index]
  ip_type           = "v4"
  subnet            = vultr_instance.app.internal_ip
  subnet_size       = 32
}

# The three replicas reach each other: distributed queries, part exchange,
# Keeper, raft. Nothing from Neon or Redis.
resource "vultr_firewall_rule" "clickhouse_internal" {
  count             = local.clickhouse_node_count * length(local.clickhouse_internal_ports)
  firewall_group_id = vultr_firewall_group.clickhouse.id
  protocol          = "tcp"
  port              = local.clickhouse_internal_ports[count.index % length(local.clickhouse_internal_ports)]
  ip_type           = "v4"
  subnet            = vultr_instance.clickhouse[floor(count.index / length(local.clickhouse_internal_ports))].internal_ip
  subnet_size       = 32
}

# The Compute Cluster Standard's contract: `provider` names the template that
# produced this state, ownership of the machine key is the resource id recorded
# in state and surfaced as `params.ssh_key_id`, and `nodes` is what every later
# stage consumes: role, 0-based index within the role, label, public and VPC
# address.
output "params" {
  value = {
    provider = "vultr"
<% if ssh-keygen %>    ssh_key_id = vultr_ssh_key.machine.id
<% endif %>    nodes = concat(
      [{
        role = "neon", index = 0, name = vultr_instance.neon.label
        ip = vultr_instance.neon.main_ip, vpc_ip = vultr_instance.neon.internal_ip
        user = "root", sudoer = "root"
      }],
      [{
        role = "redis", index = 0, name = vultr_instance.redis.label
        ip = vultr_instance.redis.main_ip, vpc_ip = vultr_instance.redis.internal_ip
        user = "root", sudoer = "root"
      }],
      [for i, node in vultr_instance.clickhouse : {
        role = "clickhouse", index = i, name = node.label
        ip = node.main_ip, vpc_ip = node.internal_ip
        user = "root", sudoer = "root"
      }],
      [{
        role = "app", index = 0, name = vultr_instance.app.label
        ip = vultr_instance.app.main_ip, vpc_ip = vultr_instance.app.internal_ip
        user = "root", sudoer = "root"
      }]
    )
  }
}
