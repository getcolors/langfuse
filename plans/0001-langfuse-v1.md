# Plan: Langfuse v4 on Vultr — one Package Skill, one deployment, six machines
_Locked via claudex-loop — by Claude + the getcolors operator, 2026-09-03; Codex (gpt-5.6-sol) APPROVED in round 4 of 5_

## Goal

Ship `getcolors/langfuse`, a **green-only** Package Skill that provisions
and converges self-hosted Langfuse v4 on Vultr as six machines in one VPC:
one Neon host (self-hosted serverless Postgres, rendered from the pinned
`getcolors/neon` templates), one Redis host, three ClickHouse + Keeper
nodes (templates derived from the `getcolors/clickhouse` package and owned
here, no Metabase, no dbt, no WireGuard), and one application host running
`langfuse-web`, `langfuse-worker`, and Caddy behind a Cloudflare-proxied
name. Cloudflare R2 carries Neon layers and WAL, Langfuse raw events and
media, and both backups. Ship `getcolors/langfuse-vultr`, the deployment
that uses it, converged for real and kept running, with acceptance gates
that ask the system what it has, a rehearsed **restore-and-boot** for both
data stores, and an idempotent second converge. Afterwards: catalog recipe,
featured entry, Context Skill, blog post — all pushed to `main`, no PRs.

## Approach

### A. Repository shape (`langfuse/`)

1. Green-only layout as `rama`/`alice`: `bb.edn`, `deps.edn`,
   `src/clj/io/github/getcolors/langfuse/{validate,tools,workflow,ssh,ssh_config}.clj`,
   `src/resources/io/github/getcolors/langfuse/tools/…`,
   `skills/package-langfuse-green/{SKILL.md,green,references/configuration.md}`,
   `test/{clj,fixtures,resources/golden}`, `scripts/{launcher.sh,golden.sh,syntax.sh}`,
   `plans/`, `README.md`, `CLAUDE.md`, `index.html` (both analytics tags),
   `.github/workflows/ci.yml`.
2. `deps.edn` pins green `ceb4159`, once `759eb03` (SSH keypair + config
   reference implementations, cannot go below `bc06f2f`), and **neon
   `87c0095`** — the storage tier's templates are rendered off the classpath
   into a `neon/` subdirectory of the ansible stage, never copied (n8n
   precedent, same pin n8n verified live 2026-09-01).
3. `bb golden` renders two fixtures (keygen and ssh-keypair opt-out) and
   diffs against committed goldens; `scripts/launcher.sh` runs the payload
   copy end to end; `scripts/syntax.sh` runs `ansible-playbook
   --syntax-check` offline on the rendered tree. No parity script: one
   colour.

### B. Desired state (`colors.yml` vocabulary)

4. Neon keys keep **neon's vocabulary** (`neon-image`, `neon-compute-image`,
   `neon-pg-version`, `neon-tenant-id`, `neon-timeline-id`, `neon-database:
   langfuse`, `neon-role: langfuse`, `neon-r2-bucket`, `neon-r2-endpoint`,
   `neon-r2-region`, `neon-r2-prefix: <profile>/neon`) because the
   templates are neon's.
5. Langfuse keys: `langfuse-image`, `langfuse-worker-image` (v4.27.0,
   tag@digest), `langfuse-host`, `langfuse-init-org-id/-name`,
   `langfuse-init-project-id/-name`, `langfuse-init-user-email/-name`,
   `langfuse-s3-bucket` (its **own key**, defaulting in the deployment to
   the same bucket as `neon-r2-bucket`; splitting Neon and Langfuse blobs
   into two buckets with two tokens is then a config change, not a code
   change), `langfuse-s3-prefix` (`<profile>/`, so events/media/exports
   become `<profile>/events/` etc.), `langfuse-smoke-traces: 200`,
   `langfuse-smoke-timeout-seconds: 120`, `caddy-image`.
6. Redis keys: `redis-image` (7.2.16 tag@digest), `redis-port: 6379`.
7. ClickHouse keys: `clickhouse-version` (exact apt version, ≥ 25.12; pin
   the current LTS `26.3.29.7`), `clickhouse-cluster-name: default`,
   `clickhouse-http-port: 8123`, `clickhouse-native-port: 9000`,
   `clickhouse-interserver-port: 9009`, `clickhouse-keeper-port: 9181`,
   `clickhouse-raft-port: 9234`, `clickhouse-nodes: 3` (fixed at 3 by the
   validator: one shard, three replicas, three Keeper voters).
8. Backup keys: `langfuse-backup-r2-bucket`, `-endpoint`, `-region`,
   `langfuse-postgres-backup-oncalendar: "*-*-* 00/6:00:00"`,
   `langfuse-clickhouse-backup-oncalendar: "*-*-* 02:30:00"`,
   `langfuse-backup-retention-days: 7`,
   `langfuse-postgres-backup-max-age-hours: 8`,
   `langfuse-clickhouse-backup-max-age-hours: 30`,
   `langfuse-media-backup-oncalendar: "*-*-* 03:30:00"`,
   `langfuse-media-backup-max-age-hours: 30` (monitor thresholds are one
   key per store, flat scalars).
9. Provider keys: `provider-compute: vultr`, `provider-dns: cloudflare`,
   `provider-backend: r2`, `vultr-region`, `vultr-os-id`, `vultr-vpc-subnet`,
   `vultr-plan-neon`, `vultr-plan-redis`, `vultr-plan-clickhouse`,
   `vultr-plan-app`, `vultr-ssh-sources`, `vultr-http-sources: cloudflare`
   (resolved at render time with an explicit User-Agent; failed fetch falls
   back to the committed list and never widens), `cloudflare-zone`,
   `cloudflare-record-name`, `cloudflare-proxied: true`, `r2-bucket`,
   `r2-endpoint`, `compute-prevent-destroy: true`. No `vultr-name`: machines
   are `<profile>-neon`, `<profile>-redis`, `<profile>-app`,
   `<profile>-clickhouse-{0,1,2}` (Compute Name Standard).
10. `r2-credential-sharing` (optional, `split` | `shared-accepted`): the
    validator refuses a real create when the storage pair or the backup pair
    equals the state pair unless `shared-accepted` is recorded.

### C. Credentials (`COLORS_PAR_*`, `.envrc.private` only)

11. Provider and storage: `VULTR_API_KEY`, `CLOUDFLARE_API_TOKEN`,
    `R2_ACCESS_KEY_ID/SECRET_ACCESS_KEY` (state bucket, reaches no host),
    `LANGFUSE_STORAGE_R2_ACCESS_KEY_ID/SECRET_ACCESS_KEY` (Object Read &
    Write on `langfuse-storage`; reaches the Neon host as `AWS_*` in
    `/etc/neon/r2.env` and the app host as the `LANGFUSE_S3_*` key pair),
    `LANGFUSE_BACKUP_R2_ACCESS_KEY_ID/SECRET_ACCESS_KEY` (Object Read &
    Write on `langfuse-backup`; reaches the Neon host and ClickHouse node 0).
    `.envrc` maps the storage pair onto `COLORS_PAR_NEON_R2_*`, the exact
    names neon's play reads via `lookup('env', …)`; supplying a distinct
    `COLORS_PAR_NEON_R2_*` pair in `.envrc.private` overrides the mapping
    and, with a distinct `langfuse-s3-bucket`, splits the two blob sets.
12. **Durable application secrets are operator-supplied**, the n8n
    encryption-key precedent, because a host-generated secret that no
    backup carries dies with the app host and takes every encrypted row
    with it: `COLORS_PAR_LANGFUSE_ENCRYPTION_KEY` (64 hex chars; validator
    checks length and hex), `COLORS_PAR_LANGFUSE_SALT` (≥ 32 chars),
    `COLORS_PAR_LANGFUSE_INIT_USER_PASSWORD` (≥ 12 chars). They reach the
    app host as `lookup('env', …)` expressions into
    `/etc/langfuse/operator.env`, never `.colors/`. The README states
    plainly: lose `ENCRYPTION_KEY` or `SALT` and the Postgres backups are
    unreadable; back them up outside these machines.
13. Everything else is generated on the host that owns it, create-once,
    0600 under `/etc/<service>/secrets/`: Neon role + cloud_admin (neon's
    play), Redis password (redis host), ClickHouse `admin`, `langfuse`, and
    interserver secrets (clickhouse-0, propagated to 1 and 2),
    `NEXTAUTH_SECRET` (regenerable: losing it only ends sessions) and the
    headless-init project key pair (app host; the pair is stored hashed in
    Postgres and its plaintext is *not* escrowed — after app-host loss the
    operator logs in with the operator-held password and mints new keys).
    Cross-host delivery is Ansible `slurp` → `set_fact` (`no_log`) →
    `template:` into an `env_file` on the consumer, never a value in a
    compose file, never through the Selmer data map (the `&#39;` trap),
    never `copy: src:` with an inline lookup.

### D. Infrastructure (OpenTofu, stage `langfuse-infrastructure`)

14. One `vultr_vpc` (`vultr-vpc-subnet`), one `vultr_ssh_key` in keygen
    mode, **four firewall groups by role** (`app`, `neon`, `redis`,
    `clickhouse`), six `vultr_instance` resources (labels per §9,
    `vpc_ids`, `prevent_destroy`, each attached to its role's group).
    Rules — a Vultr group filters the private interface too (automq
    finding), so east-west access is granted per source `/32` from the
    instances' `internal_ip` attributes, not per subnet:
    - every group: 22 from `vultr-ssh-sources`;
    - `app`: 80/443 from the resolved Cloudflare ranges;
    - `neon`: 55433 from the app host only;
    - `redis`: 6379 from the app host only;
    - `clickhouse`: 8123 and 9000 from the app host; **9000** (distributed
      queries, `clusterAllReplicas`, `remote_servers`), 9009 (interserver
      part exchange), 9181 (Keeper client), 9234 (raft) from the three
      ClickHouse nodes; nothing from Neon or Redis.
    Outputs: `params` with every host's public `ip`, `vpc_ip`, `name`,
    `role`, plus `ssh_key_id`.
15. Stage `langfuse-dns`: one Cloudflare A record `langfuse-host` → app
    host public IP, proxied.
16. `~/.ssh/config`: one block per machine, aliases `<profile>-neon`,
    `<profile>-redis`, `<profile>-app`, `<profile>-clickhouse-0..2`, all on
    the one profile keypair `~/.ssh/<profile>` (automq precedent for
    multi-machine claims). Written before the converge, removed before the
    destroy; keypair removed after it.

### E. Convergence (Ansible, stage `langfuse-ansible`, one inventory)

17. Inventory JSON: groups `neon`, `redis`, `clickhouse`, `langfuse`
    (app); host vars `ansible_host`, `vpc_ip`, `ordinal` (clickhouse),
    `ansible_user: root`. Build/dry-run use `192.0.2.x` placeholders and
    `10.50.0.1x` placeholder VPC addresses so goldens are workstation-
    independent.
18. `site.yml` order, each play flushing handlers before the next:
    1. `common.yml` (all): ufw mirrors §14 exactly — 22 open, each service
       port allowed only from the specific peer `/32`s taken from hostvars,
       default deny inbound; timezone UTC; unattended-upgrades off for the
       databases.
    2. `neon-pre.yml` (neon): install `/opt/neon/compose.override.yml`
       publishing compute on `{{ vpc_ip }}:55433` (compose merges `ports`
       lists; no `name:`, no `-f`).
    3. `neon/main.yml` — the dependency's play, unchanged.
    4. `clickhouse.yml` (clickhouse): apt repo + exact packages;
       `config.d/colors-cluster.xml` (listen 127.0.0.1 + `{{ vpc_ip }}`,
       `interserver_http_host` = vpc_ip with credentials, `remote_servers/
       default` with the three replicas from `groups['clickhouse']`
       hostvars, `zookeeper` nodes, `keeper_server` with `server_id =
       ordinal+1` and the raft peers, `macros` shard `01` / replica
       `node-{{ ordinal }}`, `default_replica_path` and
       `default_replica_name`, timezone left unset = UTC). System log
       tables: **remove exactly the six Langfuse never reads** —
       `trace_log`, `text_log`, `opentelemetry_span_log`,
       `asynchronous_metric_log`, `metric_log`, `latency_log` — and **keep
       `query_log`, `part_log`, `error_log`** with a 30-day TTL engine
       clause, because v4 reads `system.query_log*` for migration progress
       and usage detection. `users.d/colors-users.xml`: `default` loopback
       only; `admin` with `access_management`, networks = loopback plus
       the three ClickHouse-node `/32`s (it is the credential
       `remote_servers` uses between replicas, so loopback-only would fail
       every distributed query even with the firewall right); `langfuse`
       with the documented v4 grants as `<grants>` queries (tables,
       `system.parts` columns, `system.mutations`, `system.tables`,
       `system.processes`, `system.query_log*`, `READ ON REMOTE`,
       `CLUSTER`, the backfill scratch-table grants), networks = the app
       host's `/32` and loopback. Restart on change; gates: `SELECT
       count() FROM clusterAllReplicas('default', system.one)` = 3 on
       every node; an **authenticated cross-node query** from node 0
       (`SELECT hostName() FROM remote('<node-1 vpc>:9000', system.one,
       'admin', …)`) answers node 1; `SELECT timezone()` = `UTC`;
       `system.query_log` exists. Install
       `clickhouse-backup.sh`, `clickhouse-restore-check.sh`,
       `clickhouse-monitor.sh`, timers on node 0 only.
    5. `redis.yml` (redis): compose with `redis:7.2.16`, a **named volume
       on `/data`**, `--requirepass`, `--maxmemory-policy noeviction`,
       `--appendonly yes --appendfsync everysec`, published on
       `{{ vpc_ip }}:6379`; gate: `CONFIG GET maxmemory-policy` =
       noeviction, `CONFIG GET appendonly` = yes, `INFO persistence`
       reports `aof_enabled:1`, and an unauthenticated `PING` refused.
    6. `langfuse.yml` (app): Docker, compose with `langfuse-web`
       (127.0.0.1:3000), `langfuse-worker` (127.0.0.1:3030, container
       healthcheck `GET /api/health?failIfQueueConsumptionStuck=true`),
       `caddy` (80/443); `/etc/langfuse/host.env` (generated + slurped
       secrets), `/etc/langfuse/operator.env` (the storage R2 pair, the
       encryption key, salt and init password via env lookup),
       `/etc/langfuse/langfuse.env` (rendered non-secrets: `NEXTAUTH_URL`,
       `DATABASE_URL` host/port/db/user from hostvars, `CLICKHOUSE_URL=
       http://<clickhouse-0 vpc>:8123`, `CLICKHOUSE_MIGRATION_URL=
       clickhouse://<clickhouse-0 vpc>:9000`, `CLICKHOUSE_CLUSTER_ENABLED=
       true`, `REDIS_HOST/PORT`, `LANGFUSE_S3_EVENT_UPLOAD_*` /
       `MEDIA_UPLOAD_*` / `BATCH_EXPORT_*` against R2 (`REGION=auto`,
       `ENDPOINT=<neon-r2-endpoint>`, prefixes under `langfuse-s3-prefix`,
       `BATCH_EXPORT_ENABLED=true`), `LANGFUSE_INIT_*`, `TELEMETRY_ENABLED=
       false`, `LANGFUSE_CSP_ENFORCE_HTTPS=true`, `HOSTNAME=0.0.0.0`);
       Caddyfile trusting Cloudflare ranges; wait for
       `/api/public/health?failIfDatabaseUnavailable=true` = 200 and worker
       `/api/health?failIfQueueConsumptionStuck=true` = 200; install
       `langfuse-smoke`, `langfuse-status`, `langfuse-credential`,
       `langfuse-monitor`, `langfuse-rehearsal`; run `langfuse-smoke`.
    7. `backups.yml` (neon): `postgres-backup.sh` (pg_dump inside the
       compute container — Ubuntu's client is 16, compute is 17, pg_dump
       refuses the gap; n8n finding), `postgres-restore-check.sh`,
       `postgres-monitor.sh`, timers.
19. **Backup set protocol, identical for both stores.** Each run writes
    under a temporary prefix `<store>/incoming/<stamp>/`, verifies every
    uploaded object's size and sha256 by read-back, writes `manifest.txt`
    (stamp, image/version, object list with checksums and bytes), then
    writes `.complete` last and copies the set to `<store>/<stamp>/`
    (R2 has no rename; the copy is object-by-object **excluding
    `.complete`**, every final-prefix object is verified against the
    manifest by size and sha256, and only then is a **new** `.complete`
    written in the final prefix and read back — the last operation — after
    which the incoming prefix is deleted). Restore selects the newest set
    that has a non-empty `.complete` in the final prefix. Retention deletes only completed sets
    older than `langfuse-backup-retention-days` **and** only while a newer
    completed set exists; incomplete sets older than one day are deleted.
    ClickHouse: the backup token never appears in SQL. Ansible templates a
    `named_collections` entry (`r2_backup`: endpoint, key, secret) into
    `/etc/clickhouse-server/config.d/colors-backup.xml`, mode 0600 owned
    by `clickhouse`, on node 0 only, from `lookup('env', …)`; the job runs
    `BACKUP DATABASE default TO S3(r2_backup, url = '<set-url>') SETTINGS
    async = 0`, and the restore uses the same collection; the collection
    marks only `url` as overridable so a query can never substitute its
    own credentials. A converge gate asserts `system.query_log` contains
    no occurrence of the secret — the check compares a hash of each
    logged query against the secret on the host side, so the secret
    itself never enters a diagnostic query. Then
    the same manifest/marker protocol over the objects ClickHouse wrote. Postgres: `pg_dump --format=custom`
    plus the manifest. **Pairing, decided at restore time**: for a chosen
    ClickHouse set, the Postgres set is the **oldest completed dump that
    finished after** the ClickHouse set completed (with the 02:30 / 00-06
    schedules that is the 06:00 dump), so Postgres is always the newer
    snapshot. A project created at 01:00 with traces at 01:30 is then in
    both; a project created after 02:30 exists in Postgres without its
    traces (bounded, visible loss); a project deleted after 02:30 leaves
    orphan rows in ClickHouse that reference no project (harmless to the
    app, cleaned by Langfuse's own deletion jobs). If no later dump exists
    yet, the rehearsal refuses that ClickHouse set rather than pairing
    backwards. The two stores are not quiesced — pausing ingestion every
    six hours on an observability system is the wrong trade — and these
    semantics are stated in the README. **Media**: the Neon host — the one
    host holding both tokens — runs a nightly **additive** `rclone copy`
    (never `sync`, so a deletion on the live prefix is never mirrored) of
    `<profile>/media/` into `langfuse-backup/<profile>/media/`, a
    destination the app host's token cannot reach. Langfuse media objects
    are content-addressed and immutable, so an additive archive is exact;
    it is never pruned. Each run writes a manifest of the objects it
    copied (key, size, hash) under `media-runs/<stamp>/` and then runs
    `rclone check --one-way` over the **whole** destination prefix
    against the source, failing the run on any missing or differing
    object; the run's `.complete` marker is written only after that check.
    Raw events (`events/`) and exports are deliberately **not** backed
    up: Langfuse treats the events prefix as a 30-day reprocessing buffer
    whose deletion it recommends, and the system of record for traces is
    ClickHouse.
20. `cleanup.yml` (delete): stop the stacks on every host, remove nothing
    in R2.

### F. Acceptance — server side (`langfuse-smoke`, every converge)

21. Cross-host reachability by **raw TCP** from the app host to every
    dependency port (never ping), and **denial** where §14 denies (app →
    9181 refused; a `nc` from the Redis host to ClickHouse 9000 refused);
    `SELECT timezone()` on ClickHouse and `SHOW timezone` on Postgres both
    `UTC`; Keeper quorum (`system.zookeeper` root readable from node 0);
    three replicas via `clusterAllReplicas`.
22. Ingest one deterministic batch via `POST /api/public/ingestion` on
    loopback with the generated project keys — a trace, a generation
    observation, and a score, i.e. every v4 entity the restore will later
    have to show; poll `GET /api/public/traces/<id>` until 200 (≤ 120 s);
    confirm the rows in ClickHouse on node 0 **and** on node 2 (proving
    replication); confirm a **new** object under `<profile>/events/`
    beyond a pre-ingest `rclone lsf` baseline.
23. Media path, SDK-style: `POST /api/public/media` → presigned URL → `PUT`
    the bytes to R2 → `GET /api/public/media/<id>` returns a download URL
    that serves the same sha256. No CORS is involved on this path.
24. Negative space: wrong secret key → 401; no auth → 401; unauthenticated
    Redis `PING` refused; wrong ClickHouse password refused; wrong Postgres
    password refused from the app host.
25. Throughput gate: `langfuse-smoke-traces` (200) through the same path;
    all visible via the public API within `langfuse-smoke-timeout-seconds`;
    host memory below 85 %.
26. Only then the marker `<profile>/.colors-ready` lands in the storage
    bucket (read-back verified; 0-byte = absent). It means **service-ready**
    and nothing more; see §31.

### G. Acceptance — operator side (Clojure `acceptance-step`, every real create)

27. Through the **public name**: health 200 over TLS; read the project keys
    over `ssh <profile>-app`; ingest one trace and read it back through
    Cloudflare; wrong key refused. Then the SSH alias of every machine
    answers `true`.

### H. Recovery rehearsal (`langfuse-rehearsal`, build verification and on demand)

28. **Restore-and-boot, both stores together.** On node 0 select the
    newest completed ClickHouse set that has a later completed Postgres
    dump (§19 pairing rule) and derive that dump's id; on the Neon host create `langfuse_restore_check` **owned by
    the `langfuse` role** and `pg_restore` that set **as `langfuse`**
    (`--no-owner --no-acl` on a database the role owns leaves every object
    owned by the connecting role, so the scratch web, which connects as
    `langfuse`, has full privileges — verified by table ownership before
    boot); on node 0 `RESTORE DATABASE default AS restore_check FROM
    S3(<set-url>)`. Keeper path: the cluster's `default_replica_path` is
    `/clickhouse/tables/{uuid}/{shard}` and RESTORE creates the target
    tables with **new UUIDs**, so the restored replicas register under
    fresh paths; the rehearsal proves it with `SELECT zookeeper_path FROM
    system.replicas WHERE database = 'restore_check'` (all paths distinct
    from `default`'s) — if that ever fails the fallback is a scratch
    ClickHouse container on node 0 with its own embedded Keeper. Media:
    the smoke media's sha256 must exist under
    `langfuse-backup/<profile>/media/`. On the app host start a **second compose project**
    (`langfuse-restore`) with the pinned web image only, on loopback port
    3100, `DATABASE_URL` → `langfuse_restore_check`, `CLICKHOUSE_DB=
    restore_check`, `REDIS_KEY_PREFIX=restore:`, both auto-migrations
    disabled, the **operator-held** `ENCRYPTION_KEY` and `SALT`, and a
    **freshly generated** scratch `NEXTAUTH_SECRET` (the live one is
    disposable and may be gone with the host; nothing in the rehearsal
    depends on it). Prove through supported APIs: `GET /api/public/
    projects` with the live project keys → 200 (hashed keys + salt +
    Postgres), `GET /api/public/traces/<smoke id>` → 200 with the
    generation and score present (ClickHouse restore usable through the
    app), `GET /api/public/llm-connections` returns the seeded connection
    with its `displaySecretKey` (encrypted row decrypts with the operator
    key). Seeding: `langfuse-smoke` upserts one LLM connection with a
    dummy secret via `PUT /api/public/llm-connections` on every converge.
    Tear down: stop the scratch project, drop both scratch databases.
29. **Node loss**: stop ClickHouse on node 1; ingestion and reads continue;
    restart; `system.replication_queue` drains to empty.
30. **Redis restart**: with the AOF volume, `docker compose restart redis`
    keeps a queued job (enqueue with the worker stopped, restart Redis,
    start the worker, the trace lands). Redis *loss* is stated honestly:
    events accepted but not yet processed at the moment of loss stay in
    R2 as raw objects, and Langfuse documents no automated replay; the
    README says so instead of claiming replay.
31. Only after §28–§30 pass does `langfuse-rehearsal` write
    `<profile>/.colors-recovery-verified` (with the stamp of the sets it
    restored). `langfuse-status` prints both markers; automation that
    wants "recoverable" must look for the second one.
32. **Idempotence**: second `create` — tofu no changes, no container
    recreated (container ids compared), every gate passes again.
33. Neon's own rehearsals are not repeated (verified 2026-08-31 at the same
    pin); the Neon host's role here is the one n8n-vultr runs live.

### I. Monitoring (every host, systemd timer, no external sink)

34. `*-monitor.sh` on the owner host, hourly: backup-set freshness against
    the store's own threshold — `langfuse-postgres-backup-max-age-hours`
    and `langfuse-media-backup-max-age-hours` on the Neon host,
    `langfuse-clickhouse-backup-max-age-hours` on node 0 — disk ≥ 80 %,
    container restart counts, worker health with the stuck-queue flag (app),
    Keeper quorum and `replication_queue` depth (node 0), Redis
    `used_memory` and `aof_last_write_status` (redis), certificate expiry
    (app, via Caddy's admin API). Each writes `/var/lib/<service>/monitor.json`
    and a journal line; `langfuse-status` aggregates the six over SSH and
    exits non-zero on any failure. No alert sink exists in this workspace;
    the README names that gap and the `langfuse-status` cron the operator
    can wire to one.

### J. Ship

35. Commit + push `langfuse` (main), `bb pin`, commit the pin; create
    `langfuse-vultr` repo; `npx skills add` the payload, copy the launcher,
    commit + push; enable Pages on both; `workspace/repositories.json` +
    map, push; `colors-website`: recipe `langfuse.yml` (green), featured
    entry, `blog.ts` article, og cards, `pnpm typecheck && pnpm build`,
    push to main; Context Skill `langfuse-multi-node` in `getcolors/skills`
    + `type: context` recipe `langfuse-multi-node.yml`, push to main.
    Website and workspace edits happen in a throwaway local clone
    (concurrent-session rule).

## Key decisions & tradeoffs

- **Green only.** No red/blue, no parity. The catalog recipe lists one
  runtime. Reversible later by porting.
- **Neon rendered from the pin, ClickHouse owned here.** Neon's tier is
  subtle and has a verified companion; a copy would drift silently. The
  `clickhouse` package's Hetzner shape, WireGuard client path, Metabase,
  and frozen ONCE pin make it the wrong dependency; its config and users
  files are the genetic material, credited in the template headers, and
  `clickhouse/` is not modified.
- **Six machines, ~210 USD/month**, sized at Langfuse's documented minimums
  (2 CPU / 8 GiB per ClickHouse node, 2+2 CPU / 4+4 GiB for web+worker,
  Neon at the neon-vultr-proven 4c/8g, Redis at 1c/2g). Vultr plan changes
  are in-place upgrades.
- **App points at ClickHouse node 0 only.** Langfuse has no client-side
  replica failover; `CLICKHOUSE_READ_ONLY_URL` only helps compute-separated
  clusters. Node 0 is a single point of failure for the app tier while the
  data survives on all three. Stated in the README; a VIP/haproxy is out of
  scope.
- **`CLICKHOUSE_CLUSTER_ENABLED=true` with cluster name `default`** so the
  bundled migrations run `ON CLUSTER` unaided; the `langfuse` user carries
  `CLUSTER` and `READ ON REMOTE` grants as documented.
- **Role-scoped firewalls, per-`/32` east-west.** Six machines with one
  shared group would let a compromised Redis reach Keeper. Each role gets
  its own Vultr group and matching ufw rules, sourced from the actual peer
  addresses; acceptance proves a denial, not only the allows.
- **Two buckets, two scoped tokens**, state pair reaches no host. Neon and
  Langfuse blobs share `langfuse-storage` and its token in the shipped
  deployment — the operator's explicit decision (interrogation Q4), kept
  after review recommended a third bucket twice: a compromised app host
  can delete Neon layers and WAL, and the Postgres dumps in the backup
  bucket (which that host cannot reach) are what bounds that loss. The
  split is a config change (§5, §11) plus one more token, named in the
  README and in `colors.yml` as the hardening path. Node 0 and the Neon host hold
  the backup token (needed to write) — backups are deletable by those two
  hosts; R2 offers no write-only tokens. Stated.
- **Operator-held `ENCRYPTION_KEY`, `SALT`, init password.** The only way
  a backup restored onto a fresh app host is readable. Same posture n8n
  takes with its encryption key.
- **Backups with a completion protocol**: Postgres dump 6-hourly (real RPO
  for the transactional tier — a rebuilt safekeeper does not recover
  offloaded WAL), ClickHouse native BACKUP nightly through a named
  collection so no credential enters SQL or `query_log`, media copied
  additively with a whole-prefix check, all under incoming → verified →
  `.complete` → published; restore pairs a ClickHouse set with the next
  later Postgres dump. Redis persists AOF and is not backed up.
- **Restore is proven by booting the pinned image against the restored
  data and reading through the public API**, not by counting rows. That is
  the whole point of §28 and the reason the recovery marker is separate
  from the service marker.
- **No R2 lifecycle rules** anywhere: Neon shares the storage bucket.
  Event retention is a follow-up via Langfuse's own data-retention feature.
- **Media CORS is an operator prerequisite, not converge work.** R2 bucket
  CORS needs an Admin Read & Write token (Cloudflare's token table:
  Object-scoped tokens cannot edit bucket configuration), and this build
  deliberately hands no admin token to any host. The converge therefore
  proves the SDK/API media path (§23), which needs no CORS, and the README
  gives the exact CORS rule to add via dashboard or wrangler for browser
  rendering of media in the UI. `langfuse-smoke` reports whether a CORS
  preflight to the media endpoint from `https://<langfuse-host>` succeeds,
  as a warning line, so the gap is visible in status rather than silent.
- **Headless init** creates org/project/user/keys so acceptance can ingest
  without a browser; the first-run screen is never left unclaimed.
- **Deployment stays up** after verification (operator's decision).

## Toolchain

No installed skill pack matched on either bench. The build depends on the
`langfuse-docs` MCP server for documentation verification only; upstream's
Langfuse Agent Skill (instrumentation) is not loaded.

## Assumptions

Confirmed ledger (sources in brackets):

1. Tri-colour was replaced by green-only [operator].
2. Six Vultr instances, one VPC, ams, os 2284 [operator; automq template].
3. Neon templates from `getcolors/neon@87c0095`, key vocabulary preserved
   [n8n CLAUDE.md, n8n-vultr live].
4. Neon compute binds loopback; VPC publication via compose override + VPC
   firewall + ufw [neon compose.yml; automq two-firewall trap].
5. Redis 7.2, `noeviction`, `requirepass` [Langfuse cache docs].
6. Langfuse v4.27.0 (2026-09-01), digests
   web `sha256:c9e2cab8…4222b`, worker `sha256:091a85c3…5d8d`
   [GitHub releases API; registry manifest headers].
7. ClickHouse ≥ 25.12 required by v4; LTS 26.3.29.7 served by
   packages.clickhouse.com today; v4 reads `system.query_log*`,
   `system.parts`, `system.mutations`, `system.tables`, `system.processes`
   [Langfuse clickhouse docs; apt index].
8. R2 officially supported for Langfuse blob storage; Object-scoped tokens
   cannot create buckets or edit bucket configuration (CORS), so
   `langfuse-storage` and `langfuse-backup` pre-exist and CORS is set by
   the operator [blobstorage docs; Cloudflare R2 token table; n8n-vultr
   verified 2026-09-01].
9. `PUT /api/public/llm-connections` upserts an encrypted record and
   `POST /api/public/media` returns a presigned upload URL [Langfuse API
   reference; multi-modality docs].
10. `langfuse.bigconfig.online`, proxied, Cloudflare-only origin [operator].
11. Vultr firewall groups filter the private interface; Vultr's Ubuntu
    image ships ufw enabled with 22 only [automq CLAUDE.md].
12. pg_dump must run inside the compute image (client 16 vs server 17)
    [n8n-backup.sh].
13. rclone 1.60 against R2 needs `no_check_bucket` + `no_head` and never
    `rcat` [neon-single-node failure catalogue].
14. Odd apostrophe counts in Ansible shell-block comments break loading;
    quoting-heavy shell goes in installed scripts [neon/n8n].
15. `ssh -f` probes must be wrapped so the child holds /dev/null
    [neon-single-node].
16. Codex reviewer `gpt-5.6-sol`, codex-cli 0.147.0 [skill; memory].
17. Website/workspace/skills changes go straight to `main` [operator].

## Risks / open questions

- **ClickHouse `BACKUP TO S3` on R2** is unverified; §28 decides, with a
  stated fallback (`clickhouse-backup` to local disk + rclone under the
  same set protocol).
- **`RESTORE … AS restore_check`** for replicated tables on the same
  Keeper: the mechanism is the `{uuid}` in `default_replica_path` plus the
  new table UUIDs RESTORE assigns (§28); the first rehearsal proves it via
  `system.replicas`, and the fallback is a scratch ClickHouse container
  with its own embedded Keeper on node 0.
- **Prisma migrations against Neon compute** (`langfuse-web` startup):
  advisory locks and `CREATE INDEX CONCURRENTLY` are standard Postgres 17
  and expected to work; n8n's TypeORM migrations did. First live converge
  proves it.
- **VPC address stability**: Vultr assigns `internal_ip` per instance and
  keeps it for the instance's lifetime; a recreated instance gets a new
  one, which re-renders firewall rules, ufw, ClickHouse's cluster config
  and the app env — all templated from state/hostvars, so a converge heals
  it.
- **ClickHouse apt version drift**: the exact version pin fails loudly if
  the repository drops it; bump deliberately.
- **Memory on the app host** (4c/8g for web+worker+Caddy at the documented
  minimum): the 200-trace gate's memory check decides; escalation is an
  in-place plan change.
- **Alerting**: monitors exist, a sink does not. Stated.

## Out of scope

Red and blue colours; Metabase, dbt, WireGuard; SSO, SMTP, real LLM
connections and evals; Langfuse enterprise features; app-tier HA or a
ClickHouse VIP; R2 lifecycle rules; setting R2 CORS (operator step, given
in the README); Langfuse data-retention configuration; multi-shard
ClickHouse; an external alert sink; modifying the `clickhouse` or `neon`
packages; tearing the deployment down.
