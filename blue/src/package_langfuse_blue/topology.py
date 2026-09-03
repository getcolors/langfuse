"""Everything that turns desired state into the six machines and their
addresses, the port of io.github.getcolors.langfuse.topology.

Six machines carry far more derived identity than one: a ClickHouse replica
that names a peer wrongly forms no quorum, an app host that points at a stale
VPC address fails only after the migration timeout, and a firewall rule
sourced from the wrong `/32` is a silent denial. Everything here is a pure
function of desired state plus the compute stage's output, so the whole of it
is reachable from the test suite and visible in the goldens. Nothing in this
file may read the environment, the filesystem, or the network.
"""

from __future__ import annotations

import re

from .utils import clj_str as _s

CLICKHOUSE_NODE_COUNT = 3

# The roles in play order. `app` is last because it is the consumer of the
# other three.
ROLES = ["neon", "redis", "clickhouse", "app"]


def compute_name(opts: dict) -> str:
    """The deployment's base machine name (Compute Name Standard §1-2): the
    profile, unless desired state overrides it with `vultr-name`."""
    override = _s(opts.get("vultr-name"))
    if not override.strip() or override.strip() == "REPLACE_ME":
        return _s(opts.get("profile"))
    return override.strip()


def machine_name(opts: dict, role: str, i: int | None = None) -> str:
    """The label of a machine: `<name>-<role>` for the singletons and
    `<name>-clickhouse-<i>` for the replicas."""
    if i is None:
        return f"{compute_name(opts)}-{role}"
    return f"{compute_name(opts)}-{role}-{i}"


def clickhouse_indexes() -> list[int]:
    return list(range(CLICKHOUSE_NODE_COUNT))


def host_ids() -> list[dict]:
    """Every machine this deployment claims, as `{role, index}` in play order.
    `index` is None for the singletons and the replica ordinal for
    ClickHouse."""
    return [{"role": "neon", "index": None}, {"role": "redis", "index": None},
            *({"role": "clickhouse", "index": i} for i in clickhouse_indexes()),
            {"role": "app", "index": None}]


def host_name(opts: dict, id: dict) -> str:
    return machine_name(opts, id["role"], id.get("index"))


def plan_key(role: str) -> str:
    return f"vultr-plan-{role}"


# ------------------------------------------------------------------ fallback


def vpc_block(opts: dict) -> str:
    """The network address of `vultr-vpc-subnet`, `10.50.0.0/24` -> `10.50.0.0`."""
    value = opts["vultr-vpc-subnet"] if "vultr-vpc-subnet" in opts else "10.50.0.0/24"
    return _s(value).split("/")[0]


def _placeholder_vpc_ip(opts: dict, offset: int) -> str:
    octets = vpc_block(opts).split(".")
    return ".".join([*octets[:3], str(offset)])


# Where each role's placeholder lands inside the subnet on a credential-free
# build. Documentation ranges (RFC 5737 for the public side), fixed so a
# build is byte-identical on every workstation.
_FALLBACK_OFFSETS = {"neon": 10, "redis": 11, "app": 12, "clickhouse": 20}


def fallback_host(opts: dict, id: dict) -> dict:
    role, index = id["role"], id.get("index")
    offset = _FALLBACK_OFFSETS[role] + (index or 0)
    return {"role": role,
            "index": index,
            "name": host_name(opts, id),
            "ip": f"192.0.2.{offset}",
            "vpc-ip": _placeholder_vpc_ip(opts, offset),
            "user": "root",
            "sudoer": "root"}


def fallback_hosts(opts: dict) -> list[dict]:
    return [fallback_host(opts, id) for id in host_ids()]


# --------------------------------------------------------------------- hosts


def _key_of(host: dict) -> tuple:
    index = host.get("index")
    return (host.get("role"), int(index) if index is not None else None)


_UNSET = object()


def hosts(opts: dict, params=_UNSET) -> list[dict]:
    """The host list the Ansible stage, the DNS stage and the acceptance
    consume.

    `params` is the compute stage's `hosts` output. On a build there is none,
    so the fallbacks stand in. On a real run a missing or short list is a
    hard error rather than a silent partial cluster (see
    `missing_host_error`)."""
    if params is _UNSET:
        params = opts.get("langfuse/hosts")
    if not params:
        return fallback_hosts(opts)
    by_key = {_key_of(p): p for p in params}
    result = []
    for id in host_ids():
        p = by_key.get((id["role"], id.get("index")))
        picked = {k: p[k] for k in ("ip", "vpc-ip", "user", "sudoer") if p and k in p}
        result.append({**fallback_host(opts, id), **picked})
    return result


def missing_host_error(opts: dict, params) -> str | None:
    """The error for a compute output that does not cover every machine, or
    that omits an address. Returned rather than raised so the workflow reports
    it the way it reports every other failure."""
    if not params:
        return None
    by_key = {_key_of(p): p for p in params}

    def covered(id: dict) -> bool:
        p = by_key.get((id["role"], id.get("index")))
        return bool(p) and bool(_s(p.get("ip")).strip()) and bool(_s(p.get("vpc-ip")).strip())

    missing = [id for id in host_ids() if not covered(id)]
    if not missing:
        return None
    return ("the compute stage did not report an address for "
            + ", ".join(host_name(opts, id) for id in missing)
            + ". Refusing to render a partial deployment: a ClickHouse cluster "
            "config naming fewer replicas than exist forms no quorum, and an "
            "app environment pointing at a missing address fails only after "
            "the migration timeout.")


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
