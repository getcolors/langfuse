#!/usr/bin/env bash
set -euo pipefail

# One desired state, three colours, byte for byte. golden.sh is green's
# regression net against the committed goldens; this is the net across colours:
# each fixture is rendered by green, red, and blue into separate work
# directories and the trees must be identical — and the template trees each
# colour carries must be identical too, because the copies are the mechanism
# (red/resources and blue's embedded resources are copies of green's tree, not
# references to it).
#
# The storage tier is the exception, and deliberately so: its templates are
# never copied into any colour. Each renders them out of the SHA-pinned
# getcolors/neon dependency — green off the classpath, red out of the installed
# package's red/resources, blue out of package_neon_blue/resources — so the
# `neon/` subdirectory of the rendered tree is what proves all three resolved
# the same pin. Keep that pin equal in green/deps.edn, red/package.json and
# blue/pyproject.toml; a diff here is the first thing that shows when it drifts.
#
# Two fixtures, because the SSH Keypair Standard has two modes and parity means
# both keygen and opt-out hold in every colour.
#
# Renders resolve each colour's package from this working tree (the *_LIB_ROOT
# overrides), while green, once, neon, red, and blue stay on their pins — a
# change that lands here passes parity before it is pushed or pinned anywhere.

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

build_variant() {
  local variant=$1
  for colour in green red blue; do
    sed "s#WORKDIR#$tmp/$variant/$colour#" "$root/test/fixtures/$variant.yml" \
      > "$tmp/$variant-$colour.yml"
  done
  (cd "$root/green" && LANGFUSE_LIB_ROOT="$root" ./green build -f "$tmp/$variant-green.yml" >/dev/null)
  (cd "$root/red" && LANGFUSE_LIB_ROOT="$root/red" ./red build -f "$tmp/$variant-red.yml" >/dev/null)
  (cd "$root/blue" && uv run python -m package_langfuse_blue build -f "$tmp/$variant-blue.yml" >/dev/null)
  diff -r "$tmp/$variant/green" "$tmp/$variant/red"
  diff -r "$tmp/$variant/green" "$tmp/$variant/blue"
}

build_variant colors
build_variant optout

diff -r "$root/green/src/resources/io/github/getcolors/langfuse" "$root/red/resources"
diff -r "$root/green/src/resources/io/github/getcolors/langfuse" "$root/blue/src/package_langfuse_blue/resources"

echo "green, red, and blue langfuse artifacts are byte-identical"
