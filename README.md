# langfuse

A tri-colour Package Skill (green, red, blue) for self-hosted
[Langfuse](https://langfuse.com) v4 on six Vultr machines in one VPC: a self-hosted **Neon** storage tier for
Postgres, a **Redis** host, three **ClickHouse** replicas with their own
Keeper quorum, and the application host running `langfuse-web`,
`langfuse-worker` and Caddy behind a Cloudflare-proxied name. Cloudflare R2
carries Neon's layers and WAL, Langfuse's raw events and media, and the
backups. OpenTofu manages the VPC, four role-scoped firewall groups, the
instances and the DNS record; Ansible converges every tier and runs the
gates. The first consumer is
[`langfuse-vultr`](https://github.com/getcolors/langfuse-vultr).

## The interesting claim, and how it is proven

Langfuse's own guidance is a single-host Docker Compose for "testing and
low-scale deployments" or Kubernetes for production. This package is the
shape in between: the components Langfuse says should be separate are
separate, each on a machine sized at the documented minimum, with the data
tiers reachable only from the peer that needs them — and every claim the
README makes is a gate that runs on every converge, or a rehearsal that ran
on the live build:

- a trace, a generation and a score go in through the ingestion API and are
  read back through the public API, found on ClickHouse node 0 **and** on
  the last replica, and leave a **new** raw-event object in R2;
- a media file goes up through a presigned URL and comes back with the same
  sha256;
- 200 traces are queryable within the timeout and host memory stays under
  85 %;
- a wrong API key, an anonymous request, an unauthenticated Redis `PING`, a
  wrong ClickHouse password and a wrong Postgres password are all refused;
- the app host reaches Neon, Redis and the ClickHouse client ports by raw
  TCP and is **refused** on Keeper; both databases answer `UTC`;
- `rehearse` restores both stores from their newest completed sets, boots
  the pinned image against the restored data, reads the trace, the project
  and an encrypted LLM connection back through the API, stops a replica
  under ingestion, restarts Redis with a job queued — and only then writes
  `.colors-recovery-verified`.

## Install

Three implementations of one model — Clojure/Babashka, TypeScript/Bun,
Python/uv — rendering byte-identical output. Pick one:

```sh
npx skills add getcolors/langfuse
cp .agents/skills/package-langfuse-green/green ./green   # or -red/red, or -blue/blue
chmod +x green
```

`./red` and `./blue` take the same verbs and the same `colors.yml`, and
`scripts/parity.sh` is what makes "the same" a checked claim rather than an
intention: both fixtures through all three colours, diffed byte for byte.

The root `green` is a **copy** of the payload, not a symlink. `npx skills
update -p` rewrites the payload and leaves the copy alone; copy it again after
every update.

## Use

```sh
./green build              # render .colors/<profile>/ — no provider calls, no credentials
./green create --dry-run   # walk the workflow, skip every side effect
./green create             # converge for real; the gates run inside it
./green rehearse           # restore-and-boot both stores, then the two drills
./green describe           # every host's last monitor result, over SSH
./green delete             # guarded by compute-prevent-destroy
```

`build` and `--dry-run` work on a fresh checkout with an empty environment.
Exit code 2 means validation failure and lists every problem at once.

The six machines follow the workspace Compute Cluster Standard: the compute
stage records them as `params.nodes`, and a deployment created before that
(one whose state still records `hosts`) is read as-is — its next converge
plans an output change only (`hosts` becomes `nodes`), never a resource
change.

## Configuration

`colors.yml` is the only file you edit; every key is documented in
[`skills/package-langfuse-green/references/configuration.md`](skills/package-langfuse-green/references/configuration.md).
Credentials are `COLORS_PAR_*` environment variables in a gitignored
`.envrc.private`:

| Variable | Reaches | For |
|---|---|---|
| `COLORS_PAR_VULTR_API_KEY` | workstation | VPC, firewall groups, instances, the account key |
| `COLORS_PAR_CLOUDFLARE_API_TOKEN` | workstation | the DNS record; Zone:Read + DNS:Edit |
| `COLORS_PAR_R2_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | workstation | OpenTofu state, and nothing else |
| `COLORS_PAR_LANGFUSE_STORAGE_R2_*` | Neon host, app host | Neon layers and WAL, Langfuse events and media (Object Read & Write on the storage bucket only) |
| `COLORS_PAR_NEON_R2_*` | Neon host | what the Neon play reads; the deployment's `.envrc` maps the storage pair onto it |
| `COLORS_PAR_LANGFUSE_BACKUP_R2_*` | Neon host, ClickHouse node 0 | backups (Object Read & Write on the backup bucket only) |
| `COLORS_PAR_LANGFUSE_ENCRYPTION_KEY` | app host | 64 hex chars — **operator-held, see below** |
| `COLORS_PAR_LANGFUSE_SALT` | app host | ≥ 32 chars — **operator-held** |
| `COLORS_PAR_LANGFUSE_INIT_USER_PASSWORD` | app host | ≥ 12 chars — **operator-held** |

Never export `COLORS_PAR_PROFILE`: it selects the deployment's remote state.

The package refuses a real create when the storage or backup pair equals the
state pair, or the backup pair equals the storage pair, unless `colors.yml`
records `r2-credential-sharing: shared-accepted` — a deliberate line visible
in a diff, never a silent default.

Everything else is generated on the host that owns it, create-once: the Neon
role and `cloud_admin` passwords, the Redis password, the ClickHouse
`admin`, `langfuse`, interserver and cluster secrets, `NEXTAUTH_SECRET`, and
the initial project's API keys. `sudo langfuse-credential` on the app host
prints the keys; nothing else does.

### Three secrets outlive the app host

`ENCRYPTION_KEY` encrypts every stored secret (LLM connections, integration
credentials); `SALT` hashes every API key. A Postgres backup restored onto a
fresh app host is readable **only** with the same two values, which is why
this package makes them yours to hold rather than generating them on a disk
that a rebuild would wipe. The init password is what logs you in after that
rebuild, when the generated project keys are gone and must be minted again.
Keep all three somewhere that is not one of these machines.

## Topology

| Machine | Runs | Reachable from |
|---|---|---|
| `<profile>-neon` | storage broker, pageserver, one safekeeper, Postgres 17 under `compute_ctl` | app host on 55433 |
| `<profile>-redis` | Redis 7.2, AOF, `noeviction` | app host on 6379 |
| `<profile>-clickhouse-{0,1,2}` | ClickHouse + one Keeper voter each, cluster `default` | app host on 8123/9000; each other on 9000/9009/9181/9234 |
| `<profile>-app` | `langfuse-web`, `langfuse-worker`, Caddy | Cloudflare on 80/443 |

Every machine admits 22 from `vultr-ssh-sources`, key-only. Each role has its
own Vultr firewall group — a group filters the private interface too, so one
shared group would have let a compromised Redis reach Keeper — and every
east-west rule names the peer's `/32`. ufw mirrors the same rules on each
host; ClickHouse runs natively, so ufw is load-bearing there, while Docker's
published ports (Neon compute, Redis) bypass it and rely on the provider
group.

The Neon tier is not reimplemented here. This package SHA-pins
[`getcolors/neon`](https://github.com/getcolors/neon) and renders its Ansible
templates off the classpath into `neon/` inside the stage, adding only a
Compose overlay that publishes the compute port on the VPC address. The
ClickHouse templates are this package's own, derived from
[`getcolors/clickhouse`](https://github.com/getcolors/clickhouse) with every
address resolved from the inventory, secrets generated on node 0 and
propagated, and the six system log tables Langfuse never reads removed while
`query_log` — which v4 does read — stays with a 30-day TTL.

The app tier points at ClickHouse node 0. Langfuse has no client-side replica
failover; the data survives on all three, the app reaches one. That is a
stated limitation, not an oversight.

## Backups and recovery, stated honestly

Three sets, all under `<profile>/` in the backup bucket, each with a
completion protocol — objects uploaded, verified by read-back, manifest
written, `.complete` written **last** — so a restore never picks a
half-written set:

| Set | From | Cadence | Mechanism |
|---|---|---|---|
| `postgres/` | Neon host | every 6 h | `pg_dump` inside the compute container (Ubuntu's client is 16, compute is 17) |
| `clickhouse/` | node 0 | nightly | native `BACKUP DATABASE default TO Disk('backups', …)` — the credential lives in the disk configuration, never in SQL or `query_log` |
| `media/` | Neon host | nightly | additive `rclone copy`, whole-prefix `rclone check` before the run's marker; never pruned, never mirrors a deletion |

Raw events (`events/`) and exports are deliberately not backed up: Langfuse
treats the events prefix as a reprocessing buffer whose deletion it
recommends after 30 days, and ClickHouse is the system of record.

**Pairing.** The two databases are not quiesced for a coordinated snapshot —
pausing ingestion on an observability system every six hours is the wrong
trade. Instead, at restore time a ClickHouse set is paired with the **oldest
Postgres dump completed after it**, so Postgres is always the newer
snapshot: every project a restored trace references exists; a project
created after the ClickHouse snapshot exists without its newest traces
(bounded, visible loss); a project deleted after it leaves orphan rows that
reference nothing. A ClickHouse set with no later dump is refused rather
than paired backwards.

**What Redis loss means.** The AOF survives a restart (drilled). A lost
Redis host loses the jobs that were queued: their raw events stay in R2, and
Langfuse documents no automated replay for them. Say so; do not assume it.

**Neon's own durability** is the neon-single-node one: a rebuilt safekeeper
does not recover its offloaded WAL, so the Postgres dump interval is the real
RPO for the transactional tier.

`./green rehearse` is the proof, not the plan: fresh sets, restore both,
boot the pinned image in a second Compose project on loopback with the
operator-held keys, read through the API, then the replica-loss and
Redis-restart drills, then the marker. `langfuse-status` on the app host
prints both markers.

## Media in the browser

The SDK and API media path needs nothing beyond what this package converges.
Rendering media **in the UI** additionally needs a CORS rule on the storage
bucket, and R2 bucket configuration needs an Admin token that this package
deliberately hands to no host. Add it once, in the R2 dashboard or with
`wrangler r2 bucket cors put <bucket> --rules <file>`:

```json
[{"AllowedOrigins": ["https://<langfuse-host>"], "AllowedMethods": ["GET", "PUT", "HEAD"],
  "AllowedHeaders": ["*"], "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3600}]
```

The smoke gate reports the preflight as a `WARN` line until it is there.

## Monitoring

Every host runs a monitor timer every fifteen minutes and writes
`/var/lib/colors/<role>-monitor.json`: backup freshness against the
per-store thresholds, disk, container restarts, worker health with the
stuck-queue flag, Keeper quorum and replication queue depth, Redis AOF
status, certificate expiry. `./green describe` aggregates the six over SSH
and exits non-zero on any problem. There is no alert sink in this package;
point an external poller at `describe`.

## Delete

`./green delete` needs `COLORS_PAR_COMPUTE_PREVENT_DESTROY=false` for one
run, stops every stack, removes the SSH config block, the DNS record, the six
instances, the firewall groups and the VPC, and finally the machine keypair.
It removes **nothing** in R2: the storage prefix and the backup sets outlive
the machines on purpose.

## Development

```sh
cd green && bb test        # validator, topology, ssh config, tools, workflow
cd red   && bun test && bun run typecheck
cd blue  && uv run pytest
cd green && bb golden      # green, two fixtures: keygen and ssh-keypair opt-out
cd green && bb golden:accept   # only after reading the diff
cd green && bb syntax      # ansible-playbook --syntax-check on the rendered tree
./scripts/parity.sh        # three colours, two fixtures, byte for byte
./scripts/launcher.sh      # the three payloads, and green end to end from a copy
cd green && ./green build  # against the package's own colors.yml
```

`LANGFUSE_LIB_ROOT=/path/to/langfuse` (the repository root) points a
deployment's launcher of any colour at this working tree; `GREEN_LIB_ROOT`
and `ONCE_LIB_ROOT` do the same for the SDK and ONCE. `cd green && bb pin`
stamps all three payloads from a clean, pushed HEAD. The neon pin is recorded
in four places — `green/deps.edn`, `red/package.json`, `blue/pyproject.toml`
and the red payload's `PINS` — and `scripts/launcher.sh` fails when they
disagree.

## Licence

MIT.
