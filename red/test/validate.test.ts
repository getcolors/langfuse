// Regression tests for the rules a fresh colors.yml gets wrong. Each test
// names the failure it prevents — the port of validate_test.clj.
import { describe, expect, test } from "bun:test";
import { parName } from "red/cli";
import type { Opts } from "red/workflow";
import * as v from "../src/validate.ts";
import { base, creds } from "./support.ts";

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

  test("the compute checks are the cluster standard's", () => {
    // Selection, the SSH source list, the created network's CIDR and the
    // provider rules are ONCE's over the spec, in ONCE's words. The package's
    // own rules — three replicas, the cloudflare/proxied coupling — still
    // apply beside them, and `vultr-http-sources` stays the package's: it is
    // not one of the spec's source lists because it accepts the symbolic
    // `cloudflare`.
    expect(errs({ "provider-compute": "digitalocean" })).toEqual([":provider-compute must be one of vultr"]);
    expect(errs({ "vultr-ssh-sources": [] })).toEqual([":vultr-ssh-sources must list at least one CIDR"]);
    expect(errs({ "vultr-ssh-sources": ["1.2.3.4"] }))
      .toEqual([':vultr-ssh-sources entry "1.2.3.4" is not an IPv4 or IPv6 CIDR']);
    // The VPC must be a network, host bits zero.
    expect(errs({ "vultr-vpc-subnet": "10.50.0.0" }))
      .toEqual([":vultr-vpc-subnet must be a canonical IPv4 network such as 10.40.0.0/24"]);
    expect(errs({ "vultr-vpc-subnet": "10.50.0.1/24" }))
      .toEqual([":vultr-vpc-subnet must be a canonical IPv4 network such as 10.40.0.0/24"]);
    // The six fallback addresses must fit the subnet.
    expect(errs({ "vultr-vpc-subnet": "10.50.0.0/28" }))
      .toEqual([":vultr-vpc-subnet has no usable host address for clickhouse-0, clickhouse-1, clickhouse-2"]);
    // The compute keys are required through the registry, once each.
    expect(errs({ "vultr-plan-app": null })).toEqual([":vultr-plan-app is required"]);
    expect(errs({ "vultr-os-id": "x" })).toEqual([":vultr-os-id must be Vultr's numeric operating-system id"]);
    // An explicit http source list is not held to ONCE's grammar here.
    expect(errs({ "vultr-http-sources": ["1.2.3.0/24"], "cloudflare-proxied": false })).toEqual([]);
  });

  test("profile may not be overlaid from the environment", () => {
    expect(v.envErrors({ [v.profilePar]: "somewhere-else" }).length).toBeGreaterThan(0);
    expect(v.envErrors({})).toEqual([]);
  });
});
