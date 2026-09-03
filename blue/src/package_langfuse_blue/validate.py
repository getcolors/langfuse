"""Validation over desired state, the port of io.github.getcolors.langfuse.validate.

Green renders its keys as Clojure keywords, so every message here carries the
same leading colon — the colours must report identical errors for one
colors.yml.
"""

from __future__ import annotations

import re

from blue.cli import par_name
from package_once_blue import ssh as once_ssh
from package_once_blue.validate import providers as once_providers

from . import topology
from .utils import clj_str as _s

profile_par = par_name("profile")

# Every key desired state must carry.
#
# Two deliberate absences carried over from `neon`: `vultr-ssh-keys` selects
# opt-out mode by being present (SSH Keypair Standard), so requiring it would
# make every conforming keygen deployment invalid, and `vultr-name` is the
# Compute Name Standard's optional override. `r2-credential-sharing` is
# likewise optional: its presence is the opt-out.
required = [
    "profile", "workdir", "provider-compute", "provider-dns", "provider-backend",
    "compute-prevent-destroy",
    # application tier
    "langfuse-image", "langfuse-worker-image", "langfuse-host",
    "langfuse-init-org-id", "langfuse-init-org-name",
    "langfuse-init-project-id", "langfuse-init-project-name",
    "langfuse-init-user-email", "langfuse-init-user-name",
    "langfuse-s3-bucket", "langfuse-s3-prefix",
    "langfuse-smoke-traces", "langfuse-smoke-timeout-seconds",
    "caddy-image",
    # cache tier
    "redis-image", "redis-port",
    # analytics tier
    "clickhouse-version", "clickhouse-cluster-name", "clickhouse-nodes",
    "clickhouse-http-port", "clickhouse-native-port", "clickhouse-interserver-port",
    "clickhouse-keeper-port", "clickhouse-raft-port",
    # storage tier — neon's own vocabulary, because this package renders
    # neon's templates rather than copying them (see pyproject.toml)
    "neon-image", "neon-compute-image", "neon-pg-version",
    "neon-tenant-id", "neon-timeline-id",
    "neon-database", "neon-role",
    "neon-r2-bucket", "neon-r2-endpoint", "neon-r2-region", "neon-r2-prefix",
    # backups
    "langfuse-backup-r2-bucket", "langfuse-backup-r2-endpoint", "langfuse-backup-r2-region",
    "langfuse-postgres-backup-oncalendar", "langfuse-clickhouse-backup-oncalendar",
    "langfuse-media-backup-oncalendar", "langfuse-backup-retention-days",
    "langfuse-postgres-backup-max-age-hours", "langfuse-clickhouse-backup-max-age-hours",
    "langfuse-media-backup-max-age-hours",
    # public name and TLS
    "cloudflare-zone", "cloudflare-record-name", "cloudflare-proxied",
    # compute
    "vultr-region", "vultr-os-id", "vultr-vpc-subnet",
    "vultr-plan-neon", "vultr-plan-redis", "vultr-plan-clickhouse", "vultr-plan-app",
    "vultr-ssh-sources", "vultr-http-sources",
    "r2-bucket", "r2-endpoint",
]

image_keys = ["langfuse-image", "langfuse-worker-image", "caddy-image", "redis-image",
              "neon-image", "neon-compute-image"]

image_re = re.compile(r"[^\s:@]+(?:/[^\s:@]+)*(?::[^\s:@]+|@sha256:[0-9a-f]{64}|:[^\s:@]+@sha256:[0-9a-f]{64})")
hex32_re = re.compile(r"[0-9a-f]{32}")
hex64_re = re.compile(r"[0-9a-f]{64}")
ident_re = re.compile(r"[a-z_][a-z0-9_]*")
slug_re = re.compile(r"[a-z0-9][a-z0-9-]*")
url_re = re.compile(r"https://[^\s]+")
host_re = re.compile(r"(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}")
email_re = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
cidr_v4_re = re.compile(r"(\d{1,3}\.){3}\d{1,3}/\d{1,2}")
clickhouse_version_re = re.compile(r"(\d+)\.(\d+)\.\d+\.\d+")
version_tag_re = re.compile(r":([^\s:@/]+)@sha256:")


def missing(value) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def compute_name(opts: dict) -> str:
    return topology.compute_name(opts)


def keygen(opts: dict) -> bool:
    return once_ssh.keygen(opts)


def image_version(value) -> str | None:
    """The human-readable tag out of a `repo:tag@sha256:...` pin, or None."""
    match = version_tag_re.search(_s(value))
    return match.group(1) if match else None


def credential_sharing_accepted(opts: dict) -> bool:
    """Whether desired state explicitly accepts one R2 credential reaching
    OpenTofu state and live data or backups alike."""
    return _s(opts.get("r2-credential-sharing")) == "shared-accepted"


def env_errors(env: dict) -> list[str]:
    if _s(env.get(profile_par)):
        return [f"{profile_par} is set; profile must come from colors.yml only"]
    return []


def _int_like(value) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, str) and re.fullmatch(r"-?\d+", value) is not None


def _as_int(value) -> int | None:
    return int(value) if _int_like(value) else None


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _clickhouse_version_ok(value) -> bool | None:
    """Langfuse v4 requires ClickHouse >= 25.12."""
    match = clickhouse_version_re.fullmatch(_s(value))
    if not match:
        return None
    major, minor = int(match.group(1)), int(match.group(2))
    return major > 25 or (major == 25 and minor >= 12)


def state_errors(opts: dict) -> list[str]:
    errors: list[str] = []
    errors += [f":{k} is required" for k in required if missing(opts.get(k))]

    if opts.get("provider-compute") != "vultr":
        errors.append(":provider-compute must be vultr")
    if opts.get("provider-dns") != "cloudflare":
        errors.append(":provider-dns must be cloudflare")
    if opts.get("provider-backend") not in ("local", "s3", "r2"):
        errors.append(":provider-backend must be local, s3, or r2")
    if not isinstance(opts.get("compute-prevent-destroy"), bool):
        errors.append(":compute-prevent-destroy must be true or false")

    # --- images ------------------------------------------------------------
    for k in image_keys:
        v = opts.get(k)
        if not missing(v) and not image_re.fullmatch(_s(v)):
            errors.append(f":{k} must carry an explicit image tag or digest")
    for k in image_keys:
        if not missing(opts.get(k)) and "@sha256:" not in _s(opts.get(k)):
            errors.append(f":{k} must be pinned by digest (tag@sha256:...)")
    # Web and worker ship together; a mismatched pair runs one schema against
    # another's migrations.
    a = image_version(opts.get("langfuse-image"))
    b = image_version(opts.get("langfuse-worker-image"))
    if a and b and a != b:
        errors.append(f":langfuse-worker-image version {b} must equal :langfuse-image version {a}")

    # --- application tier ---------------------------------------------------
    if not (missing(opts.get("langfuse-host")) or host_re.fullmatch(_s(opts.get("langfuse-host")))):
        errors.append(":langfuse-host must be a fully qualified hostname")
    if not (missing(opts.get("langfuse-init-user-email"))
            or email_re.fullmatch(_s(opts.get("langfuse-init-user-email")))):
        errors.append(":langfuse-init-user-email must be an email address")
    for k in ["langfuse-init-org-id", "langfuse-init-project-id"]:
        v = opts.get(k)
        if not missing(v) and not slug_re.fullmatch(_s(v)):
            errors.append(f":{k} must be a lowercase slug")
    # Langfuse requires a trailing slash on every S3 prefix, and silently
    # concatenates without one.
    if (not missing(opts.get("langfuse-s3-prefix"))
            and not _s(opts.get("langfuse-s3-prefix")).endswith("/")):
        errors.append(":langfuse-s3-prefix must end with a slash")
    n = _as_int(opts.get("langfuse-smoke-traces"))
    if not (missing(opts.get("langfuse-smoke-traces")) or (n is not None and n > 0)):
        errors.append(":langfuse-smoke-traces must be a positive integer")
    n = _as_int(opts.get("langfuse-smoke-timeout-seconds"))
    if not (missing(opts.get("langfuse-smoke-timeout-seconds")) or (n is not None and n > 0)):
        errors.append(":langfuse-smoke-timeout-seconds must be a positive integer")

    # --- cache tier -----------------------------------------------------------
    if not (missing(opts.get("redis-port")) or _int_like(opts.get("redis-port"))):
        errors.append(":redis-port must be a port number")

    # --- analytics tier -------------------------------------------------------
    if (not missing(opts.get("clickhouse-version"))
            and not clickhouse_version_re.fullmatch(_s(opts.get("clickhouse-version")))):
        errors.append(":clickhouse-version must be an exact four-part apt version, e.g. 26.3.29.7")
    if (clickhouse_version_re.fullmatch(_s(opts.get("clickhouse-version")))
            and not _clickhouse_version_ok(opts.get("clickhouse-version"))):
        errors.append(":clickhouse-version must be 25.12 or newer; Langfuse v4 requires it "
                      "for lightweight updates, the JSON type, and full-text search")
    # Langfuse's bundled migrations run ON CLUSTER `default`; any other name
    # means disabling auto-migration and applying them by hand.
    if (not missing(opts.get("clickhouse-cluster-name"))
            and _s(opts.get("clickhouse-cluster-name")) != "default"):
        errors.append(":clickhouse-cluster-name must be default, or Langfuse cannot run its "
                      "ON CLUSTER migrations unaided")
    if (not missing(opts.get("clickhouse-nodes"))
            and _as_int(opts.get("clickhouse-nodes")) != topology.CLICKHOUSE_NODE_COUNT):
        errors.append(f":clickhouse-nodes must be {topology.CLICKHOUSE_NODE_COUNT}"
                      " (one shard, three replicas, three Keeper voters)")
    for k in ["clickhouse-http-port", "clickhouse-native-port", "clickhouse-interserver-port",
              "clickhouse-keeper-port", "clickhouse-raft-port"]:
        if not missing(opts.get(k)) and not _int_like(opts.get(k)):
            errors.append(f":{k} must be a port number")

    # --- storage tier -------------------------------------------------------
    pg_version = opts.get("neon-pg-version")
    if not (missing(pg_version) or (_is_int(pg_version) and pg_version in (14, 15, 16, 17))):
        errors.append(":neon-pg-version must be 14, 15, 16, or 17")
    for k in ["neon-tenant-id", "neon-timeline-id"]:
        v = opts.get(k)
        if not missing(v) and not hex32_re.fullmatch(_s(v)):
            errors.append(f":{k} must be 32 lowercase hex characters")
    for k in ["neon-database", "neon-role"]:
        v = opts.get(k)
        if not missing(v) and not ident_re.fullmatch(_s(v)):
            errors.append(f":{k} must be a lowercase identifier")
    if _s(opts.get("neon-role")) == "cloud_admin":
        errors.append(":neon-role must not be cloud_admin")
    for k in ["neon-r2-endpoint", "langfuse-backup-r2-endpoint", "r2-endpoint"]:
        if not missing(opts.get(k)) and not url_re.fullmatch(_s(opts.get(k))):
            errors.append(f":{k} must be an https URL")

    # --- buckets ---------------------------------------------------------------
    # Live data and OpenTofu state must not share a bucket: one lifecycle
    # mistake would take out both. Backups must share a bucket with neither.
    for k in ["neon-r2-bucket", "langfuse-s3-bucket"]:
        if not missing(opts.get(k)) and _s(opts.get(k)) == _s(opts.get("r2-bucket")):
            errors.append(f":{k} must not be the OpenTofu state bucket")
    if (not missing(opts.get("langfuse-backup-r2-bucket"))
            and _s(opts.get("langfuse-backup-r2-bucket"))
            in {_s(opts.get("r2-bucket")), _s(opts.get("neon-r2-bucket")),
                _s(opts.get("langfuse-s3-bucket"))}):
        errors.append(":langfuse-backup-r2-bucket must not be the state or a live-data bucket")

    # --- backups ----------------------------------------------------------------
    for k in ["langfuse-backup-retention-days", "langfuse-postgres-backup-max-age-hours",
              "langfuse-clickhouse-backup-max-age-hours", "langfuse-media-backup-max-age-hours"]:
        n = _as_int(opts.get(k))
        if not missing(opts.get(k)) and not (n is not None and n > 0):
            errors.append(f":{k} must be a positive integer")

    # --- network ----------------------------------------------------------------
    if (not missing(opts.get("vultr-vpc-subnet"))
            and not cidr_v4_re.fullmatch(_s(opts.get("vultr-vpc-subnet")))):
        errors.append(":vultr-vpc-subnet must be an IPv4 CIDR, e.g. 10.50.0.0/24")
    # Restricting the origin to Cloudflare's ranges and NOT proxying the
    # record are mutually exclusive, and the failure is silent until the
    # certificate is needed: Caddy answers the ACME HTTP-01 challenge on :80,
    # and with the record unproxied that challenge arrives from Let's
    # Encrypt's own addresses, which the firewall drops.
    if (_s(opts.get("vultr-http-sources")) == "cloudflare"
            and opts.get("cloudflare-proxied") is not True):
        errors.append(":vultr-http-sources cloudflare requires :cloudflare-proxied true, "
                      "or ACME HTTP-01 is firewalled off and no certificate is ever issued")
    if not (missing(opts.get("r2-credential-sharing"))
            or _s(opts.get("r2-credential-sharing")) in ("split", "shared-accepted")):
        errors.append(":r2-credential-sharing must be split or shared-accepted")
    if not (missing(opts.get("vultr-os-id")) or _is_int(opts.get("vultr-os-id"))):
        errors.append(":vultr-os-id must be Vultr's numeric operating-system id")
    return errors


def backend_secrets(opts: dict) -> list[str]:
    entry = once_providers["provider-backend"].get(str(opts.get("provider-backend")), {})
    return entry.get("secrets", [])


# What talking to the providers needs, on any real event.
provider_secrets = ["vultr-api-key", "cloudflare-api-token"]

# The two pairs that reach hosts on a create. `neon-r2-*` is what the
# getcolors/neon play reads for the storage tier; `langfuse-storage-r2-*` is
# what the app host uses for events and media. The deployment's `.envrc` maps
# one onto the other when they are the same token.
storage_secrets = [
    "neon-r2-access-key-id", "neon-r2-secret-access-key",
    "langfuse-storage-r2-access-key-id", "langfuse-storage-r2-secret-access-key",
    "langfuse-backup-r2-access-key-id", "langfuse-backup-r2-secret-access-key",
]

# Operator-held on purpose. A host-generated secret that no backup carries
# dies with the app host and takes every encrypted row with it; the init
# password is what logs an operator in after that host is rebuilt.
application_secrets = ["langfuse-encryption-key", "langfuse-salt", "langfuse-init-user-password"]


def _same_pair(opts: dict, a: str, b: str) -> bool:
    return not missing(opts.get(a)) and _s(opts.get(a)) == _s(opts.get(b))


def secret_errors(opts: dict, event: str) -> list[str]:
    """Credentials a real event needs. A delete tears down infrastructure and
    never converges anything, so it asks for the provider credentials only."""
    create = event == "create"
    keys = [*provider_secrets,
            *((storage_secrets + application_secrets) if create else []),
            *backend_secrets(opts)]
    errors = [f"required credential is not set: {par_name(k)}"
              for k in dict.fromkeys(keys) if missing(opts.get(k))]
    # Blast radius, enforced rather than merely observed. The shared pair
    # stays reachable, but only as a deliberate, committed choice.
    if create and not credential_sharing_accepted(opts):
        for label, k in [("live Neon data", "neon-r2-access-key-id"),
                         ("Langfuse events and media", "langfuse-storage-r2-access-key-id"),
                         ("backups", "langfuse-backup-r2-access-key-id")]:
            if _same_pair(opts, k, "r2-access-key-id"):
                errors.append(
                    f"{label} would use the same R2 credential as OpenTofu state. Supply "
                    f"{par_name(k)} scoped to its own bucket, or set "
                    ":r2-credential-sharing: shared-accepted in colors.yml to record "
                    "that the blast radius is accepted")
    if (create and not credential_sharing_accepted(opts)
            and _same_pair(opts, "langfuse-backup-r2-access-key-id",
                           "langfuse-storage-r2-access-key-id")):
        errors.append(
            "backups would use the same R2 credential as live data. A backup a "
            "compromised host can erase is not a backup; supply "
            f"{par_name('langfuse-backup-r2-access-key-id')}"
            " scoped to the backup bucket alone, or set "
            ":r2-credential-sharing: shared-accepted in colors.yml")
    if (create and not missing(opts.get("langfuse-encryption-key"))
            and not hex64_re.fullmatch(_s(opts.get("langfuse-encryption-key")))):
        errors.append(f"{par_name('langfuse-encryption-key')}"
                      " must be 64 lowercase hex characters (openssl rand -hex 32)")
    if (create and not missing(opts.get("langfuse-salt"))
            and len(_s(opts.get("langfuse-salt"))) < 32):
        errors.append(f"{par_name('langfuse-salt')} must be at least 32 characters")
    if (create and not missing(opts.get("langfuse-init-user-password"))
            and len(_s(opts.get("langfuse-init-user-password"))) < 12):
        errors.append(f"{par_name('langfuse-init-user-password')} must be at least 12 characters")
    return errors


def tofu_env(opts: dict, slot: str) -> dict[str, str]:
    if slot == "provider-compute":
        return {"vultr-api-key": "VULTR_API_KEY"}
    if slot == "provider-dns":
        return {"cloudflare-api-token": "CLOUDFLARE_API_TOKEN"}
    if slot == "provider-backend":
        entry = once_providers["provider-backend"].get(str(opts.get("provider-backend")), {})
        return entry.get("tofu-env", {})
    return {}
