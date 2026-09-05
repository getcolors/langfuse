"""Everything that turns desired state into the six machines and their
addresses, the port of io.github.getcolors.langfuse.topology.

Six machines carry far more derived identity than one: a ClickHouse replica
that names a peer wrongly forms no quorum, an app host that points at a stale
VPC address fails only after the migration timeout, and a firewall rule
sourced from the wrong `/32` is a silent denial.

The node set itself — the six ids, the fallback addresses a `build` renders
with, the aliases, and the refusal of a state that does not describe every
machine — is the Compute Cluster Standard's
(`workspace/standards/compute-cluster.md`) and is ONCE's `compute_cluster`
module, called with the `spec` below and never copied. What stays here is
Langfuse's: the roles and their fixed counts, the per-role plan key, the host
lookups the plays and the DNS stage use, and the ports. Everything here is a
pure function of desired state plus the compute stage's output, so the whole
of it is reachable from the test suite and visible in the goldens. Nothing in
this file may read the environment, the filesystem, or the network.
"""

from __future__ import annotations

import re

from package_once_blue import compute as once_compute
from package_once_blue import compute_cluster as once_cluster

# ---------------------------------------------------------------- the spec

# provider-compute -> what that choice implies.
#
# `required` are the non-secret keys the provider's template interpolates,
# `secrets` the credentials it needs through COLORS_PAR_*, `tofu-env` the
# subset OpenTofu reads from the process environment itself, and `network` the
# private network every database connection crosses — created by this package
# from `vultr-vpc-subnet`, never discovered. Keeping them together is what
# stops a provider being validated against one set of keys and run with
# another. The keys of this map are the advertised providers; Vultr is the
# only one this package has a template and a golden for.
#
# Two keys the template reads are deliberately not required. `vultr-name` is
# an optional override of the profile (Compute Name Standard), and
# `vultr-ssh-keys` is meaningful by its absence (SSH Keypair Standard).
# `vultr-http-sources` is required but deliberately NOT one of the spec's
# `sources`: it accepts the symbolic value `cloudflare`, which the package
# resolves itself (see `tools.http_sources`).
compute_providers: once_cluster.ClusterRegistry = {
    "vultr": {
        "required": ["vultr-region", "vultr-os-id", "vultr-vpc-subnet",
                     "vultr-plan-neon", "vultr-plan-redis", "vultr-plan-clickhouse", "vultr-plan-app",
                     "vultr-ssh-sources", "vultr-http-sources"],
        "secrets": ["vultr-api-key"],
        "tofu-env": {"vultr-api-key": "VULTR_API_KEY"},
        "network": {"mode": "created", "key": "vultr-vpc-subnet"},
    },
}

# The provider a deployment created before this package recorded one in its
# compute output must be running: the only one it ever offered.
default_compute_provider = "vultr"

CLICKHOUSE_NODE_COUNT = 3

# How this package describes itself to ONCE's `compute_cluster`. Four roles in
# play order — `app` last because it is the consumer of the other three — with
# fixed counts: one shard of three ClickHouse replicas, and one machine each
# for the storage tier, the cache and the application. The bare `<profile>`
# alias reaches the app host, the machine an operator most often means. The
# fallback offsets are where each role's placeholder landed inside the subnet
# before adoption, so the committed goldens carry the same addresses: 10, 11,
# 12 for the singletons and 20-22 for the replicas.
spec: once_cluster.ClusterSpec = {
    "registry": compute_providers,
    "default": default_compute_provider,
    "sources": {"non_empty": ["ssh-sources"], "may_be_empty": []},
    "roles": [
        {"role": "neon", "count": 1, "fallback_offset": 10},
        {"role": "redis", "count": 1, "fallback_offset": 11},
        {"role": "clickhouse", "count": CLICKHOUSE_NODE_COUNT, "fallback_offset": 20},
        {"role": "app", "count": 1, "fallback_offset": 12},
    ],
    "entry": {"role": "app", "index": 0},
}

# The roles in play order.
ROLES = [entry["role"] for entry in spec["roles"]]


def compute_name(opts: dict) -> str:
    """The deployment's base machine name (Compute Name Standard §1-2): the
    profile, unless desired state overrides it with `vultr-name`. ONCE's, so
    every label derives from the same value."""
    return once_compute.compute_name(opts)


def machine_name(opts: dict, role: str, i: int | None = None) -> str:
    """The label of a machine: `<name>-<role>` for the singletons and
    `<name>-clickhouse-<i>` for the replicas — the Cluster Standard's fallback
    name, which is also what the template labels the instance."""
    return once_cluster.fallback_node_name(spec, opts, {"role": role, "index": 0 if i is None else i})


def plan_key(role: str) -> str:
    return f"vultr-plan-{role}"


# --------------------------------------------------------------------- hosts


def _singleton_role(role) -> bool:
    """Whether `role` is declared with a count of one."""
    return once_cluster.node_count(spec, {}, role) == 1


def _langfuse_host(node: dict) -> dict:
    """One of ONCE's nodes as this package's renderers read it. Two
    respellings, both at this boundary so every rendered file stays
    byte-identical: ONCE records `vpc_ip` with the underscore where the
    templates, the inventory and the firewall data were written against
    `vpc-ip`; and ONCE gives every node an index (a singleton's is 0) where
    the inventory writes an `ordinal` only for the replicas, so a singleton's
    index reads as None here. Nothing else is touched: the name is the label
    the template gave the instance, never recomputed, and extension fields
    ride through."""
    host = {k: v for k, v in node.items() if k != "vpc_ip"}
    host["vpc-ip"] = node.get("vpc_ip")
    if _singleton_role(node.get("role")):
        host["index"] = None
    return host


def fallback_hosts(opts: dict) -> list[dict]:
    """What a credential-free `build` renders in place of a compute output:
    ONCE's fallbacks — public addresses from `192.0.2.0/24`, private ones cut
    from `vultr-vpc-subnet`, each at its role's offset — so a build is
    byte-identical on every workstation and the committed goldens mean
    something."""
    return [_langfuse_host(n) for n in once_cluster.fallback_nodes(spec, opts)]


_UNSET = object()


def hosts(opts: dict, params=_UNSET) -> list[dict]:
    """The host list the Ansible stage, the DNS stage and the acceptance
    consume.

    `params` is the compute stage's recorded `params` map, adopted under
    `once/cluster` on a real run. On a build there is none, so the fallbacks
    stand in. On a real run ONCE refuses a state that does not describe every
    declared machine with every field, and never substitutes a fallback: a
    ClickHouse cluster config naming fewer replicas than exist forms no
    quorum, and an app environment pointing at a missing address fails only
    after the migration timeout."""
    if params is _UNSET:
        params = opts.get("once/cluster")
    return [_langfuse_host(n) for n in once_cluster.nodes(spec, opts, params)]


def host_of(hosts_: list[dict], role: str, i: int | None = None) -> dict | None:
    """The single host for `role`, or the `i`th ClickHouse node."""
    return next((h for h in hosts_ if h.get("role") == role and h.get("index") == i), None)


def clickhouse_hosts(hosts_: list[dict]) -> list[dict]:
    return sorted((h for h in hosts_ if h.get("role") == "clickhouse"),
                  key=lambda h: h["index"])


# --------------------------------------------------------------------- ports


def port(opts: dict, key: str, default: int) -> int:
    value = opts.get(key)
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, str) and re.fullmatch(r"\d+", value):
        return int(value)
    return default


def clickhouse_http_port(opts: dict) -> int:
    return port(opts, "clickhouse-http-port", 8123)


def clickhouse_native_port(opts: dict) -> int:
    return port(opts, "clickhouse-native-port", 9000)


def clickhouse_interserver_port(opts: dict) -> int:
    return port(opts, "clickhouse-interserver-port", 9009)


def clickhouse_keeper_port(opts: dict) -> int:
    return port(opts, "clickhouse-keeper-port", 9181)


def clickhouse_raft_port(opts: dict) -> int:
    return port(opts, "clickhouse-raft-port", 9234)


def redis_port(opts: dict) -> int:
    return port(opts, "redis-port", 6379)


NEON_COMPUTE_PORT = 55433


def clickhouse_internal_ports(opts: dict) -> list[int]:
    """What the three replicas need from each other: the native port for
    distributed queries and `clusterAllReplicas`, interserver for part
    exchange, the Keeper client port, and raft."""
    return [clickhouse_native_port(opts), clickhouse_interserver_port(opts),
            clickhouse_keeper_port(opts), clickhouse_raft_port(opts)]


def app_clickhouse_ports(opts: dict) -> list[int]:
    """What the app host needs from ClickHouse: HTTP for queries, native for
    the migration runner. Never Keeper, never raft."""
    return [clickhouse_http_port(opts), clickhouse_native_port(opts)]
