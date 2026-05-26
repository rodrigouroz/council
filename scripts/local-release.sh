#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/local-release.sh [--install-local] [--tag vX.Y.Z]

Build and validate the Council skill zip locally.

Options:
  --install-local  Install the generated zip into ${CODEX_HOME:-$HOME/.codex}/skills.
  --tag TAG        Create or update a GitHub Release for TAG with council-skill.zip.
  -h, --help       Show this help text.
USAGE
}

install_local=false
release_tag=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-local)
      install_local=true
      shift
      ;;
    --tag)
      if [[ $# -lt 2 ]]; then
        echo "error: --tag requires a value" >&2
        exit 2
      fi
      release_tag="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
helper_dir="$repo_root/skill/council/scripts"
zip_path="$repo_root/skill/council/dist/council-skill.zip"

cd "$helper_dir"
npm ci
npm run typecheck
npm test
npm run check-dist
npm run package

if [[ ! -f "$zip_path" ]]; then
  echo "error: expected package was not created: $zip_path" >&2
  exit 1
fi

echo
echo "Built $zip_path"

if [[ "$install_local" == true ]]; then
  skills_dir="${CODEX_HOME:-$HOME/.codex}/skills"
  mkdir -p "$skills_dir"
  rm -rf "$skills_dir/council"
  unzip -q "$zip_path" -d "$skills_dir"
  echo "Installed Council skill to $skills_dir/council"
fi

if [[ -n "$release_tag" ]]; then
  if ! command -v gh >/dev/null 2>&1; then
    echo "error: gh is required for --tag release upload" >&2
    exit 1
  fi

  cd "$repo_root"
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "error: refusing to create a release from a dirty worktree" >&2
    echo "commit or stash local changes before using --tag" >&2
    exit 1
  fi

  if ! git rev-parse -q --verify "refs/tags/$release_tag" >/dev/null; then
    git tag "$release_tag"
    git push origin "$release_tag"
  fi

  if gh release view "$release_tag" >/dev/null 2>&1; then
    gh release upload "$release_tag" "$zip_path" --clobber
  else
    gh release create "$release_tag" "$zip_path" --title "$release_tag" --notes "Council skill release $release_tag"
  fi
  echo "Uploaded $zip_path to GitHub Release $release_tag"
fi

if [[ "$install_local" == false && -z "$release_tag" ]]; then
  cat <<EOF

Next options:
  Install locally:
    scripts/local-release.sh --install-local

  Upload a GitHub Release asset:
    scripts/local-release.sh --tag v0.1.0
EOF
fi
