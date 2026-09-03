import { parName } from "red/cli";
import type { Opts } from "red/workflow";
import { providers } from "package-once-red";
import { onceSsh } from "./once.ts";
import * as topology from "./topology.ts";

export const profilePar = parName("profile");

// Every key desired state must carry.
//
// Two deliberate absences carried over from `neon`: `vultr-ssh-keys` selects
// opt-out mode by being present (SSH Keypair Standard), so requiring it would
// make every conforming keygen deployment invalid, and `vultr-name` is the
// Compute Name Standard's optional override. `r2-credential-sharing` is
// likewise optional: its presence is the opt-out.
export const required = [
  "profile", "workdir", "provider-compute", "provider-dns", "provider-backend",
  "compute-prevent-destroy",
  // application tier
  "langfuse-image", "langfuse-worker-image", "langfuse-host",
  "langfuse-init-org-id", "langfuse-init-org-name",
  "langfuse-init-project-id", "langfuse-init-project-name",
  "langfuse-init-user-email", "langfuse-init-user-name",
  "langfuse-s3-bucket", "langfuse-s3-prefix",
  "langfuse-smoke-traces", "langfuse-smoke-timeout-seconds",
  "caddy-image",
  // cache tier
  "redis-image", "redis-port",
  // analytics tier
  "clickhouse-version", "clickhouse-cluster-name", "clickhouse-nodes",
  "clickhouse-http-port", "clickhouse-native-port", "clickhouse-interserver-port",
  "clickhouse-keeper-port", "clickhouse-raft-port",
  // storage tier — neon's own vocabulary, because this package renders
  // neon's templates rather than copying them (see neon.ts)
  "neon-image", "neon-compute-image", "neon-pg-version",
  "neon-tenant-id", "neon-timeline-id",
  "neon-database", "neon-role",
  "neon-r2-bucket", "neon-r2-endpoint", "neon-r2-region", "neon-r2-prefix",
  // backups
  "langfuse-backup-r2-bucket", "langfuse-backup-r2-endpoint", "langfuse-backup-r2-region",
  "langfuse-postgres-backup-oncalendar", "langfuse-clickhouse-backup-oncalendar",
  "langfuse-media-backup-oncalendar", "langfuse-backup-retention-days",
  "langfuse-postgres-backup-max-age-hours", "langfuse-clickhouse-backup-max-age-hours",
  "langfuse-media-backup-max-age-hours",
  // public name and TLS
  "cloudflare-zone", "cloudflare-record-name", "cloudflare-proxied",
  // compute
  "vultr-region", "vultr-os-id", "vultr-vpc-subnet",
  "vultr-plan-neon", "vultr-plan-redis", "vultr-plan-clickhouse", "vultr-plan-app",
  "vultr-ssh-sources", "vultr-http-sources",
  "r2-bucket", "r2-endpoint",
];

export const imageKeys = ["langfuse-image", "langfuse-worker-image", "caddy-image", "redis-image",
  "neon-image", "neon-compute-image"];

const imageRe = /^[^\s:@]+(?:\/[^\s:@]+)*(?::[^\s:@]+|@sha256:[0-9a-f]{64}|:[^\s:@]+@sha256:[0-9a-f]{64})$/;
const hex32Re = /^[0-9a-f]{32}$/;
const hex64Re = /^[0-9a-f]{64}$/;
const identRe = /^[a-z_][a-z0-9_]*$/;
const slugRe = /^[a-z0-9][a-z0-9-]*$/;
const urlRe = /^https:\/\/[^\s]+$/;
const hostRe = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const emailRe = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const cidrV4Re = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
const clickhouseVersionRe = /^(\d+)\.(\d+)\.\d+\.\d+$/;
const versionTagRe = /:([^\s:@/]+)@sha256:/;

// Clojure's `str`: nil renders empty, booleans lowercase, a vector as its
// literal. Green compares stringified values in several rules, and a bare
// JavaScript `String()` disagrees with it on exactly the inputs those rules
// exist to catch — `String(["cloudflare"])` is `cloudflare`, which would make a
// one-element list of ranges read as the symbolic source.
export function s(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

export function missing(value: unknown): boolean {
  return value === null || value === undefined ||
    (typeof value === "string" && value.trim() === "");
}

export function computeName(opts: Opts): string {
  return topology.computeName(opts);
}

// Whether this deployment owns its machine keypair. Delegates to ONCE, the
// standard's reference implementation, so one rule decides it everywhere.
export function keygen(opts: Opts): boolean {
  return onceSsh.keygen(opts);
}

// The human-readable tag out of a `repo:tag@sha256:...` pin, or undefined.
export function imageVersion(value: unknown): string | undefined {
  return versionTagRe.exec(s(value))?.[1];
}

// Whether desired state explicitly accepts one R2 credential reaching
// OpenTofu state and live data or backups alike.
export function credentialSharingAccepted(opts: Opts): boolean {
  return s(opts["r2-credential-sharing"]) === "shared-accepted";
}

export function envErrors(env: Record<string, string | undefined>): string[] {
  return s(env[profilePar]).length > 0
    ? [`${profilePar} is set; profile must come from colors.yml only`]
    : [];
}

function intLike(value: unknown): boolean {
  if (typeof value === "number") return Number.isInteger(value);
  return typeof value === "string" && /^-?\d+$/.test(value);
}

function asInt(value: unknown): number | undefined {
  if (!intLike(value)) return undefined;
  return typeof value === "number" ? value : Number.parseInt(value as string, 10);
}

function positive(value: unknown): boolean {
  const n = asInt(value);
  return n !== undefined && n > 0;
}

// Langfuse v4 requires ClickHouse >= 25.12.
function clickhouseVersionOk(value: unknown): boolean {
  const m = clickhouseVersionRe.exec(s(value));
  if (!m) return false;
  const major = Number.parseInt(m[1]!, 10);
  const minor = Number.parseInt(m[2]!, 10);
  return major > 25 || (major === 25 && minor >= 12);
}

export function stateErrors(opts: Opts): string[] {
  const errors: string[] = [];
  for (const key of required) {
    if (missing(opts[key])) errors.push(`:${key} is required`);
  }

  if (opts["provider-compute"] !== "vultr") {
    errors.push(":provider-compute must be vultr");
  }
  if (opts["provider-dns"] !== "cloudflare") {
    errors.push(":provider-dns must be cloudflare");
  }
  if (!["local", "s3", "r2"].includes(opts["provider-backend"] as string)) {
    errors.push(":provider-backend must be local, s3, or r2");
  }
  if (typeof opts["compute-prevent-destroy"] !== "boolean") {
    errors.push(":compute-prevent-destroy must be true or false");
  }

  // --- images ------------------------------------------------------------
  for (const key of imageKeys) {
    const value = opts[key];
    if (!missing(value) && !imageRe.test(s(value))) {
      errors.push(`:${key} must carry an explicit image tag or digest`);
    }
  }
  for (const key of imageKeys) {
    if (!missing(opts[key]) && !s(opts[key]).includes("@sha256:")) {
      errors.push(`:${key} must be pinned by digest (tag@sha256:...)`);
    }
  }
  // Web and worker ship together; a mismatched pair runs one schema against
  // another's migrations.
  const a = imageVersion(opts["langfuse-image"]);
  const b = imageVersion(opts["langfuse-worker-image"]);
  if (a && b && a !== b) {
    errors.push(`:langfuse-worker-image version ${b} must equal :langfuse-image version ${a}`);
  }

  // --- application tier ---------------------------------------------------
  if (!(missing(opts["langfuse-host"]) || hostRe.test(s(opts["langfuse-host"])))) {
    errors.push(":langfuse-host must be a fully qualified hostname");
  }
  if (!(missing(opts["langfuse-init-user-email"]) || emailRe.test(s(opts["langfuse-init-user-email"])))) {
    errors.push(":langfuse-init-user-email must be an email address");
  }
  for (const key of ["langfuse-init-org-id", "langfuse-init-project-id"]) {
    const value = opts[key];
    if (!missing(value) && !slugRe.test(s(value))) {
      errors.push(`:${key} must be a lowercase slug`);
    }
  }
  // Langfuse requires a trailing slash on every S3 prefix, and silently
  // concatenates without one.
  if (!missing(opts["langfuse-s3-prefix"]) && !s(opts["langfuse-s3-prefix"]).endsWith("/")) {
    errors.push(":langfuse-s3-prefix must end with a slash");
  }
  if (!(missing(opts["langfuse-smoke-traces"]) || positive(opts["langfuse-smoke-traces"]))) {
    errors.push(":langfuse-smoke-traces must be a positive integer");
  }
  if (!(missing(opts["langfuse-smoke-timeout-seconds"]) || positive(opts["langfuse-smoke-timeout-seconds"]))) {
    errors.push(":langfuse-smoke-timeout-seconds must be a positive integer");
  }

  // --- cache tier -----------------------------------------------------------
  if (!(missing(opts["redis-port"]) || intLike(opts["redis-port"]))) {
    errors.push(":redis-port must be a port number");
  }

  // --- analytics tier -------------------------------------------------------
  const chVersion = opts["clickhouse-version"];
  if (!missing(chVersion) && !clickhouseVersionRe.test(s(chVersion))) {
    errors.push(":clickhouse-version must be an exact four-part apt version, e.g. 26.3.29.7");
  }
  if (clickhouseVersionRe.test(s(chVersion)) && !clickhouseVersionOk(chVersion)) {
    errors.push(":clickhouse-version must be 25.12 or newer; Langfuse v4 requires it for lightweight updates, the JSON type, and full-text search");
  }
  // Langfuse's bundled migrations run ON CLUSTER `default`; any other name
  // means disabling auto-migration and applying them by hand.
  if (!missing(opts["clickhouse-cluster-name"]) && s(opts["clickhouse-cluster-name"]) !== "default") {
    errors.push(":clickhouse-cluster-name must be default, or Langfuse cannot run its ON CLUSTER migrations unaided");
  }
  if (!missing(opts["clickhouse-nodes"]) && asInt(opts["clickhouse-nodes"]) !== topology.clickhouseNodeCount) {
    errors.push(`:clickhouse-nodes must be ${topology.clickhouseNodeCount} (one shard, three replicas, three Keeper voters)`);
  }
  for (const key of ["clickhouse-http-port", "clickhouse-native-port", "clickhouse-interserver-port",
    "clickhouse-keeper-port", "clickhouse-raft-port"]) {
    if (!missing(opts[key]) && !intLike(opts[key])) {
      errors.push(`:${key} must be a port number`);
    }
  }

  // --- storage tier -------------------------------------------------------
  const pgVersion = opts["neon-pg-version"];
  if (!(missing(pgVersion) ||
        (typeof pgVersion === "number" && [14, 15, 16, 17].includes(pgVersion)))) {
    errors.push(":neon-pg-version must be 14, 15, 16, or 17");
  }
  for (const key of ["neon-tenant-id", "neon-timeline-id"]) {
    const value = opts[key];
    if (!missing(value) && !hex32Re.test(s(value))) {
      errors.push(`:${key} must be 32 lowercase hex characters`);
    }
  }
  for (const key of ["neon-database", "neon-role"]) {
    const value = opts[key];
    if (!missing(value) && !identRe.test(s(value))) {
      errors.push(`:${key} must be a lowercase identifier`);
    }
  }
  if (s(opts["neon-role"]) === "cloud_admin") {
    errors.push(":neon-role must not be cloud_admin");
  }
  for (const key of ["neon-r2-endpoint", "langfuse-backup-r2-endpoint", "r2-endpoint"]) {
    if (!missing(opts[key]) && !urlRe.test(s(opts[key]))) {
      errors.push(`:${key} must be an https URL`);
    }
  }

  // --- buckets ---------------------------------------------------------------
  // Live data and OpenTofu state must not share a bucket: one lifecycle
  // mistake would take out both. Backups must share a bucket with neither.
  for (const key of ["neon-r2-bucket", "langfuse-s3-bucket"]) {
    if (!missing(opts[key]) && s(opts[key]) === s(opts["r2-bucket"])) {
      errors.push(`:${key} must not be the OpenTofu state bucket`);
    }
  }
  if (!missing(opts["langfuse-backup-r2-bucket"]) &&
      new Set([s(opts["r2-bucket"]), s(opts["neon-r2-bucket"]), s(opts["langfuse-s3-bucket"])])
        .has(s(opts["langfuse-backup-r2-bucket"]))) {
    errors.push(":langfuse-backup-r2-bucket must not be the state or a live-data bucket");
  }

  // --- backups ----------------------------------------------------------------
  for (const key of ["langfuse-backup-retention-days", "langfuse-postgres-backup-max-age-hours",
    "langfuse-clickhouse-backup-max-age-hours", "langfuse-media-backup-max-age-hours"]) {
    if (!missing(opts[key]) && !positive(opts[key])) {
      errors.push(`:${key} must be a positive integer`);
    }
  }

  // --- network ----------------------------------------------------------------
  if (!missing(opts["vultr-vpc-subnet"]) && !cidrV4Re.test(s(opts["vultr-vpc-subnet"]))) {
    errors.push(":vultr-vpc-subnet must be an IPv4 CIDR, e.g. 10.50.0.0/24");
  }
  // Restricting the origin to Cloudflare's ranges and NOT proxying the record
  // are mutually exclusive, and the failure is silent until the certificate is
  // needed: Caddy answers the ACME HTTP-01 challenge on :80, and with the
  // record unproxied that challenge arrives from Let's Encrypt's own
  // addresses, which the firewall drops.
  if (s(opts["vultr-http-sources"]) === "cloudflare" && opts["cloudflare-proxied"] !== true) {
    errors.push(":vultr-http-sources cloudflare requires :cloudflare-proxied true, or ACME HTTP-01 is firewalled off and no certificate is ever issued");
  }
  if (!(missing(opts["r2-credential-sharing"]) ||
        ["split", "shared-accepted"].includes(s(opts["r2-credential-sharing"])))) {
    errors.push(":r2-credential-sharing must be split or shared-accepted");
  }
  const osId = opts["vultr-os-id"];
  if (!(missing(osId) || (typeof osId === "number" && Number.isInteger(osId)))) {
    errors.push(":vultr-os-id must be Vultr's numeric operating-system id");
  }
  return errors;
}

export function backendSecrets(opts: Opts): string[] {
  return providers["provider-backend"]?.[String(opts["provider-backend"])]?.secrets ?? [];
}

// What talking to the providers needs, on any real event.
export const providerSecrets = ["vultr-api-key", "cloudflare-api-token"];

// The two pairs that reach hosts on a create. `neon-r2-*` is what the
// getcolors/neon play reads for the storage tier; `langfuse-storage-r2-*` is
// what the app host uses for events and media. The deployment's `.envrc` maps
// one onto the other when they are the same token.
export const storageSecrets = [
  "neon-r2-access-key-id", "neon-r2-secret-access-key",
  "langfuse-storage-r2-access-key-id", "langfuse-storage-r2-secret-access-key",
  "langfuse-backup-r2-access-key-id", "langfuse-backup-r2-secret-access-key",
];

// Operator-held on purpose. A host-generated secret that no backup carries
// dies with the app host and takes every encrypted row with it; the init
// password is what logs an operator in after that host is rebuilt.
export const applicationSecrets = ["langfuse-encryption-key", "langfuse-salt", "langfuse-init-user-password"];

function samePair(opts: Opts, a: string, b: string): boolean {
  return !missing(opts[a]) && s(opts[a]) === s(opts[b]);
}

// Credentials a real event needs. A delete tears down infrastructure and never
// converges anything, so it asks for the provider credentials only.
export function secretErrors(opts: Opts, event: string): string[] {
  const create = event === "create";
  const keys = [...new Set([
    ...providerSecrets,
    ...(create ? [...storageSecrets, ...applicationSecrets] : []),
    ...backendSecrets(opts),
  ])];
  const errors = keys.filter((key) => missing(opts[key]))
    .map((key) => `required credential is not set: ${parName(key)}`);
  // Blast radius, enforced rather than merely observed. The shared pair stays
  // reachable, but only as a deliberate, committed choice.
  if (create && !credentialSharingAccepted(opts)) {
    const pairs: Array<[string, string]> = [
      ["live Neon data", "neon-r2-access-key-id"],
      ["Langfuse events and media", "langfuse-storage-r2-access-key-id"],
      ["backups", "langfuse-backup-r2-access-key-id"],
    ];
    for (const [label, key] of pairs) {
      if (samePair(opts, key, "r2-access-key-id")) {
        errors.push(`${label} would use the same R2 credential as OpenTofu state. Supply ` +
          `${parName(key)} scoped to its own bucket, or set ` +
          ":r2-credential-sharing: shared-accepted in colors.yml to record " +
          "that the blast radius is accepted");
      }
    }
  }
  if (create && !credentialSharingAccepted(opts) &&
      samePair(opts, "langfuse-backup-r2-access-key-id", "langfuse-storage-r2-access-key-id")) {
    errors.push("backups would use the same R2 credential as live data. A backup a " +
      "compromised host can erase is not a backup; supply " +
      parName("langfuse-backup-r2-access-key-id") +
      " scoped to the backup bucket alone, or set " +
      ":r2-credential-sharing: shared-accepted in colors.yml");
  }
  if (create && !missing(opts["langfuse-encryption-key"]) &&
      !hex64Re.test(s(opts["langfuse-encryption-key"]))) {
    errors.push(`${parName("langfuse-encryption-key")} must be 64 lowercase hex characters (openssl rand -hex 32)`);
  }
  if (create && !missing(opts["langfuse-salt"]) && s(opts["langfuse-salt"]).length < 32) {
    errors.push(`${parName("langfuse-salt")} must be at least 32 characters`);
  }
  if (create && !missing(opts["langfuse-init-user-password"]) &&
      s(opts["langfuse-init-user-password"]).length < 12) {
    errors.push(`${parName("langfuse-init-user-password")} must be at least 12 characters`);
  }
  return errors;
}

export function tofuEnv(opts: Opts, slot: string): Record<string, string> {
  switch (slot) {
    case "provider-compute":
      return { "vultr-api-key": "VULTR_API_KEY" };
    case "provider-dns":
      return { "cloudflare-api-token": "CLOUDFLARE_API_TOKEN" };
    case "provider-backend":
      return providers["provider-backend"]?.[String(opts["provider-backend"])]?.tofuEnv ?? {};
    default:
      return {};
  }
}
