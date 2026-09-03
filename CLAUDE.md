# CLAUDE.md

Guidance for agents working in this repository. Read
`~/code/getcolors/CLAUDE.md` first for the cross-repository conventions; this
file covers only what is specific to `langfuse`.

## What this is

A green-only Package Skill: self-hosted Langfuse v4 on six Vultr machines in
one VPC — a Neon storage tier, Redis, three ClickHouse replicas with Keeper,
and the application host behind Caddy and Cloudflare. The first consumer is
`../langfuse-vultr`. `plans/0001-langfuse-v1.md` is the locked plan and its
review log is the argument; code and tests are authoritative.

## Two things to understand before anything else

**The Neon tier is rendered from a pin, the ClickHouse tier is owned here.**
`deps.edn` SHA-pins `getcolors/neon` and `tools/neon-specs` renders twelve of
its templates into a `neon/` subdirectory of the ansible stage — never copied,
never edited, and `colors.yml` speaks neon's key vocabulary (`neon-r2-bucket`,
`neon-tenant-id`, …) for exactly that reason. The only thing this package
adds to the Neon host is `compose.override.yml`, installed *before* the
dependency's play so its own `up -d compute` applies it. The ClickHouse
templates are derived from `getcolors/clickhouse` and maintained as this
package's own: that package is a Hetzner shape with WireGuard, Metabase and
static addresses baked into its config. Re-read its files when bumping
`clickhouse-version`; nothing follows automatically.

**Six hosts, one inventory, secrets that cross hosts as facts.** Every
address is a HOST var in `inventory.json`; no group carries variables. The
plays read peers through `hostvars` (the ClickHouse config lists the three
replicas, the app env points at node 0, ufw admits the app host's `/32`). The
passwords each tier generates are read where they live with `slurp` and
`delegate_to`, held under `no_log`, and written into the consumer's env file
— an Ansible lookup could not do this, because lookups run on the controller.

## What fails silently here, and the traps already paid for

- **Two firewalls.** A Vultr firewall group filters the private interface
  too, selectively (ICMP passes, TCP does not), and the image ships ufw
  enabled with 22 alone. Each role has its own group and ufw mirrors it;
  east-west rules are per-peer `/32`, and the smoke gate asserts a denial.
- **`count`, not `for_each`, over peer addresses in tofu.** Addresses are
  known only after apply; a `for_each` keyed on them fails the plan.
- **Langfuse's migrations run `ON CLUSTER default`.** The validator refuses
  any other cluster name.
- **`query_log` stays.** The six system log tables Langfuse never reads are
  removed; v4 reads `system.query_log*` and the config keeps it with a TTL.
- **No credential in SQL.** ClickHouse backups go to a disk whose credentials
  sit in `config.d/colors-backup.xml`; a gate greps `query_log` for the
  secret on the host, never by passing the secret into a query.
- **Secrets never reach rendered output.** Operator credentials appear in
  plays as literal `{{ lookup('env', …) }}` expressions that
  `preserve-jinja-delimiters` passes through; `scripts/golden.sh` fails if
  those expressions stop appearing. Routing them through the Selmer data map
  would HTML-escape the quotes.
- **`ansible.builtin.copy` with `src:` does not template.** Host-specific
  files (the Neon overlay, the ClickHouse config and users, the Redis
  compose, `langfuse.env`) go through `template:`; static scripts through
  `copy:`.
- **Ansible splits shell blocks before running them**, counting braces and
  quotes across comments. Quoting-heavy shell lives in installed scripts;
  the one `{{`-detection grep builds its pattern with octal escapes.
- **The pairing rule is decided at restore time**, not at backup time: a
  ClickHouse set pairs with the oldest Postgres dump completed *after* it.
  Reversing that pairs a newer ClickHouse snapshot with an older Postgres
  one and orphans projects.
- **`rclone copy`, never `sync`, for the media archive.**

## Verbs beyond the lifecycle

`rehearse` runs `rehearsal.yml` against the hosts in state: fresh sets,
restore-and-boot in a second Compose project on the app host, the
replica-loss and Redis-restart drills, then `.colors-recovery-verified`.
`describe` reads every host's monitor result over the generated SSH aliases.
Both need a converged deployment and refuse to run without compute in state.

## The SSH keypair and `~/.ssh/config`

Born conforming to three workspace standards. Read
`../workspace/standards/ssh-keypair.md` before touching `ssh.clj`,
`../workspace/standards/ssh-config.md` before touching `ssh_config.clj`, and
`../workspace/standards/compute-name.md` for why there is no required
`vultr-name`. One keypair for six machines; the managed block carries the
bare profile (the app host) and one alias per machine. Build and dry-run
render `/home/build-placeholder/.ssh/<profile>` rather than reading `~/.ssh`.

## Commands

```sh
bb test
bb golden                  # two fixtures: keygen and opt-out
bb golden:accept           # only after reading the diff
bb syntax                  # offline ansible-playbook --syntax-check
./scripts/launcher.sh
./green build
./green create --dry-run
./green create             # requires explicit authorization
./green rehearse           # against a live deployment
./green delete             # guarded and destructive
```

Never read `.envrc.private`, edit `.colors/`, export `COLORS_PAR_PROFILE`, or
weaken `compute-prevent-destroy`. Build and dry-run are credential-free and
must not touch `~/.ssh`.

## Coupling

`deps.edn` pins Green, ONCE (never below `bc06f2f`) and neon. Use
`GREEN_LIB_ROOT`, `ONCE_LIB_ROOT` and `LANGFUSE_LIB_ROOT` for working-tree
development; there is no `NEON_LIB_ROOT` — a neon change means moving the
pin. `bb pin` stamps the payload from a clean pushed HEAD; deployment
launchers are copies, not symlinks.

## Documentation

`index.html` is this repository's landing page and carries two analytics tags:
GA4 measurement ID `G-4VKP1WY4QJ`, whose explicit `page_title` must exactly
equal the decoded HTML `<title>` and stay distinct and stable, and the
self-hosted Rybbit snippet
`<script src="https://rybbit.getcolors.ai/api/script.js" data-site-id="9fb9c41a6d49" defer></script>`.
Never add one tag without the other.

## Git

Work on the current branch. Do not commit or push unless explicitly authorized.
