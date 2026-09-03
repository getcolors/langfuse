#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
launcher="$root/skills/package-langfuse-green/green"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
checks=0
fail(){ echo "launcher: FAIL — $*" >&2; exit 1; }
ok(){ checks=$((checks+1)); echo "  ok — $*"; }

[ -f "$launcher" ] || fail 'payload launcher is missing'
grep -q 'io.github.getcolors.langfuse.workflow/workflow' "$launcher" || fail 'workflow dispatch is missing'
for bad in 'defn.*-step' 'tofu/' 'ansible/'; do
  ! grep -qE "$bad" "$launcher" || fail "launcher contains package logic: $bad"
done
ok 'dispatches to the library and contains no lifecycle logic'

grep -qE '\(def \^:private langfuse-sha (nil|"[0-9a-f]{40}")\)' "$launcher" || fail 'invalid pin site'
[[ $(grep -c 'def \^:private langfuse-sha' "$launcher") == 1 ]] || fail 'more than one pin site'
ok 'has one managed immutable pin site'

mkdir "$tmp/bare"
cp "$launcher" "$tmp/bare/green"; chmod +x "$tmp/bare/green"
if grep -q '(def \^:private langfuse-sha nil)' "$launcher"; then
  out=$(cd "$tmp/bare" && ./green build 2>&1 || true)
  grep -q LANGFUSE_LIB_ROOT <<<"$out" || fail 'an unpinned launcher did not explain LANGFUSE_LIB_ROOT'
  ok 'unstamped payload fails with an actionable working-tree override'
else
  ok 'payload carries a real package commit pin'
fi

mkdir "$tmp/project"
cp "$launcher" "$tmp/project/green"; chmod +x "$tmp/project/green"
sed "s#WORKDIR#.colors#" "$root/test/fixtures/colors.yml" > "$tmp/project/colors.yml"
(cd "$tmp/project" && LANGFUSE_LIB_ROOT="$root" ./green build >/dev/null) || fail 'LANGFUSE_LIB_ROOT build failed'
[ -f "$tmp/project/.colors/langfuse-fixture/langfuse-infrastructure/main.tf" ] || fail 'copied payload rendered nothing'
[ -f "$tmp/project/.colors/langfuse-fixture/langfuse-dns/main.tf" ] || fail 'no dns stage'
[ -f "$tmp/project/.colors/langfuse-fixture/langfuse-ansible/site.yml" ] || fail 'no ansible stage'
[ -f "$tmp/project/.colors/langfuse-fixture/langfuse-ansible/neon/compose.yml" ] || fail 'the neon bundle did not render from the dependency'
ok 'working-tree override renders from a copied payload'
mkdir -p "$tmp/project/deep/path"
(cd "$tmp/project/deep/path" && LANGFUSE_LIB_ROOT="$root" ../../green build >/dev/null) || fail 'upward desired-state search failed'
ok 'finds colors.yml by walking upward'

out=$(cd "$tmp/project" && LANGFUSE_LIB_ROOT="$root" COLORS_PAR_PROFILE=wrong ./green build 2>&1 || true)
grep -q COLORS_PAR_PROFILE <<<"$out" || fail 'COLORS_PAR_PROFILE was not refused'
[[ ! -d "$tmp/project/.colors/wrong" ]] || fail 'a profile overlay rendered a stage'
ok 'refuses the profile overlay'

out=$(cd "$tmp/project" && LANGFUSE_LIB_ROOT="$root" ./green nonsense 2>&1 || true)
grep -q Usage <<<"$out" || fail 'unknown command has no usage'
for verb in build create delete rehearse describe; do
  grep -q "\"$verb\"" "$launcher" || fail "missing command $verb"
done
ok 'lifecycle, rehearsal and describe commands are dispatchable'

[ -L "$root/green/green" ] && [ "$(readlink "$root/green/green")" = ../skills/package-langfuse-green/green ] || fail 'green/green is not the payload symlink'
ok 'colour launcher is the payload symlink'

# --- the red and blue payloads, statically ---------------------------------
# Red and blue reproduce green's goldens byte for byte (scripts/parity.sh);
# what is checked here is the payload shape a deployment installs: each
# launcher names its package, carries exactly the pin form `bb pin` rewrites,
# and is the file its colour directory symlinks to.
red_launcher="$root/skills/package-langfuse-red/red"
blue_launcher="$root/skills/package-langfuse-blue/blue"
[ -f "$red_launcher" ] || fail 'red payload launcher is missing'
[ -f "$blue_launcher" ] || fail 'blue payload launcher is missing'
grep -q 'package-langfuse-red' "$red_launcher" || fail 'red launcher does not name its package'
grep -q 'package_langfuse_blue' "$blue_launcher" || fail 'blue launcher does not name its package'
[[ $(grep -c '"package-langfuse-red":' "$red_launcher") == 1 ]] || fail 'red launcher has more than one pin site'
ok 'red and blue payloads name their packages and carry one pin site each'

# Red and blue, end to end from a copy: the verbs live in each package's CLI,
# not in the launcher, so the check is a build from outside the repository
# that must reproduce green's committed golden byte for byte.
for colour in red blue; do
  mkdir -p "$tmp/$colour"
  cp "$root/skills/package-langfuse-$colour/$colour" "$tmp/$colour/$colour"; chmod +x "$tmp/$colour/$colour"
  sed "s#WORKDIR#.colors#" "$root/test/fixtures/colors.yml" > "$tmp/$colour/colors.yml"
  (cd "$tmp/$colour" && LANGFUSE_LIB_ROOT="$root" "./$colour" build >/dev/null 2>&1) || fail "$colour: LANGFUSE_LIB_ROOT build failed from a copied payload"
  diff -r "$root/test/resources/golden/local/langfuse-fixture" "$tmp/$colour/.colors/langfuse-fixture" >/dev/null \
    || fail "$colour: a copied payload rendered something other than the golden"
  out=$(cd "$tmp/$colour" && LANGFUSE_LIB_ROOT="$root" COLORS_PAR_PROFILE=wrong "./$colour" build 2>&1 || true)
  grep -q COLORS_PAR_PROFILE <<<"$out" || fail "$colour: COLORS_PAR_PROFILE was not refused"
  ok "$colour: copied payload renders the golden and refuses the profile overlay"
done

# Every colour resolves the storage tier at the same commit as green's
# deps.edn. Four records of one pin is the price of three runtimes; their
# drifting apart is what parity.sh would then fail on, far from the cause.
neon_sha=$(awk '/neon\.git/ {found=1} found && match($0, /:git\/sha "[0-9a-f]{40}"/) {print substr($0, RSTART+10, 40); exit}' "$root/green/deps.edn")
[ -n "$neon_sha" ] || fail 'green/deps.edn carries no neon pin'
grep -q "getcolors/neon#$neon_sha" "$root/red/package.json" || fail 'red/package.json neon pin differs from green'
grep -q "rev = \"$neon_sha\"" "$root/blue/pyproject.toml" || fail 'blue/pyproject.toml neon pin differs from green'
grep -q "getcolors/neon#$neon_sha" "$red_launcher" || fail 'red payload PINS neon pin differs from green'
ok 'the neon pin agrees in green, red, blue, and the red payload'

[ -L "$root/red/red" ] && [ "$(readlink "$root/red/red")" = ../skills/package-langfuse-red/red ] || fail 'red/red is not the payload symlink'
[ -L "$root/blue/blue" ] && [ "$(readlink "$root/blue/blue")" = ../skills/package-langfuse-blue/blue ] || fail 'blue/blue is not the payload symlink'
ok 'red and blue colour launchers are the payload symlinks'
echo "launcher: $checks checks passed"
