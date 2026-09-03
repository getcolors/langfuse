---
name: package-langfuse-green
description: Provision and manage self-hosted Langfuse v4 on six Vultr machines in one VPC — a self-hosted Neon storage tier for Postgres, a Redis host, three ClickHouse replicas with Keeper, and the application host (langfuse-web, langfuse-worker, Caddy) behind a Cloudflare-proxied name, with Cloudflare R2 for events, media, Neon layers and WAL, and backups — using OpenTofu and Ansible. Use when asked to deploy, converge, rehearse recovery for, inspect or tear down self-hosted Langfuse, to run Langfuse on separate machines rather than one Docker Compose host, or to work on a colors.yml for a Langfuse deployment.
---

# Langfuse Package Skill (Green)

Provisions six Vultr machines in one VPC and converges Langfuse v4.27.0 across
them: a **Neon** storage tier (storage broker, pageserver, one safekeeper,
Postgres 17 under `compute_ctl`, layers and WAL in R2), **Redis 7.2**, three
**ClickHouse** replicas each with a Keeper voter, and the **app** host running
`langfuse-web`, `langfuse-worker` and Caddy behind Cloudflare.

The Neon tier is not reimplemented here: this package SHA-pins
[`getcolors/neon`](https://github.com/getcolors/neon) and renders its templates
off the classpath. The ClickHouse templates are this package's own, derived
from [`getcolors/clickhouse`](https://github.com/getcolors/clickhouse).

## Install the launcher

```sh
npx skills add getcolors/langfuse
cp .agents/skills/package-langfuse-green/green ./green
chmod +x green
```

The root `green` is a **copy** of the payload, not a symlink. `npx skills
update -p` rewrites the payload and leaves the copy alone, so copy it again
after every update or the project keeps running the old pin.

## Verbs

```sh
./green build              # render .colors/<profile>/ — no provider calls, no credentials
./green create --dry-run   # walk the workflow, skip every side effect
./green create             # converge for real; the gates run inside it
./green rehearse           # restore both stores from backup, boot the pinned image, drill
./green describe           # every host's last monitor result, over SSH
./green delete             # guarded by compute-prevent-destroy; removes nothing in R2
```

`build` and `--dry-run` work on a fresh checkout with an empty environment.
Exit code 2 means validation failure and lists every problem at once.

## Credentials

Non-secret desired state lives in `colors.yml`. Every credential is a
`COLORS_PAR_*` environment variable, conventionally in a gitignored
`.envrc.private`:

| Variable | For |
|---|---|
| `COLORS_PAR_VULTR_API_KEY` | VPC, firewall groups, instances, SSH key resource |
| `COLORS_PAR_CLOUDFLARE_API_TOKEN` | the DNS record; Zone:Read + DNS:Edit |
| `COLORS_PAR_R2_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | OpenTofu state only; reaches no host |
| `COLORS_PAR_LANGFUSE_STORAGE_R2_*` | events, media, exports (Object Read & Write on the storage bucket) |
| `COLORS_PAR_NEON_R2_*` | Neon layers and WAL — the deployment's `.envrc` maps the storage pair onto these |
| `COLORS_PAR_LANGFUSE_BACKUP_R2_*` | backups (Object Read & Write on the backup bucket) |
| `COLORS_PAR_LANGFUSE_ENCRYPTION_KEY` | 64 hex chars, **operator-held** |
| `COLORS_PAR_LANGFUSE_SALT` | ≥ 32 chars, **operator-held** |
| `COLORS_PAR_LANGFUSE_INIT_USER_PASSWORD` | ≥ 12 chars, **operator-held** |

Never export `COLORS_PAR_PROFILE`: it selects the deployment's remote state.

The package refuses a create when the storage or backup pair equals the state
pair, or the backup pair equals the storage pair, unless `colors.yml` records
`r2-credential-sharing: shared-accepted` as a deliberate, committed line.

### Three secrets outlive the app host

`ENCRYPTION_KEY` encrypts every stored secret and `SALT` hashes every API key.
A Postgres backup restored onto a fresh app host is readable **only** with the
same two values, so they are the operator's to hold, never generated on a disk
a rebuild would wipe. The init password logs you in after that rebuild, when
the generated project keys are gone. Keep all three outside these machines.

Everything else — Neon, Redis and ClickHouse passwords, `NEXTAUTH_SECRET`, the
project API keys — is generated on the host that owns it. `sudo
langfuse-credential` on the app host prints the project keys.

## What convergence guarantees

Gates that run on every converge and fail it if they fail:

- raw TCP from the app host to Neon, Redis and the ClickHouse client ports,
  and a **refusal** on Keeper — the network says what desired state says
- `UTC` on both databases; three replicas visible through `clusterAllReplicas`;
  an authenticated cross-node query; Keeper quorum; `system.query_log` present
- a trace, a generation and a score ingested through the public API, read
  back, found on node 0 **and** the last replica, and a **new** raw-event
  object in R2
- a media file up through a presigned URL and back with the same sha256
- wrong API key, anonymous request, unauthenticated Redis `PING`, wrong
  ClickHouse and Postgres passwords all refused
- 200 traces queryable within the timeout, host memory under 85 %
- the backup credential cannot read live data; no backup credential in
  ClickHouse's `query_log`
- the ready marker `<prefix>.colors-ready`, written last and read back

`./green rehearse` then proves recovery: fresh sets, restore both stores,
boot the pinned image in a second Compose project on loopback with the
operator-held keys, read the trace, the project and an encrypted LLM
connection back through the API, stop a replica under ingestion, restart
Redis with a job queued, and write `.colors-recovery-verified`.

## Recovery, stated honestly

| Failure | Recovers from | RPO |
|---|---|---|
| a ClickHouse replica | the other two, automatically | 0 |
| a Redis restart | the AOF | 0 |
| the Redis host | nothing automated: queued jobs are lost, their raw events stay in R2 | the queue |
| Neon local state | R2 layers + safekeeper replay | ~0 |
| the Neon host | the Postgres dump | 6 h |
| the whole ClickHouse cluster | the nightly native backup, paired with the next Postgres dump | 24 h |
| the app host | a converge with the operator-held keys; new project keys | 0 |

Backups pair at restore time: a ClickHouse set with the **oldest Postgres
dump completed after it**, so Postgres is the newer snapshot and every
project a restored trace references exists.

## Media in the browser

The API media path needs nothing more. UI rendering needs a CORS rule on the
storage bucket for `https://<langfuse-host>`, which only an Admin R2 token can
set; add it in the R2 dashboard or with `wrangler r2 bucket cors put`. The
smoke gate reports the preflight as `WARN` until it is there.

## Configuration reference

See [references/configuration.md](references/configuration.md).
