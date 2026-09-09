#!/usr/bin/env bash
set -euo pipefail

# Render shared and per-node library plans plus application artifacts.
# Historical monolithic address manifests remain migration evidence; builds
# refuse those live state keys and cannot silently adopt or overwrite them.
# --accept updates reviewed goldens; --regenerate-manifests is retained as a
# compatibility alias for validation and does not rewrite historical records.

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

accept=0; regen=0
case ${1:-} in
  --accept) accept=1 ;;
  --regenerate-manifests) regen=1 ;;
  '') ;;
  *) echo "usage: $0 [--accept|--regenerate-manifests]" >&2; exit 2 ;;
esac

status=0
for backend in s3 r2; do
for variant in colors optout; do
  fixture="$tmp/$variant.yml"
  sed "s#WORKDIR#$tmp/work#" "$root/test/fixtures/$variant.yml" > "$fixture"
  (cd "$root/green" && LANGFUSE_LIB_ROOT="$root" COLORS_PAR_PROVIDER_BACKEND="$backend" ./green build -f "$fixture" >/dev/null)

  profile=$(sed -n 's/^profile: //p' "$fixture")
  actual="$tmp/work/$profile"
  golden="$root/test/resources/golden/$backend/$profile"

  # No rendered artefact may carry a real secret into a committed golden.
  if grep -rEq 'BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY|github_pat_|ghp_|gho_|ghu_|ghs_|ghr_' "$actual"; then
    echo "golden: a credential-shaped value was rendered in $profile" >&2; exit 1
  fi
  # Every operator secret must reach a host as an Ansible lookup resolved at
  # execution time, never as a value templated into generated output.
  for par in NEON_R2_ACCESS_KEY_ID NEON_R2_SECRET_ACCESS_KEY; do
    grep -q "lookup('env','COLORS_PAR_$par')" "$actual/langfuse-ansible/neon/main.yml" \
      || { echo "golden: $profile no longer renders COLORS_PAR_$par as a lookup" >&2; exit 1; }
  done
  for par in LANGFUSE_SALT LANGFUSE_ENCRYPTION_KEY LANGFUSE_INIT_USER_PASSWORD LANGFUSE_STORAGE_R2_ACCESS_KEY_ID LANGFUSE_STORAGE_R2_SECRET_ACCESS_KEY; do
    grep -q "lookup('env','COLORS_PAR_$par')" "$actual/langfuse-ansible/langfuse.yml" \
      || { echo "golden: $profile no longer renders COLORS_PAR_$par as a lookup" >&2; exit 1; }
  done
  for f in backups.yml clickhouse.yml clickhouse-backup.xml; do
    grep -q "lookup('env','COLORS_PAR_LANGFUSE_BACKUP_R2_SECRET_ACCESS_KEY')" "$actual/langfuse-ansible/$f" \
      || { echo "golden: $profile: $f no longer renders the backup credential as a lookup" >&2; exit 1; }
  done

  # Every rendered ClickHouse XML file must be well-formed. A double dash
  # inside an XML comment cost a live converge: ClickHouse fails to start with
  # `SAXParseException: Invalid token`, on all three nodes, from a comment.
  for x in "$actual"/langfuse-ansible/clickhouse-*.xml; do
    python3 -c 'import sys, xml.dom.minidom; xml.dom.minidom.parse(sys.argv[1])' "$x" \
      || { echo "golden: $x is not well-formed XML" >&2; exit 1; }
  done

  # The storage tier arrives from the dependency, in its own subdirectory.
  [[ -f "$actual/langfuse-ansible/neon/compose.yml" ]] || { echo "golden: $profile has no neon/ bundle" >&2; exit 1; }
  # Library-owned split states; old monolithic manifests remain migration evidence.
  python3 "$root/scripts/check-compute-plan.py" "$actual/compute" "$variant"

  # A build that reached the real ~/.ssh would leak the operator's home into
  # committed bytes and make the goldens workstation-specific.
  if grep -rq "$HOME/.ssh" "$actual"; then
    echo "golden: $profile rendered a real home directory; build must use the placeholder" >&2; exit 1
  fi
  # SSH Config Standard §6: the local stage takes the addresses as extra-vars,
  # never through Selmer, so its rendered playbook carries no address at all.
  if grep -rEq '([0-9]{1,3}\.){3}[0-9]{1,3}' "$actual/langfuse-ansible-local"; then
    echo "golden: $profile rendered an address into the local ssh_config stage" >&2; exit 1
  fi

  if [[ $accept == 1 ]]; then
    rm -rf "$golden"; mkdir -p "$(dirname "$golden")"; cp -a "$actual" "$golden"; continue
  fi
  [[ -d "$golden" ]] || { echo "golden missing for $profile; inspect build then run bb golden:accept" >&2; exit 1; }
  diff -ru "$golden" "$actual" || status=1
done
done

[[ $status == 0 ]] && echo 'all Langfuse goldens and safety assertions pass'
exit "$status"
