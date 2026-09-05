# CLAUDE.md

Guidance for agents working in this repository. Read
`~/code/getcolors/CLAUDE.md` first for the cross-repository conventions; this
file covers only what is specific to `langfuse`.

## What this is

A tri-colour Package Skill (green, red, blue): self-hosted Langfuse v4 on six Vultr machines in
one VPC — a Neon storage tier, Redis, three ClickHouse replicas with Keeper,
and the application host behind Caddy and Cloudflare. The first consumer is
`../langfuse-vultr`. `plans/0001-langfuse-v1.md` is the locked plan and its
review log is the argument; code and tests are authoritative.

## Two things to understand before anything else

**The Neon tier is rendered from a pin, the ClickHouse tier is owned here.**
`green/deps.edn` SHA-pins `getcolors/neon` and `tools/neon-specs` renders twelve of
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

## The cluster is ONCE's

The six machines are delegated to ONCE's `compute-cluster` namespace per
`../workspace/standards/compute-cluster.md`. `topology.clj` (`topology.ts`,
`topology.py`) owns the `compute-providers` registry and the `spec` — four
roles in play order with fixed counts (`neon` 1, `redis` 1, `clickhouse` 3,
`app` 1), the app host as the entry the bare `<profile>` alias reaches, a
`:created` network from `vultr-vpc-subnet`, `ssh-sources` as the one source
list, and the pre-adoption fallback offsets 10, 11, 20 and 12 so the goldens
kept their addresses — and calls ONCE for the node ids, the fallbacks a
`build` renders with, the aliases, the ssh-config hosts, the compute checks
and their messages, `read-state`, `resolved-cluster` and `adopt-state`.
`vultr-http-sources` is deliberately not one of the spec's sources: it
accepts the symbolic `cloudflare`, which this package resolves itself, and
`:clickhouse-nodes must be 3` stays a package validator.

The adopted cluster lives at `:once/cluster`; the package's `hosts` wrapper
respells ONCE's `:vpc_ip` as the `:vpc-ip` the renderers read and blanks a
singleton's index (ONCE numbers every node from 0; the inventory writes an
`ordinal` for the replicas alone), so no template changed beyond the `params`
output. Every resource block, count and `for_each` in that template is pinned
by the two configuration-address manifests `scripts/golden.sh` diffs
(`test/resources/resource-addresses-{keygen,optout}.txt`), which `--accept`
never regenerates: `langfuse-vultr` is live, and a moved address is a
destroyed machine. The reader `workflow/state-output` translates the live
deployment's pre-adoption state — `hosts` with `index: null` on the
singletons and no `provider` — into `nodes` before ONCE sees it; its next
converge plans an output change only. Delete, rehearse and describe now fail
closed on a backend they cannot read and on a state that does not describe
every machine, where they once swallowed the read. Do not copy a
`compute-cluster` function into this package.

## Commands

The three implementations live in the tri-colour layout, matching `n8n`
and `neon`: canonical Clojure in `green/`, TypeScript/Bun in `red/`,
Python/uv in `blue/`. Green is canonical: a behavioural change lands in all
three colours in the same commit and passes `scripts/parity.sh`, which
renders both fixtures through every colour and diffs the trees — and the
colour template trees (`red/resources`, blue's embedded `resources/`) —
byte for byte. The neon subtree is the exception: never copied, rendered by
each colour out of its own SHA-pinned neon dependency. Fixtures and goldens
are shared at the repository root (`test/fixtures/`, `test/resources/golden/`)
with symlinks from `green/test/`. Each colour dir holds a launcher symlink to
its skill payload.

```sh
cd green && bb test
cd green && bb golden      # two fixtures: keygen and opt-out
cd green && bb golden:accept   # only after reading the diff
cd green && bb syntax      # offline ansible-playbook --syntax-check
cd red && bun test && bun run typecheck
cd blue && uv run pytest
./scripts/parity.sh        # three colours, two fixtures, byte for byte
./scripts/launcher.sh      # from the repository root
cd green && ./green build
cd green && ./green create --dry-run
cd green && ./green create # requires explicit authorization
cd green && ./green rehearse   # against a live deployment
cd green && ./green delete # guarded and destructive
```

Never read `.envrc.private`, edit `.colors/`, export `COLORS_PAR_PROFILE`, or
weaken `compute-prevent-destroy`. Build and dry-run are credential-free and
must not touch `~/.ssh`.

## Coupling

The package pins Green (never below `3f33f5d`, where a tofu launch failure
became the step error ONCE's `read-state` relies on), ONCE (never below
`b1628b7`, where `compute-cluster` landed, nor `bc06f2f` before it) and neon in
`green/deps.edn`, the Red SDK, `package-once-red` and `package-neon-red` in
`red/package.json`, and the Blue SDK, `package-once-blue` and
`package-neon-blue` in `blue/pyproject.toml`. All three colours pin ONCE and
neon at the **same rev**; `scripts/launcher.sh` checks the neon pin across
`green/deps.edn`, `red/package.json`, `blue/pyproject.toml` and the red
payload's `PINS`, and the ONCE pin across those and the blue payload's PEP 723
block too; `bb pin` writes only this package's own SHA, so a neon bump is four
hand edits and an ONCE bump five. Use `GREEN_LIB_ROOT`, `ONCE_LIB_ROOT` and
`LANGFUSE_LIB_ROOT` (the repository root, for every colour) for working-tree
development; there is no `NEON_LIB_ROOT` — a neon change means moving the
pin. `cd green && bb pin` stamps all three payloads from a clean pushed HEAD;
deployment launchers are copies, not symlinks.

## Documentation

`index.html` is this repository's landing page and carries two analytics tags:
GA4 measurement ID `G-4VKP1WY4QJ`, whose explicit `page_title` must exactly
equal the decoded HTML `<title>` and stay distinct and stable, and the
self-hosted Rybbit snippet
`<script src="https://rybbit.getcolors.ai/api/script.js" data-site-id="9fb9c41a6d49" defer></script>`.
Never add one tag without the other.

## Git

Work on the current branch. Do not commit or push unless explicitly authorized.
