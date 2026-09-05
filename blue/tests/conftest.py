from pathlib import Path

from blue.cli import load_yaml

ROOT = Path(__file__).resolve().parents[2]

# The compute stage's recorded `params`, as ONCE reads it: snake_case node
# keys, every field present, a 0-based index on every node — the shape the
# template outputs since adoption.
PARAMS = {
    "provider": "vultr",
    "ssh_key_id": "7692e92a",
    "nodes": [
        {"role": "neon", "index": 0, "name": "langfuse-test-neon", "ip": "1.1.1.1",
         "vpc_ip": "10.50.0.2", "user": "root", "sudoer": "root"},
        {"role": "redis", "index": 0, "name": "langfuse-test-redis", "ip": "1.1.1.2",
         "vpc_ip": "10.50.0.3", "user": "root", "sudoer": "root"},
        {"role": "clickhouse", "index": 0, "name": "langfuse-test-clickhouse-0", "ip": "1.1.1.3",
         "vpc_ip": "10.50.0.4", "user": "root", "sudoer": "root"},
        {"role": "clickhouse", "index": 1, "name": "langfuse-test-clickhouse-1", "ip": "1.1.1.4",
         "vpc_ip": "10.50.0.5", "user": "root", "sudoer": "root"},
        {"role": "clickhouse", "index": 2, "name": "langfuse-test-clickhouse-2", "ip": "1.1.1.5",
         "vpc_ip": "10.50.0.6", "user": "root", "sudoer": "root"},
        {"role": "app", "index": 0, "name": "langfuse-test-app", "ip": "1.1.1.6",
         "vpc_ip": "10.50.0.7", "user": "root", "sudoer": "root"},
    ],
}

# The shape `langfuse-vultr` recorded before adoption, as `tofu output -json`
# delivers it to the reader: `hosts` rather than `nodes`, `index: null` on the
# four singletons, no `provider`.
LEGACY_RAW = {
    "ssh_key_id": "7692e92a",
    "hosts": [
        {"role": "neon", "index": None, "name": "langfuse-vultr-neon", "ip": "203.0.113.1",
         "vpc_ip": "10.50.0.3", "user": "root", "sudoer": "root"},
        {"role": "redis", "index": None, "name": "langfuse-vultr-redis", "ip": "203.0.113.2",
         "vpc_ip": "10.50.0.4", "user": "root", "sudoer": "root"},
        {"role": "clickhouse", "index": 0, "name": "langfuse-vultr-clickhouse-0", "ip": "203.0.113.3",
         "vpc_ip": "10.50.0.5", "user": "root", "sudoer": "root"},
        {"role": "clickhouse", "index": 1, "name": "langfuse-vultr-clickhouse-1", "ip": "203.0.113.4",
         "vpc_ip": "10.50.0.6", "user": "root", "sudoer": "root"},
        {"role": "clickhouse", "index": 2, "name": "langfuse-vultr-clickhouse-2", "ip": "203.0.113.5",
         "vpc_ip": "10.50.0.7", "user": "root", "sudoer": "root"},
        {"role": "app", "index": None, "name": "langfuse-vultr-app", "ip": "203.0.113.6",
         "vpc_ip": "10.50.0.8", "user": "root", "sudoer": "root"},
    ],
}

LEGACY_TRANSLATED = {
    "ssh_key_id": "7692e92a",
    "provider": "vultr",
    "nodes": [{**h, "index": 0 if h["index"] is None else h["index"]} for h in LEGACY_RAW["hosts"]],
}


def _load(name: str, overrides: dict | None = None) -> dict:
    text = (ROOT / "test" / "fixtures" / name).read_text().replace("WORKDIR", ".colors")
    return {**load_yaml(text), **(overrides or {})}


def fixture(overrides: dict | None = None) -> dict:
    return _load("colors.yml", overrides)


def optout(overrides: dict | None = None) -> dict:
    return _load("optout.yml", overrides)
