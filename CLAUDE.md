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

## Shared compute library

colors-compute owns the provider registry, networking, role firewalls, SSH keys,
remote R2 or S3 state, node fan-out, and inventory collection. The package
supplies four roles with fixed counts: one Neon node, one Redis node, three
ClickHouse nodes, and one app node. The app node is the entry alias. Topology
helpers map normalized library results to the existing application inventory.

The library admits the exact peer addresses required by each role. This
package resolves the symbolic Cloudflare HTTP source list and supplies it as
application ingress. New compatible compute providers require a library version
update only. The package owns local SSH configuration and application playbooks.

Historical monolithic state and resource-address manifests are migration
evidence. The new lifecycle refuses that state before creating resources.
Updating a dependency or launcher does not transfer ownership. Rehearse and
describe require the complete observed cluster and never use build addresses.

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

All three implementations pin the same colors-compute revision. ONCE supplies
non-compute helpers; Neon supplies storage-tier templates. Keep the dependency
manifests, lockfiles, and launcher metadata consistent. Red resolves compute
through the package dependency and pins the Red SDK explicitly in the payload's
`PINS` at the commit `red/package.json` pins, because colors-compute-red declares
the SDK as a peer; `scripts/launcher.sh` checks they agree and builds the payload
from an empty cache. Green and Blue have their native immutable dependency
declarations.

Use `GREEN_LIB_ROOT`, `ONCE_LIB_ROOT`, and `LANGFUSE_LIB_ROOT` for local
package development. Neon changes require a reviewed dependency update.
After a clean pushed source commit, `cd green && bb pin` stamps the package
revision into every launcher. Deployment launchers are copies.

## Documentation

`index.html` is this repository's landing page and carries two analytics tags:
GA4 measurement ID `G-4VKP1WY4QJ`, whose explicit `page_title` must exactly
equal the decoded HTML `<title>` and stay distinct and stable, and the
self-hosted Rybbit snippet
`<script src="https://rybbit.getcolors.ai/api/script.js" data-site-id="9fb9c41a6d49" defer></script>`.
Never add one tag without the other.

## Git

Work on the current branch. Do not commit or push unless explicitly authorized.
