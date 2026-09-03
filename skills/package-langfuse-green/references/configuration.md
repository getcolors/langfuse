# Configuration reference

Every key `colors.yml` may carry. Non-secret values only: credentials are
`COLORS_PAR_*` environment variables, never keys here.

## Identity and providers

| Key | Example |
|---|---|
| `profile` | `langfuse-vultr` |
| `workdir` | `.colors` |
| `provider-compute` | `vultr` |
| `provider-dns` | `cloudflare` |
| `provider-backend` | `r2` |
| `compute-prevent-destroy` | `true` |
| `r2-credential-sharing` | optional; `shared-accepted` records that one R2 credential reaches state and live data or backups alike |

## Langfuse application

| Key | Example |
|---|---|
| `langfuse-image` | `docker.langfuse.com/langfuse/langfuse:4.27.0@sha256:…` |
| `langfuse-worker-image` | `docker.langfuse.com/langfuse/langfuse-worker:4.27.0@sha256:…` (same version as the web image) |
| `langfuse-host` | `langfuse.example.com` |
| `langfuse-init-org-id` / `-name` | `getcolors` / `getcolors` |
| `langfuse-init-project-id` / `-name` | `langfuse-vultr` / `langfuse-vultr` |
| `langfuse-init-user-email` / `-name` | `operator@example.com` / `Operator` |
| `langfuse-s3-bucket` | `langfuse-storage` — events, media, exports |
| `langfuse-s3-prefix` | `langfuse-vultr/` (must end with `/`) |
| `langfuse-smoke-traces` | `200` |
| `langfuse-smoke-timeout-seconds` | `120` |
| `caddy-image` | `docker.io/library/caddy:2.11.4@sha256:…` |

## Redis

| Key | Example |
|---|---|
| `redis-image` | `docker.io/library/redis:7.2.16@sha256:…` |
| `redis-port` | `6379` |

## ClickHouse

| Key | Example |
|---|---|
| `clickhouse-version` | `26.3.29.7` — an exact apt version, `>= 25.12` |
| `clickhouse-cluster-name` | `default` (required; Langfuse migrates `ON CLUSTER default`) |
| `clickhouse-nodes` | `3` (fixed) |
| `clickhouse-http-port` | `8123` |
| `clickhouse-native-port` | `9000` |
| `clickhouse-interserver-port` | `9009` |
| `clickhouse-keeper-port` | `9181` |
| `clickhouse-raft-port` | `9234` |

## Storage tier (neon vocabulary)

| Key | Example |
|---|---|
| `neon-image` | `ghcr.io/neondatabase/neon:release-9129@sha256:…` |
| `neon-compute-image` | `ghcr.io/neondatabase/compute-node-v17:release-compute-9073@sha256:…` |
| `neon-pg-version` | `17` |
| `neon-tenant-id` | 32 lowercase hex |
| `neon-timeline-id` | 32 lowercase hex |
| `neon-database` | `langfuse` |
| `neon-role` | `langfuse` |
| `neon-r2-bucket` | `langfuse-storage` |
| `neon-r2-endpoint` | `https://<account>.eu.r2.cloudflarestorage.com` |
| `neon-r2-region` | `auto` |
| `neon-r2-prefix` | `langfuse-vultr/neon` |

## Backups

| Key | Example |
|---|---|
| `langfuse-backup-r2-bucket` | `langfuse-backup` |
| `langfuse-backup-r2-endpoint` | `https://<account>.eu.r2.cloudflarestorage.com` |
| `langfuse-backup-r2-region` | `auto` |
| `langfuse-postgres-backup-oncalendar` | `"*-*-* 00/6:00:00"` |
| `langfuse-clickhouse-backup-oncalendar` | `"*-*-* 02:30:00"` |
| `langfuse-media-backup-oncalendar` | `"*-*-* 03:30:00"` |
| `langfuse-backup-retention-days` | `7` |
| `langfuse-postgres-backup-max-age-hours` | `8` |
| `langfuse-clickhouse-backup-max-age-hours` | `30` |
| `langfuse-media-backup-max-age-hours` | `30` |

## Public name

| Key | Example |
|---|---|
| `cloudflare-zone` | `example.com` |
| `cloudflare-record-name` | `langfuse` |
| `cloudflare-proxied` | `true` (required when `vultr-http-sources` is `cloudflare`) |

## Vultr

| Key | Example |
|---|---|
| `vultr-name` | optional override of the machine base name (Compute Name Standard) |
| `vultr-region` | `ams` |
| `vultr-os-id` | `2284` (Ubuntu 24.04) |
| `vultr-vpc-subnet` | `10.50.0.0/24` |
| `vultr-plan-neon` | `vc2-4c-8gb` |
| `vultr-plan-redis` | `vc2-1c-2gb` |
| `vultr-plan-clickhouse` | `vc2-4c-8gb` |
| `vultr-plan-app` | `vc2-4c-8gb` |
| `vultr-ssh-keys` | optional; present = SSH keypair opt-out mode |
| `vultr-ssh-sources` | `["0.0.0.0/0", "::/0"]` |
| `vultr-http-sources` | `cloudflare` (resolved at render time) or an explicit list |

## State backend

| Key | Example |
|---|---|
| `r2-bucket` | `tofu-state-…` |
| `r2-endpoint` | `https://<account>.eu.r2.cloudflarestorage.com` |
