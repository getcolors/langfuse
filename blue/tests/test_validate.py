"""Regression tests for the rules a fresh colors.yml gets wrong. Each test
names the failure it prevents."""

from __future__ import annotations

import re

from blue.cli import par_name
from conftest import fixture, optout

from package_langfuse_blue import validate as v

# A minimal valid desired state, kept complete on purpose: `state_errors`
# reports every problem at once, so a fixture missing keys would make every
# test read as a pass-by-accident. The committed fixture is that state, on the
# r2 backend so the state-bucket rules have something to collide with.
STATE_BUCKET = "tofu-state-example"
base = fixture({"provider-backend": "r2", "r2-bucket": STATE_BUCKET,
                "neon-r2-bucket": "langfuse-storage", "langfuse-s3-bucket": "langfuse-storage",
                "langfuse-backup-r2-bucket": "langfuse-backup"})

creds = {
    "vultr-api-key": "v", "cloudflare-api-token": "c",
    "r2-access-key-id": "state", "r2-secret-access-key": "state-secret",
    "neon-r2-access-key-id": "store", "neon-r2-secret-access-key": "store-secret",
    "langfuse-storage-r2-access-key-id": "store",
    "langfuse-storage-r2-secret-access-key": "store-secret",
    "langfuse-backup-r2-access-key-id": "backup",
    "langfuse-backup-r2-secret-access-key": "backup-secret",
    "langfuse-encryption-key": "a" * 64,
    "langfuse-salt": "s" * 32,
    "langfuse-init-user-password": "twelve-chars!",
}


def errs(overrides: dict | None = None) -> list[str]:
    return v.state_errors({**base, **(overrides or {})})


def has(overrides: dict, needle: str) -> bool:
    return any(re.search(needle, e) for e in errs(overrides))


def secret_errs(overrides: dict | None = None) -> list[str]:
    return v.secret_errors({**base, **creds, **(overrides or {})}, "create")


def secret_has(overrides: dict, needle: str) -> bool:
    return any(re.search(needle, e) for e in secret_errs(overrides))


def test_a_complete_desired_state_validates():
    assert errs() == []
    assert v.state_errors(fixture()) == []
    assert v.state_errors(optout()) == []


def test_reports_every_problem_at_once():
    assert len(errs({"neon-pg-version": 12, "redis-port": None, "vultr-os-id": "x"})) >= 3


# --- version rules ------------------------------------------------------------


def test_clickhouse_must_be_new_enough_for_langfuse_v4():
    # v4 requires >= 25.12; a 24.x or 25.8 pin converges and then fails the
    # first migration.
    assert has({"clickhouse-version": "24.3.10.1"}, "25.12 or newer")
    assert has({"clickhouse-version": "25.8.1.1"}, "25.12 or newer")
    assert errs({"clickhouse-version": "25.12.1.1"}) == []
    assert errs({"clickhouse-version": "26.8.2.7"}) == []


def test_clickhouse_version_must_be_an_exact_apt_version():
    assert has({"clickhouse-version": "26.3"}, "four-part apt version")
    assert has({"clickhouse-version": "latest"}, "four-part apt version")


def test_the_cluster_must_be_named_default():
    # Langfuse's bundled migrations run ON CLUSTER default.
    assert has({"clickhouse-cluster-name": "langfuse"}, "must be default")


def test_exactly_three_clickhouse_nodes():
    assert has({"clickhouse-nodes": 1}, "must be 3")
    assert has({"clickhouse-nodes": 5}, "must be 3")


def test_web_and_worker_versions_must_match():
    assert has({"langfuse-worker-image": "docker.langfuse.com/langfuse/langfuse-worker:4.26.0@sha256:"
                "091a85c3c54bf5fff7cc0073a7f35a52861cc0e30d33dd05569fe3ed66b15d8d"},
               "must equal")


def test_images_must_be_digest_pinned():
    assert has({"langfuse-image": "docker.langfuse.com/langfuse/langfuse:4.27.0"}, "pinned by digest")
    assert has({"redis-image": "docker.io/library/redis:7.2.16"}, "pinned by digest")


# --- the coupling that only fails later ---------------------------------------


def test_cloudflare_only_ingress_requires_a_proxied_record():
    assert has({"cloudflare-proxied": False}, "ACME HTTP-01")
    assert errs({"vultr-http-sources": ["1.2.3.0/24"], "cloudflare-proxied": False}) == []


def test_s3_prefix_must_end_with_a_slash():
    # Langfuse concatenates the prefix without one.
    assert has({"langfuse-s3-prefix": "langfuse-test"}, "end with a slash")


# --- blast radius ---------------------------------------------------------------


def test_live_data_must_not_share_a_bucket_with_tofu_state():
    assert has({"neon-r2-bucket": STATE_BUCKET}, "must not be the OpenTofu state bucket")
    assert has({"langfuse-s3-bucket": STATE_BUCKET}, "must not be the OpenTofu state bucket")


def test_backups_must_not_share_a_bucket_with_state_or_live_data():
    assert has({"langfuse-backup-r2-bucket": STATE_BUCKET},
               "must not be the state or a live-data bucket")
    assert has({"langfuse-backup-r2-bucket": "langfuse-storage"},
               "must not be the state or a live-data bucket")


def test_sharing_one_r2_credential_must_be_a_deliberate_choice():
    # The storage pair equal to the state pair is refused.
    assert secret_has({"neon-r2-access-key-id": "state", "neon-r2-secret-access-key": "state-secret"},
                      "same R2 credential as OpenTofu state")
    # The backup pair equal to the storage pair is refused.
    assert secret_has({"langfuse-backup-r2-access-key-id": "store",
                       "langfuse-backup-r2-secret-access-key": "store-secret"},
                      "same R2 credential as live data")
    # Scoped pairs satisfy it with no opt-out.
    assert secret_errs() == []
    # The shared pair is reachable only as a recorded, committed choice.
    assert secret_errs({"r2-credential-sharing": "shared-accepted",
                        "neon-r2-access-key-id": "state",
                        "neon-r2-secret-access-key": "state-secret"}) == []
    assert has({"r2-credential-sharing": "yes-whatever"}, "must be split or shared-accepted")


# --- operator-held application secrets ------------------------------------------


def test_the_encryption_key_must_be_64_hex():
    assert secret_has({"langfuse-encryption-key": "short"}, "64 lowercase hex")
    assert secret_has({"langfuse-encryption-key": "z" * 64}, "64 lowercase hex")


def test_the_salt_and_init_password_have_floors():
    assert secret_has({"langfuse-salt": "short"}, "at least 32 characters")
    assert secret_has({"langfuse-init-user-password": "short"}, "at least 12 characters")


def test_every_operator_credential_is_required_on_create():
    for k in ["langfuse-encryption-key", "langfuse-salt", "langfuse-init-user-password",
              "langfuse-backup-r2-access-key-id", "langfuse-storage-r2-access-key-id",
              "neon-r2-access-key-id", "cloudflare-api-token", "vultr-api-key"]:
        assert any(re.search(par_name(k), e) for e in secret_errs({k: None})), \
            f"{k} should be required"


def test_a_delete_needs_only_the_provider_credentials():
    assert v.secret_errors({**base, "vultr-api-key": "v", "cloudflare-api-token": "c",
                            "r2-access-key-id": "a", "r2-secret-access-key": "b"},
                           "delete") == []


# --- storage tier identity --------------------------------------------------------


def test_tenant_and_timeline_are_fixed_desired_state():
    for k in ["neon-tenant-id", "neon-timeline-id"]:
        assert has({k: "not-hex"}, "32 lowercase hex")


def test_the_application_role_must_not_be_cloud_admin():
    assert has({"neon-role": "cloud_admin"}, "must not be cloud_admin")


def test_the_vpc_subnet_must_be_a_cidr():
    assert has({"vultr-vpc-subnet": "10.50.0.0"}, "IPv4 CIDR")


def test_profile_may_not_be_overlaid_from_the_environment():
    assert v.env_errors({v.profile_par: "somewhere-else"})
    assert v.env_errors({}) == []
