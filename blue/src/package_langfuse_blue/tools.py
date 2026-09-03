"""The steps and every template spec, the port of io.github.getcolors.langfuse.tools."""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import secrets
import time
import urllib.request
from decimal import Decimal
from pathlib import Path

import package_neon_blue
from blue import tofu
from blue.ansible import ansible_with_spec
from blue.cli import stage_dir
from blue.runtime import runtime
from blue.scaffold import PRESERVE_JINJA_DELIMITERS, content_spec

from . import ssh_config, topology, validate
from .utils import clj_str as _s

infrastructure_tool = "langfuse-infrastructure"
dns_tool = "langfuse-dns"
ansible_tool = "langfuse-ansible"
ansible_local_tool = "langfuse-ansible-local"
ROOT = Path(__file__).parent / "resources"

# The storage tier's templates live in the SHA-pinned package-neon-blue
# distribution, not in this repository: blue ships them inside the installed
# package, so they are read from there and never copied in here, never edited.
# A copy of a tier this subtle drifts, and the drift is silent.
NEON_ROOT = Path(package_neon_blue.__file__).parent / "resources"

template_opts = PRESERVE_JINJA_DELIMITERS


def tool_dir(opts: dict, tool: str) -> str:
    return stage_dir(opts, tool, default_profile="langfuse")


def template(path: str, file: str) -> dict:
    name = f"tools/{path}/{file}"
    return {"name": name, "content": (ROOT / name).read_text()}


def neon_template(path: str, file: str) -> dict:
    name = f"tools/{path}/{file}"
    return {"name": f"neon/{name}", "content": (NEON_ROOT / name).read_text()}


def spec(source: dict, target: str, data: dict) -> dict:
    return {"template": source, "target": target, "data": data, "opts": template_opts}


def raw_spec(target: str, content: str) -> dict:
    return content_spec(target, content)


def cidrs(opts: dict, key: str) -> list[str]:
    value = opts.get(key)
    if isinstance(value, (list, tuple)):
        xs = list(value)
    else:
        import re
        xs = re.split(r"[,\s]+", _s(value))
    return [s for s in (_s(x).strip() for x in xs) if s]


def credential_env(opts: dict, *slots: str) -> dict[str, str] | None:
    merged: dict[str, str] = {}
    for slot in [*slots, "provider-backend"]:
        merged.update(validate.tofu_env(opts, slot))
    result = {}
    for key, env_var in merged.items():
        value = _s(opts.get(key))
        if value:
            result[env_var] = value
    return result or None


def backend_credential_env(opts: dict) -> dict[str, str] | None:
    return credential_env(opts)


# ------------------------------------------------------------------- json


def _java_double(value: float) -> str:
    """`Double.toString`, which is what Cheshire writes for a double: plain
    decimal with at least one fractional digit between 1e-3 and 1e7, and
    `d.dddE<n>` computerized scientific notation outside that range."""
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "Infinity" if value > 0 else "-Infinity"
    if value == 0:
        return "-0.0" if math.copysign(1.0, value) < 0 else "0.0"
    sign = "-" if value < 0 else ""
    digits, exponent = Decimal(repr(abs(value))).as_tuple()[1:]
    text = "".join(str(d) for d in digits).rstrip("0") or "0"
    # the decimal point sits after `point` digits of `text`
    point = len(digits) + exponent
    if 1e-3 <= abs(value) < 1e7:
        if point <= 0:
            return f"{sign}0.{'0' * (-point)}{text}"
        if point >= len(text):
            return f"{sign}{text}{'0' * (point - len(text))}.0"
        return f"{sign}{text[:point]}.{text[point:]}"
    mantissa = text[0] + "." + (text[1:] or "0")
    return f"{sign}{mantissa}E{point - 1}"


def _json_scalar(value) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return _java_double(value)
    return json.dumps(str(value), ensure_ascii=False)


def _pretty(value, indent: int = 0) -> str:
    """Cheshire's pretty JSON, byte for byte — Green's artifact contract. In
    insertion order: `tofu.constructs_json` sorts keys, which is right for a
    Terraform document and wrong for the documents this package writes
    itself, where the order is the caller's."""
    if isinstance(value, (list, tuple)):
        if not value:
            return "[ ]"
        return "[ " + ", ".join(_pretty(item, indent) for item in value) + " ]"
    if isinstance(value, dict):
        if not value:
            return "{ }"
        pad = " " * (indent + 2)
        body = ",\n".join(f"{pad}{json.dumps(str(k), ensure_ascii=False)} : {_pretty(v, indent + 2)}"
                          for k, v in value.items())
        return "{\n" + body + "\n" + " " * indent + "}"
    return _json_scalar(value)


# ------------------------------------------------------------- compute output


def _hyphenate_keys(value):
    """`vpc_ip` -> `vpc-ip`, recursively. Tofu outputs snake_case; the rest of
    this package speaks kebab-case."""
    if isinstance(value, dict):
        return {str(k).replace("_", "-"): _hyphenate_keys(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_hyphenate_keys(v) for v in value]
    return value


def _index(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return int(value)


def normalize_params(params: dict | None) -> dict | None:
    """The compute stage's `params` output in this package's vocabulary:
    `{ssh-key-id, hosts: [{role, index, name, ip, vpc-ip, user, sudoer}]}`.
    `index` arrives as a number or None; a JSON decoder may hand back a
    float."""
    if params is None:
        return None
    p = _hyphenate_keys(params)
    hosts_ = [{**h, "index": _index(h.get("index"))} for h in (p.get("hosts") or [])]
    return {**p, "hosts": hosts_}


def output_params(result: dict) -> dict | None:
    return normalize_params((result.get("tofu/outputs") or {}).get("params"))


def hosts(opts: dict) -> list[dict]:
    """The host list for every stage after compute (see topology.hosts)."""
    return topology.hosts(opts, opts.get("langfuse/hosts"))


# ---------------------------------------------------------------- compute

# Cloudflare's published ranges, current as of 2026-09-01. Used when
# `vultr-http-sources` is the symbolic value `cloudflare` and the live fetch is
# unavailable — a `build` on a fresh checkout with no network must still
# render. A real converge prefers the fetch and never silently widens.
cloudflare_ranges_fallback = [
    "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
    "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
    "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
    "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
    "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32",
    "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
]

USER_AGENT = "colors-langfuse"


def fetch_cloudflare_ranges() -> list[str] | None:
    """Cloudflare's published ranges, or None when they cannot be fetched.
    Never widens on failure: the caller decides."""
    try:
        def pull(url: str) -> list[str]:
            # An explicit User-Agent, because Cloudflare answers the default
            # `Python-urllib/3.x` with 403 Forbidden. Without it this function
            # always returns None, the fallback list is always rendered, and
            # the colours disagree on `origin` for one desired state — a parity
            # failure that looks like a template bug. Green happens to pass on
            # the JVM's default agent; nothing here should depend on which
            # runtime a colour is written in.
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=10) as response:
                text = response.read().decode()
            return [line.strip() for line in text.splitlines() if line.strip()]

        ranges = [*pull("https://www.cloudflare.com/ips-v4"),
                  *pull("https://www.cloudflare.com/ips-v6")]
        return ranges or None
    except Exception:
        return None


def http_sources(opts: dict) -> dict:
    """The origin ingress list. `cloudflare` is a symbolic source this package
    RESOLVES; the result carries how it was obtained so the caller can record
    a checksum and a real converge can refuse a stale fallback."""
    if _s(opts.get("vultr-http-sources")) != "cloudflare":
        return {"source": "explicit", "ranges": cidrs(opts, "vultr-http-sources")}
    live = fetch_cloudflare_ranges()
    if live:
        return {"source": "fetched", "ranges": live}
    return {"source": "fallback", "ranges": cloudflare_ranges_fallback}


def ranges_checksum(values: list[str]) -> str:
    digest = hashlib.sha256("\n".join(sorted(values)).encode()).hexdigest()
    return digest[:16]


def infrastructure_data(opts: dict) -> dict:
    resolved = http_sources(opts)
    ranges = list(resolved["ranges"])
    return {**opts,
            "compute-name": validate.compute_name(opts),
            "ssh-keygen": validate.keygen(opts),
            "ssh-sources-hcl": tofu.hcl_list(cidrs(opts, "vultr-ssh-sources")),
            "http-sources-hcl": tofu.hcl_list(ranges),
            "http-sources-origin": resolved["source"],
            "http-sources-ranges": ranges,
            "http-sources-checksum": ranges_checksum(ranges),
            "clickhouse-node-count": topology.CLICKHOUSE_NODE_COUNT,
            # Rendered into the firewall: a template key that is absent
            # renders as empty rather than failing, and `port = ""` survives
            # build, golden and dry-run to be rejected only by the provider.
            "neon-compute-port": topology.NEON_COMPUTE_PORT,
            "redis-port-value": topology.redis_port(opts),
            "app-clickhouse-ports-hcl":
                tofu.hcl_list([str(p) for p in topology.app_clickhouse_ports(opts)]),
            "clickhouse-internal-ports-hcl":
                tofu.hcl_list([str(p) for p in topology.clickhouse_internal_ports(opts)])}


async def infrastructure_step(opts: dict) -> dict:
    dir = tool_dir(opts, infrastructure_tool)
    data = infrastructure_data(opts)
    specs = [
        spec(template("infrastructure", "main.tf"), f"{dir}/main.tf", data),
        # The resolved range set is recorded, with a checksum, so a firewall
        # change is explainable after the fact.
        raw_spec(f"{dir}/http-sources.json",
                 _pretty({"origin": data["http-sources-origin"],
                          "checksum": data["http-sources-checksum"],
                          "ranges": data["http-sources-ranges"]})),
    ]
    result = await tofu.tofu_with_spec(
        opts, specs, dir=dir, env=credential_env(opts, "provider-compute"))
    if (result.get("blue/exit") or 0) > 0:
        return result
    if opts.get("blue/event") in ("build", "delete"):
        return result
    params = output_params(result) or {}
    error = topology.missing_host_error(opts, params.get("hosts"))
    if error:
        return {**result, "blue/exit": 1, "blue/err": error}
    return {**result, "langfuse/hosts": params.get("hosts"),
            "langfuse/ssh-key-id": params.get("ssh-key-id")}


# ------------------------------------------------------------------- dns


def zone_id() -> str:
    return "${data.cloudflare_zone.zone.id}"


def dns_json(opts: dict, app_ip: str | None) -> str:
    """One proxied A record for the public name, pointing at the app host.
    `ttl 1` means automatic: Cloudflare rejects an explicit TTL on a proxied
    record."""
    return tofu.constructs_json([
        tofu.construct("resource", "cloudflare_dns_record", "langfuse", {
            "zone_id": zone_id(),
            "name": opts.get("langfuse-host"),
            "type": "A",
            "content": app_ip,
            "ttl": 1,
            "proxied": bool(opts.get("cloudflare-proxied")),
        }),
    ])


async def dns_step(opts: dict) -> dict:
    dir = tool_dir(opts, dns_tool)
    app = topology.host_of(hosts(opts), "app") or {}
    specs = [spec(template("dns", "main.tf"), f"{dir}/main.tf", opts),
             raw_spec(f"{dir}/record.tf.json", dns_json(opts, app.get("ip")))]
    return await tofu.tofu_with_spec(
        opts, specs, dir=dir, env=credential_env(opts, "provider-dns"))


# ------------------------------------------------------- ssh config (local)


def ansible_local_data(opts: dict) -> dict:
    """Only what a `build` genuinely knows. Addresses are run-time facts and
    reach the play as extra-vars instead, so the rendered playbook carries no
    IP and is identical on every workstation (SSH Config Standard §6)."""
    return {**opts,
            "ssh-keygen": validate.keygen(opts),
            "ssh-config-identity-file": ssh_config.identity_file(opts)}


def ansible_local_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, ansible_local_tool)
    data = ansible_local_data(opts)
    # ansible.cfg and the inventory are the dependency's, unchanged; the play
    # is this package's own because it writes six stanzas, not one.
    return [spec(neon_template("ansible-local", "ansible.cfg"), f"{dir}/ansible.cfg", data),
            spec(neon_template("ansible-local", "inventory.ini"), f"{dir}/inventory.ini", data),
            spec(template("ansible-local", "main.yml"), f"{dir}/main.yml", data)]


def ssh_config_hosts(opts: dict, hosts_: list[dict]) -> list[dict]:
    """The stanzas the managed block carries: the bare profile reaching the
    app host, then one per machine."""
    app = topology.host_of(hosts_, "app") or {}
    return [{"name": ssh_config.host_alias(opts), "ip": app.get("ip")},
            *({"name": ssh_config.machine_alias(opts, h), "ip": h.get("ip")} for h in hosts_)]


async def ansible_local_step(opts: dict) -> dict:
    """Write or remove the `~/.ssh/config` block. The same playbook serves
    both events; `block_state` is what distinguishes them."""
    dir = tool_dir(opts, ansible_local_tool)
    delete = opts.get("blue/event") == "delete"
    return await ansible_with_spec(
        opts, ansible_local_specs(opts),
        dir=dir, inventory="inventory.ini",
        playbooks={"create": "main.yml", "delete": "main.yml"},
        extra_vars={"host_alias": ssh_config.host_alias(opts),
                    "ssh_hosts": ssh_config_hosts(opts, hosts(opts)),
                    "block_state": "absent" if delete else "present"})


# ------------------------------------------------------------------ ansible


def inventory(opts: dict, hosts_: list[dict]) -> str:
    """Six hosts in four groups, each carrying the facts only it has.

    Every value is a HOST var and no group carries variables: the imported
    neon play targets `neon`, this package's plays target the other three,
    and group_vars precedence would be a live hazard. Cluster-wide facts the
    plays need — the app host's address for the firewall mirrors, the three
    replica addresses for the ClickHouse config — are read through `hostvars`
    at execution time, so one inventory is the single source of every
    address.

    Sorted throughout, the way green's sorted maps are: every golden would
    churn otherwise."""
    def host_entry(h: dict) -> tuple[str, dict]:
        entry = {"ansible_host": h.get("ip"),
                 "ansible_user": h.get("user") or "root",
                 "vpc_ip": h.get("vpc-ip"),
                 "role": h.get("role")}
        if h.get("index") is not None:
            entry["ordinal"] = h["index"]
        return h["name"], dict(sorted(entry.items()))

    def group(role: str) -> dict:
        entries = [host_entry(h) for h in hosts_ if h.get("role") == role]
        return {"hosts": dict(sorted(entries))}

    children = dict(sorted({"neon": group("neon"), "redis": group("redis"),
                            "clickhouse": group("clickhouse"), "app": group("app")}.items()))
    return _pretty({"all": {"children": children}})


def ansible_data(opts: dict) -> dict:
    """Template values for the Ansible stage.

    Deliberately carries no operator secret. Every credential reaches a host
    as an Ansible `lookup('env', ...)` expression written literally into a
    play, where `preserve-jinja-delimiters` passes it through untouched —
    routing it through this map would let the template engine HTML-escape the
    quotes and hand Ansible `&#39;`."""
    return {**opts,
            "ssh-keygen": validate.keygen(opts),
            "compute-name": validate.compute_name(opts),
            "neon-compute-port": topology.NEON_COMPUTE_PORT,
            "clickhouse-node-count": topology.CLICKHOUSE_NODE_COUNT}


NEON_FILES = [
    "ansible.cfg", "main.yml", "cleanup.yml", "compose.yml",
    "pageserver.toml", "identity.toml", "config.json", "scramgen.py",
    "bootstrap.sh", "smoke.sh", "status.sh", "rotate.sh",
]


def neon_specs(dir: str, data: dict) -> list[dict]:
    """The storage tier, rendered UNCHANGED from the pinned dependency into
    its own `neon/` subdirectory. The upstream play copies its files by
    relative `src:` name, so rendering them flat beside this package's
    templates would let a same-named file win silently."""
    sub = f"{dir}/neon"
    return [spec(neon_template("ansible", name), f"{sub}/{name}", data) for name in NEON_FILES]


# This package's own convergence tree: plays, templates, and the scripts the
# plays install. Rendered flat into the stage beside `neon/`.
ANSIBLE_FILES = [
    "site.yml", "common.yml", "neon-pre.yml", "neon-compose.override.yml",
    "clickhouse.yml", "clickhouse-config.xml", "clickhouse-users.xml",
    "clickhouse-backup.xml", "clickhouse-backup.sh", "clickhouse-restore-check.sh",
    "clickhouse-monitor.sh",
    "redis.yml", "redis-compose.yml", "redis-monitor.sh",
    "langfuse.yml", "langfuse-compose.yml", "Caddyfile", "langfuse.env",
    "langfuse-smoke.sh", "langfuse-credential.sh", "langfuse-monitor.sh",
    "langfuse-rehearsal.sh", "langfuse-status.sh",
    "backups.yml", "r2-env.sh", "postgres-backup.sh", "postgres-restore-check.sh",
    "media-backup.sh", "neon-monitor.sh",
    "rehearsal.yml", "cleanup.yml",
]


def ansible_specs(opts: dict) -> list[dict]:
    dir = tool_dir(opts, ansible_tool)
    data = ansible_data(opts)
    return [*neon_specs(dir, data),
            # The dependency's ansible.cfg, not a local copy: it carries the
            # keygen-mode `private_key_file` conditional, and reusing it is
            # the only version that stays correct when the standard moves.
            spec(neon_template("ansible", "ansible.cfg"), f"{dir}/ansible.cfg", data),
            *[spec(template("ansible", name), f"{dir}/{name}", data) for name in ANSIBLE_FILES],
            raw_spec(f"{dir}/inventory.json", inventory(data, hosts(data)))]


async def ansible_step(opts: dict) -> dict:
    dir = tool_dir(opts, ansible_tool)
    if opts.get("blue/event") == "delete" and not opts.get("langfuse/hosts"):
        # No compute in state: there is no host to stop, and the cleanup play
        # would only fail against the placeholder addresses.
        return {**opts, "blue/exit": 0}
    return await ansible_with_spec(
        opts, ansible_specs(opts),
        dir=dir, inventory="inventory.json",
        playbooks={"create": "site.yml", "delete": "cleanup.yml"},
        host_key_checking=False)


async def rehearsal_step(opts: dict) -> dict:
    """The recovery rehearsal: restore both stores from their newest
    completed sets, boot the pinned image against the restored data, read it
    back through the public API, then the node-loss and Redis-restart drills.
    Only then the recovery marker lands. Runs the same rendered tree as the
    converge."""
    dir = tool_dir(opts, ansible_tool)
    return await ansible_with_spec(
        opts, ansible_specs(opts),
        dir=dir, inventory="inventory.json",
        playbooks={"create": "rehearsal.yml"},
        host_key_checking=False)


# ------------------------------------------------------------- acceptance


async def run_quiet(args: list[str], env: dict[str, str], timeout_ms: int):
    """Run `args` with `env` overlaid, returning the result. Nothing from the
    child is echoed; callers decide what becomes an error message, so a
    secret passed through `env` can never leak into output by default."""
    return await runtime.exec(args, env=env if env else None, timeout_ms=timeout_ms)


async def ssh_read(alias: str, path: str) -> str | None:
    """A file's content read over SSH through the generated alias, held only
    in this process. Never merged into opts, never printed."""
    r = await run_quiet(["ssh", "-o", "BatchMode=yes", alias, "cat", path], {}, 20000)
    if _exit(r) != 0:
        return None
    return _s(_out(r)).strip()


def curl_args(*args: str) -> list[str]:
    """curl with the status code on the last line and a bounded time budget."""
    return ["curl", "-sS", "--max-time", "30", "-w", "\n%{http_code}", *args]


def _out(r) -> str:
    return _s(r.get("out") if isinstance(r, dict) else getattr(r, "out", None))


def _exit(r) -> int:
    return (r.get("exit") if isinstance(r, dict) else getattr(r, "exit", None)) or 0


def _status_of(r) -> str:
    lines = _out(r).strip().splitlines()
    return lines[-1] if lines else ""


def _body_of(r) -> str:
    return "\n".join(_out(r).splitlines()[:-1])


def hex_id(n: int) -> str:
    """An OTel id: `n` random bytes as lowercase hex (16 for a trace, 8 for a
    span)."""
    return secrets.token_hex(n)


def otlp_body(trace_id: str, span_id: str) -> str:
    """One OTLP/JSON request: a root span named for the operator path, tagged
    so it can be found, with the observation type and an input/output pair.
    This is the v4 ingestion contract; the legacy batch endpoint rejects
    every event on a fresh v4 deployment."""
    now = int(time.time() * 1000) * 1000000

    def attr(k: str, v: str) -> dict:
        return {"key": k, "value": {"stringValue": v}}

    return json.dumps({
        "resourceSpans": [{
            "resource": {"attributes": [attr("service.name", "colors-operator")]},
            "scopeSpans": [{
                "scope": {"name": "colors-operator"},
                "spans": [{
                    "traceId": trace_id, "spanId": span_id,
                    "name": "colors-operator-acceptance", "kind": 1,
                    "startTimeUnixNano": str(now), "endTimeUnixNano": str(now + 1000000),
                    "attributes": [
                        attr("langfuse.observation.type", "span"),
                        attr("langfuse.trace.name", "colors-operator-acceptance"),
                        {"key": "langfuse.trace.tags",
                         "value": {"arrayValue": {"values": [{"stringValue": "colors-operator"}]}}},
                        attr("langfuse.observation.input", "public-name"),
                        attr("langfuse.observation.output", "ok"),
                    ]}]}]}]}, separators=(",", ":"))


def observations_count(r) -> int:
    """How many observation rows the v2 API returns for a trace, from a curl
    result, or 0 when the body is not what the API promises."""
    try:
        return len(json.loads(_body_of(r))["data"])
    except Exception:
        return 0


async def acceptance_step(opts: dict) -> dict:
    """The operator-path gate, after a real create.

    The server-side gates already ran inside the playbook. What is checked
    from here is what only this side can check: the public name over TLS
    through Cloudflare, an ingestion with the generated project keys read
    over SSH and a read-back through the same edge, the refusal of a wrong
    key, and the SSH alias of every machine."""
    if opts.get("blue/event") != "create":
        return {**opts, "blue/exit": 0}
    host = opts.get("langfuse-host")
    app_alias = ssh_config.host_alias(opts)
    pk = await ssh_read(app_alias, "/etc/langfuse/secrets/project_public_key")
    sk = await ssh_read(app_alias, "/etc/langfuse/secrets/project_secret_key")
    base = f"https://{host}"
    health = await run_quiet(
        curl_args(f"{base}/api/public/health?failIfDatabaseUnavailable=true"), {}, 40000)
    if _status_of(health) != "200":
        return {**opts, "blue/exit": 1,
                "blue/err": f"acceptance: {base}/api/public/health answered "
                            f"{_status_of(health)} through the public name"}
    if not _s(pk).strip() or not _s(sk).strip():
        return {**opts, "blue/exit": 1,
                "blue/err": "acceptance: could not read the generated project keys over ssh"}

    trace_id = hex_id(16)
    auth = f"{pk}:{sk}"
    ingest = await run_quiet(
        curl_args("-u", auth, "-H", "Content-Type: application/json",
                  "-H", "x-langfuse-ingestion-version: 4",
                  "-X", "POST", "--data-binary", otlp_body(trace_id, hex_id(8)),
                  f"{base}/api/public/otel/v1/traces"),
        {}, 40000)
    v2 = f"{base}/api/public/v2/observations?traceId={trace_id}&limit=10"
    deadline = time.monotonic() + 120
    while True:
        read_back = await run_quiet(curl_args("-u", auth, v2), {}, 40000)
        if _status_of(read_back) == "200" and observations_count(read_back) > 0:
            break
        if time.monotonic() >= deadline:
            break
        await asyncio.sleep(5)
    denied = await run_quiet(curl_args("-u", f"{pk}:not-the-key", v2), {}, 40000)
    anonymous = await run_quiet(curl_args(v2), {}, 40000)
    aliases = ssh_config.aliases(opts)
    unreachable = []
    for alias in aliases:
        r = await run_quiet(["ssh", "-o", "BatchMode=yes", alias, "true"], {}, 20000)
        if _exit(r) != 0:
            unreachable.append(alias)

    if _status_of(ingest) != "200":
        return {**opts, "blue/exit": 1,
                "blue/err": "acceptance: OTLP ingestion through the public name answered "
                            f"{_status_of(ingest)}: {_body_of(ingest).strip()}"}
    if _status_of(read_back) != "200" or observations_count(read_back) == 0:
        return {**opts, "blue/exit": 1,
                "blue/err": f"acceptance: trace {trace_id} was not readable through the public "
                            f"name within 120s (last status {_status_of(read_back)}, "
                            f"{observations_count(read_back)} rows)"}
    if _status_of(denied) == "200":
        return {**opts, "blue/exit": 1,
                "blue/err": "acceptance: a wrong secret key was accepted through the public name"}
    if _status_of(anonymous) == "200":
        return {**opts, "blue/exit": 1,
                "blue/err": "acceptance: an unauthenticated request was accepted through the public name"}
    if unreachable:
        return {**opts, "blue/exit": 1,
                "blue/err": "acceptance: ssh alias unreachable: " + ", ".join(unreachable)}
    return {**opts, "blue/exit": 0,
            "langfuse/acceptance": {"public-health": "200", "ingested": trace_id,
                                    "read-back": "200", "wrong-key": "refused",
                                    "anonymous": "refused",
                                    "ssh-aliases": len(aliases)}}


# --------------------------------------------------------------- describe

MONITOR_FILES = {
    "neon": "/var/lib/colors/neon-monitor.json",
    "redis": "/var/lib/colors/redis-monitor.json",
    "clickhouse": "/var/lib/colors/clickhouse-monitor.json",
    "app": "/var/lib/colors/langfuse-monitor.json",
}


async def describe_step(opts: dict) -> dict:
    """Read every host's last monitor result over SSH and print them. Exits
    non-zero when any host is unreachable or reports unhealthy; this is the
    aggregation the README points an external poller at."""
    rows = []
    for h in hosts(opts):
        alias = ssh_config.machine_alias(opts, h)
        file = MONITOR_FILES.get(h.get("role"))
        r = await run_quiet(["ssh", "-o", "BatchMode=yes", alias, "cat", file], {}, 20000)
        body = _out(r).strip()
        try:
            parsed = json.loads(body)
            if not isinstance(parsed, dict):
                parsed = {}
        except Exception:
            parsed = {}
        reachable = _exit(r) == 0
        problems = parsed.get("problems")
        if problems is None and not reachable:
            problems = ["unreachable or no monitor result yet"]
        rows.append({"host": h.get("name"),
                     "reachable": reachable,
                     "healthy": bool(parsed.get("healthy")),
                     "checked": parsed.get("checked"),
                     "problems": problems})
    for row in rows:
        status = ("UNKNOWN" if not row["reachable"]
                  else "ok" if row["healthy"] else "UNHEALTHY")
        detail = _s(row["checked"])
        if row["problems"]:
            detail += " " + "; ".join(_s(p) for p in row["problems"])
        print(f"{_s(row['host']):<32} {status:<10} {detail}")
    ok = all(row["reachable"] and row["healthy"] for row in rows)
    return {**opts, "blue/exit": 0 if ok else 1, "langfuse/describe": rows}
