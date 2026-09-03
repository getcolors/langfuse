// Regression tests for the rules a fresh colors.yml gets wrong. Each test
// names the failure it prevents — the port of validate_test.clj.
import { describe, expect, test } from "bun:test";
import { parName } from "red/cli";
import type { Opts } from "red/workflow";
import * as v from "../src/validate.ts";

// A minimal valid desired state, kept complete on purpose: `stateErrors`
// reports every problem at once, so a fixture missing keys would make every
// test read as a pass-by-accident.
const base: Opts = {
  profile: "langfuse-test", workdir: ".colors",
  "provider-compute": "vultr", "provider-dns": "cloudflare", "provider-backend": "r2",
  "compute-prevent-destroy": true,
  "langfuse-image": "docker.langfuse.com/langfuse/langfuse:4.27.0@sha256:c9e2cab8469a5d7353e86a3252b02c52ac94ef31288ce2639ee01aabf5e4222b",
  "langfuse-worker-image": "docker.langfuse.com/langfuse/langfuse-worker:4.27.0@sha256:091a85c3c54bf5fff7cc0073a7f35a52861cc0e30d33dd05569fe3ed66b15d8d",
  "langfuse-host": "langfuse.example.com",
  "langfuse-init-org-id": "org", "langfuse-init-org-name": "Org",
  "langfuse-init-project-id": "project", "langfuse-init-project-name": "Project",
  "langfuse-init-user-email": "operator@example.com", "langfuse-init-user-name": "Operator",
  "langfuse-s3-bucket": "langfuse-storage", "langfuse-s3-prefix": "langfuse-test/",
  "langfuse-smoke-traces": 200, "langfuse-smoke-timeout-seconds": 120,
  "caddy-image": "docker.io/library/caddy:2.11.4@sha256:df7f1c2fb114453b951de51a98efc010db1655a92c2e86be6706714e2417a78d",
  "redis-image": "docker.io/library/redis:7.2.16@sha256:74566c6910d13ae61e7ce73ebd3127438a1fe805b309b097c323142719ec8a5b",
  "redis-port": 6379,
  "clickhouse-version": "26.3.29.7", "clickhouse-cluster-name": "default", "clickhouse-nodes": 3,
  "clickhouse-http-port": 8123, "clickhouse-native-port": 9000, "clickhouse-interserver-port": 9009,
  "clickhouse-keeper-port": 9181, "clickhouse-raft-port": 9234,
  "neon-image": "ghcr.io/neondatabase/neon:release-9129@sha256:166022a72bf9983eba96d061d794f4740edbd4c3301e66202c1180acce9a323c",
  "neon-compute-image": "ghcr.io/neondatabase/compute-node-v17:release-compute-9073@sha256:ed6a613231d7026b4df8b00563444b9f33745370a3b3f0a2183e723f460ba974",
  "neon-pg-version": 17,
  "neon-tenant-id": "7b3c1e94a05d42f8b6c9e2417d580a3f", "neon-timeline-id": "4f8a2d61c93b47e0a5d8f1620b7c94e3",
  "neon-database": "langfuse", "neon-role": "langfuse",
  "neon-r2-bucket": "langfuse-storage", "neon-r2-endpoint": "https://example.r2.cloudflarestorage.com",
  "neon-r2-region": "auto", "neon-r2-prefix": "langfuse-test/neon",
  "langfuse-backup-r2-bucket": "langfuse-backup", "langfuse-backup-r2-endpoint": "https://example.r2.cloudflarestorage.com",
  "langfuse-backup-r2-region": "auto",
  "langfuse-postgres-backup-oncalendar": "*-*-* 00/6:00:00", "langfuse-clickhouse-backup-oncalendar": "*-*-* 02:30:00",
  "langfuse-media-backup-oncalendar": "*-*-* 03:30:00", "langfuse-backup-retention-days": 7,
  "langfuse-postgres-backup-max-age-hours": 8, "langfuse-clickhouse-backup-max-age-hours": 30,
  "langfuse-media-backup-max-age-hours": 30,
  "cloudflare-zone": "example.com", "cloudflare-record-name": "langfuse", "cloudflare-proxied": true,
  "vultr-region": "ams", "vultr-os-id": 2284, "vultr-vpc-subnet": "10.50.0.0/24",
  "vultr-plan-neon": "vc2-4c-8gb", "vultr-plan-redis": "vc2-1c-2gb",
  "vultr-plan-clickhouse": "vc2-4c-8gb", "vultr-plan-app": "vc2-4c-8gb",
  "vultr-ssh-sources": ["0.0.0.0/0"], "vultr-http-sources": "cloudflare",
  "r2-bucket": "tofu-state-example", "r2-endpoint": "https://example.r2.cloudflarestorage.com",
};

const creds: Opts = {
  "vultr-api-key": "v", "cloudflare-api-token": "c",
  "r2-access-key-id": "state", "r2-secret-access-key": "state-secret",
  "neon-r2-access-key-id": "store", "neon-r2-secret-access-key": "store-secret",
  "langfuse-storage-r2-access-key-id": "store", "langfuse-storage-r2-secret-access-key": "store-secret",
  "langfuse-backup-r2-access-key-id": "backup", "langfuse-backup-r2-secret-access-key": "backup-secret",
  "langfuse-encryption-key": "a".repeat(64),
  "langfuse-salt": "s".repeat(32),
  "langfuse-init-user-password": "twelve-chars!",
};

const errs = (m: Opts = {}) => v.stateErrors({ ...base, ...m });
const has = (m: Opts, needle: string) => errs(m).some((e) => new RegExp(needle).test(e));
const secretErrs = (m: Opts = {}) => v.secretErrors({ ...base, ...creds, ...m }, "create");
const secretHas = (m: Opts, needle: string) => secretErrs(m).some((e) => new RegExp(needle).test(e));

describe("validate", () => {
  test("a complete desired state validates", () => {
    expect(errs()).toEqual([]);
  });

  test("reports every problem at once", () => {
    expect(errs({ "neon-pg-version": 12, "redis-port": null, "vultr-os-id": "x" }).length)
      .toBeGreaterThanOrEqual(3);
  });

  // --- version rules ----------------------------------------------------------

  test("clickhouse must be new enough for langfuse v4", () => {
    // v4 requires >= 25.12; a 24.x or 25.8 pin converges and then fails the
    // first migration.
    expect(has({ "clickhouse-version": "24.3.10.1" }, "25.12 or newer")).toBe(true);
    expect(has({ "clickhouse-version": "25.8.1.1" }, "25.12 or newer")).toBe(true);
    expect(errs({ "clickhouse-version": "25.12.1.1" })).toEqual([]);
    expect(errs({ "clickhouse-version": "26.8.2.7" })).toEqual([]);
  });

  test("clickhouse version must be an exact apt version", () => {
    expect(has({ "clickhouse-version": "26.3" }, "four-part apt version")).toBe(true);
    expect(has({ "clickhouse-version": "latest" }, "four-part apt version")).toBe(true);
  });

  test("the cluster must be named default", () => {
    // Langfuse's bundled migrations run ON CLUSTER default.
    expect(has({ "clickhouse-cluster-name": "langfuse" }, "must be default")).toBe(true);
  });

  test("exactly three clickhouse nodes", () => {
    expect(has({ "clickhouse-nodes": 1 }, "must be 3")).toBe(true);
    expect(has({ "clickhouse-nodes": 5 }, "must be 3")).toBe(true);
  });

  test("web and worker versions must match", () => {
    expect(has({ "langfuse-worker-image": "docker.langfuse.com/langfuse/langfuse-worker:4.26.0@sha256:091a85c3c54bf5fff7cc0073a7f35a52861cc0e30d33dd05569fe3ed66b15d8d" },
      "must equal")).toBe(true);
  });

  test("images must be digest pinned", () => {
    expect(has({ "langfuse-image": "docker.langfuse.com/langfuse/langfuse:4.27.0" }, "pinned by digest")).toBe(true);
    expect(has({ "redis-image": "docker.io/library/redis:7.2.16" }, "pinned by digest")).toBe(true);
  });

  // --- the coupling that only fails later -------------------------------------

  test("cloudflare-only ingress requires a proxied record", () => {
    expect(has({ "cloudflare-proxied": false }, "ACME HTTP-01")).toBe(true);
    expect(errs({ "vultr-http-sources": ["1.2.3.0/24"], "cloudflare-proxied": false })).toEqual([]);
  });

  test("s3 prefix must end with a slash", () => {
    // Langfuse concatenates the prefix without one.
    expect(has({ "langfuse-s3-prefix": "langfuse-test" }, "end with a slash")).toBe(true);
  });

  // --- blast radius -------------------------------------------------------------

  test("live data must not share a bucket with tofu state", () => {
    expect(has({ "neon-r2-bucket": "tofu-state-example" }, "must not be the OpenTofu state bucket")).toBe(true);
    expect(has({ "langfuse-s3-bucket": "tofu-state-example" }, "must not be the OpenTofu state bucket")).toBe(true);
  });

  test("backups must not share a bucket with state or live data", () => {
    expect(has({ "langfuse-backup-r2-bucket": "tofu-state-example" }, "must not be the state or a live-data bucket")).toBe(true);
    expect(has({ "langfuse-backup-r2-bucket": "langfuse-storage" }, "must not be the state or a live-data bucket")).toBe(true);
  });

  test("sharing one r2 credential must be a deliberate choice", () => {
    // The storage pair equal to the state pair is refused.
    expect(secretHas({ "neon-r2-access-key-id": "state", "neon-r2-secret-access-key": "state-secret" },
      "same R2 credential as OpenTofu state")).toBe(true);
    // The backup pair equal to the storage pair is refused.
    expect(secretHas({ "langfuse-backup-r2-access-key-id": "store", "langfuse-backup-r2-secret-access-key": "store-secret" },
      "same R2 credential as live data")).toBe(true);
    // Scoped pairs satisfy it with no opt-out.
    expect(secretErrs()).toEqual([]);
    // The shared pair is reachable only as a recorded, committed choice.
    expect(secretErrs({ "r2-credential-sharing": "shared-accepted",
      "neon-r2-access-key-id": "state", "neon-r2-secret-access-key": "state-secret" })).toEqual([]);
    expect(has({ "r2-credential-sharing": "yes-whatever" }, "must be split or shared-accepted")).toBe(true);
  });

  // --- operator-held application secrets ----------------------------------------

  test("the encryption key must be 64 hex", () => {
    expect(secretHas({ "langfuse-encryption-key": "short" }, "64 lowercase hex")).toBe(true);
    expect(secretHas({ "langfuse-encryption-key": "z".repeat(64) }, "64 lowercase hex")).toBe(true);
  });

  test("the salt and init password have floors", () => {
    expect(secretHas({ "langfuse-salt": "short" }, "at least 32 characters")).toBe(true);
    expect(secretHas({ "langfuse-init-user-password": "short" }, "at least 12 characters")).toBe(true);
  });

  test("every operator credential is required on create", () => {
    for (const key of ["langfuse-encryption-key", "langfuse-salt", "langfuse-init-user-password",
      "langfuse-backup-r2-access-key-id", "langfuse-storage-r2-access-key-id",
      "neon-r2-access-key-id", "cloudflare-api-token", "vultr-api-key"]) {
      expect(secretErrs({ [key]: null }).some((e) => e.includes(parName(key)))).toBe(true);
    }
  });

  test("a delete needs only the provider credentials", () => {
    expect(v.secretErrors({ ...base, "vultr-api-key": "v", "cloudflare-api-token": "c",
      "r2-access-key-id": "a", "r2-secret-access-key": "b" }, "delete")).toEqual([]);
  });

  // --- storage tier identity ------------------------------------------------------

  test("tenant and timeline are fixed desired state", () => {
    for (const key of ["neon-tenant-id", "neon-timeline-id"]) {
      expect(has({ [key]: "not-hex" }, "32 lowercase hex")).toBe(true);
    }
  });

  test("the application role must not be cloud_admin", () => {
    expect(has({ "neon-role": "cloud_admin" }, "must not be cloud_admin")).toBe(true);
  });

  test("the vpc subnet must be a cidr", () => {
    expect(has({ "vultr-vpc-subnet": "10.50.0.0" }, "IPv4 CIDR")).toBe(true);
  });

  test("profile may not be overlaid from the environment", () => {
    expect(v.envErrors({ [v.profilePar]: "somewhere-else" }).length).toBeGreaterThan(0);
    expect(v.envErrors({})).toEqual([]);
  });
});
