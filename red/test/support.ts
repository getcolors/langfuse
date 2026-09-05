// Fixtures the red suites share. Not a test file: importing one test file
// from another would register its cases twice.
import type { Opts } from "red/workflow";
import { computeCluster } from "package-once-red";

// A minimal valid desired state, kept complete on purpose: `stateErrors`
// reports every problem at once, so a fixture missing keys would make every
// test read as a pass-by-accident.
export const base: Opts = {
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

export const creds: Opts = {
  "vultr-api-key": "v", "cloudflare-api-token": "c",
  "r2-access-key-id": "state", "r2-secret-access-key": "state-secret",
  "neon-r2-access-key-id": "store", "neon-r2-secret-access-key": "store-secret",
  "langfuse-storage-r2-access-key-id": "store", "langfuse-storage-r2-secret-access-key": "store-secret",
  "langfuse-backup-r2-access-key-id": "backup", "langfuse-backup-r2-secret-access-key": "backup-secret",
  "langfuse-encryption-key": "a".repeat(64),
  "langfuse-salt": "s".repeat(32),
  "langfuse-init-user-password": "twelve-chars!",
};


// The compute stage's recorded `params`, as ONCE reads it: snake_case node
// keys, every field present, a 0-based index on every node — the shape the
// template outputs since adoption.
export const params: computeCluster.ClusterParams = {
  provider: "vultr",
  ssh_key_id: "7692e92a",
  nodes: [
    { role: "neon", index: 0, name: "langfuse-test-neon", ip: "1.1.1.1", vpc_ip: "10.50.0.2", user: "root", sudoer: "root" },
    { role: "redis", index: 0, name: "langfuse-test-redis", ip: "1.1.1.2", vpc_ip: "10.50.0.3", user: "root", sudoer: "root" },
    { role: "clickhouse", index: 0, name: "langfuse-test-clickhouse-0", ip: "1.1.1.3", vpc_ip: "10.50.0.4", user: "root", sudoer: "root" },
    { role: "clickhouse", index: 1, name: "langfuse-test-clickhouse-1", ip: "1.1.1.4", vpc_ip: "10.50.0.5", user: "root", sudoer: "root" },
    { role: "clickhouse", index: 2, name: "langfuse-test-clickhouse-2", ip: "1.1.1.5", vpc_ip: "10.50.0.6", user: "root", sudoer: "root" },
    { role: "app", index: 0, name: "langfuse-test-app", ip: "1.1.1.6", vpc_ip: "10.50.0.7", user: "root", sudoer: "root" },
  ],
};

// The shape `langfuse-vultr` recorded before adoption, as `tofu output -json`
// delivers it to the reader: `hosts` rather than `nodes`, `index: null` on the
// four singletons, no `provider`.
export const legacyRaw: Record<string, unknown> = {
  ssh_key_id: "7692e92a",
  hosts: [
    { role: "neon", index: null, name: "langfuse-vultr-neon", ip: "203.0.113.1", vpc_ip: "10.50.0.3", user: "root", sudoer: "root" },
    { role: "redis", index: null, name: "langfuse-vultr-redis", ip: "203.0.113.2", vpc_ip: "10.50.0.4", user: "root", sudoer: "root" },
    { role: "clickhouse", index: 0, name: "langfuse-vultr-clickhouse-0", ip: "203.0.113.3", vpc_ip: "10.50.0.5", user: "root", sudoer: "root" },
    { role: "clickhouse", index: 1, name: "langfuse-vultr-clickhouse-1", ip: "203.0.113.4", vpc_ip: "10.50.0.6", user: "root", sudoer: "root" },
    { role: "clickhouse", index: 2, name: "langfuse-vultr-clickhouse-2", ip: "203.0.113.5", vpc_ip: "10.50.0.7", user: "root", sudoer: "root" },
    { role: "app", index: null, name: "langfuse-vultr-app", ip: "203.0.113.6", vpc_ip: "10.50.0.8", user: "root", sudoer: "root" },
  ],
};

export const legacyTranslated: computeCluster.ClusterParams = {
  ssh_key_id: "7692e92a",
  provider: "vultr",
  nodes: (legacyRaw.hosts as Record<string, unknown>[]).map((h) => ({ ...h, index: h.index ?? 0 })) as computeCluster.Node[],
};
