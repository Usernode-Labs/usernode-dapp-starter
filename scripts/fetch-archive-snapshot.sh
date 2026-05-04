#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGER="$SCRIPT_DIR/package-archive-snapshot.sh"

DEFAULT_REMOTE_SOURCE="~/.coolify-volumes/storage/shared/archive"
DEFAULT_REMOTE_WORK_DIR="/tmp"
DEFAULT_LOCAL_TAR_DIR="${TMPDIR:-/tmp}/usernode-archive-packages"
DEFAULT_EXTRACT_DIR="$HOME/.usernode/archive"

usage() {
  cat <<'EOF'
Usage: scripts/fetch-archive-snapshot.sh SERVER [EXTRACT_DIR] [options]
       scripts/fetch-archive-snapshot.sh --server SERVER [options]

Runs the archive packager on a remote server, copies the tarball locally, and
extracts it into a local archive directory suitable for --archive-path.

Arguments:
  SERVER        SSH target, for example user@example.com.
  EXTRACT_DIR   Local archive directory to write. Defaults to ~/.usernode/archive.

Options:
  --server SERVER          SSH target. Alternative to positional SERVER.
  --remote-source PATH     Remote archive root or chain directory.
                           Default: ~/.coolify-volumes/storage/shared/archive
  --remote-work-dir PATH   Remote temp/output parent directory. Default: /tmp
  --local-tar-dir PATH     Local directory where the tarball is copied.
                           Default: ${TMPDIR:-/tmp}/usernode-archive-packages
  --extract-dir PATH       Local archive directory to write.
  --replace                Replace a non-empty existing EXTRACT_DIR.
  --no-extract             Copy the tarball but do not extract it.
  --keep-remote            Keep the remote temp directory and tarball.
  --ssh-port PORT          SSH port.
  --identity-file PATH     SSH identity file.
  --ssh-option OPT         Extra ssh/scp -o option. Repeatable.
  -h, --help               Show this help.

Examples:
  scripts/fetch-archive-snapshot.sh ubuntu@archive.example.com --replace
  scripts/fetch-archive-snapshot.sh ubuntu@archive.example.com /tmp/usernode-archive
  scripts/fetch-archive-snapshot.sh --server ubuntu@host --remote-source /data/archive --extract-dir ~/.usernode/archive --replace
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >&2
}

expand_local_path() {
  local path="$1"
  if [[ "$path" == "~" ]]; then
    printf '%s\n' "$HOME"
  elif [[ "$path" == "~/"* ]]; then
    printf '%s/%s\n' "$HOME" "${path#~/}"
  else
    printf '%s\n' "$path"
  fi
}

dir_is_empty() {
  local dir="$1"
  [[ -d "$dir" ]] || return 1
  [[ -z "$(find "$dir" -mindepth 1 -maxdepth 1 -print -quit)" ]]
}

assert_safe_extract_dir() {
  local dir="$1"
  [[ -n "$dir" ]] || die "empty extract directory"
  [[ "$dir" != "/" ]] || die "refusing to replace /"
  [[ "$dir" != "$HOME" ]] || die "refusing to replace HOME directory: $dir"
}

server=""
remote_source="$DEFAULT_REMOTE_SOURCE"
remote_work_dir="$DEFAULT_REMOTE_WORK_DIR"
local_tar_dir="$DEFAULT_LOCAL_TAR_DIR"
extract_dir="$DEFAULT_EXTRACT_DIR"
replace=0
no_extract=0
keep_remote=0
ssh_opts=()
scp_opts=()
positionals=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --server)
      [[ $# -ge 2 ]] || die "--server requires a value"
      server="$2"
      shift 2
      ;;
    --remote-source)
      [[ $# -ge 2 ]] || die "--remote-source requires a value"
      remote_source="$2"
      shift 2
      ;;
    --remote-work-dir)
      [[ $# -ge 2 ]] || die "--remote-work-dir requires a value"
      remote_work_dir="$2"
      shift 2
      ;;
    --local-tar-dir)
      [[ $# -ge 2 ]] || die "--local-tar-dir requires a value"
      local_tar_dir="$2"
      shift 2
      ;;
    --extract-dir)
      [[ $# -ge 2 ]] || die "--extract-dir requires a value"
      extract_dir="$2"
      shift 2
      ;;
    --replace)
      replace=1
      shift
      ;;
    --no-extract)
      no_extract=1
      shift
      ;;
    --keep-remote)
      keep_remote=1
      shift
      ;;
    --ssh-port)
      [[ $# -ge 2 ]] || die "--ssh-port requires a value"
      ssh_opts+=(-p "$2")
      scp_opts+=(-P "$2")
      shift 2
      ;;
    --identity-file)
      [[ $# -ge 2 ]] || die "--identity-file requires a value"
      ssh_opts+=(-i "$2")
      scp_opts+=(-i "$2")
      shift 2
      ;;
    --ssh-option)
      [[ $# -ge 2 ]] || die "--ssh-option requires a value"
      ssh_opts+=(-o "$2")
      scp_opts+=(-o "$2")
      shift 2
      ;;
    --)
      shift
      while [[ $# -gt 0 ]]; do
        positionals+=("$1")
        shift
      done
      ;;
    -*)
      die "unknown option: $1"
      ;;
    *)
      positionals+=("$1")
      shift
      ;;
  esac
done

if [[ -z "$server" && ${#positionals[@]} -gt 0 ]]; then
  server="${positionals[0]}"
  positionals=("${positionals[@]:1}")
fi
if [[ ${#positionals[@]} -gt 0 ]]; then
  extract_dir="${positionals[0]}"
  positionals=("${positionals[@]:1}")
fi
if [[ ${#positionals[@]} -gt 0 ]]; then
  die "unexpected positional arguments: ${positionals[*]}"
fi

[[ -n "$server" ]] || die "missing SERVER"
[[ -f "$PACKAGER" ]] || die "archive packager not found: $PACKAGER"

local_tar_dir="$(expand_local_path "$local_tar_dir")"
extract_dir="$(expand_local_path "$extract_dir")"

ssh_remote() {
  if (( ${#ssh_opts[@]} )); then
    ssh "${ssh_opts[@]}" "$server" "$@"
  else
    ssh "$server" "$@"
  fi
}

scp_copy() {
  if (( ${#scp_opts[@]} )); then
    scp "${scp_opts[@]}" "$@"
  else
    scp "$@"
  fi
}

run_remote_script() {
  local script="$1"
  shift
  ssh_remote bash -s -- "$@" <<<"$script"
}

REMOTE_CLEANUP_SCRIPT='set -euo pipefail
rm -rf -- "$1"
'

REMOTE_MKTEMP_SCRIPT='set -euo pipefail
base="$1"
case "$base" in
  "~") base="$HOME" ;;
  "~/"*) base="$HOME/${base#~/}" ;;
esac
mkdir -p "$base"
mktemp -d "$base/usernode-archive-fetch.XXXXXX"
'

REMOTE_PACKAGE_SCRIPT='set -euo pipefail
stage="$1"
source="$2"
chmod +x "$stage/package-archive-snapshot.sh"
"$stage/package-archive-snapshot.sh" "$source" "$stage"
'

remote_stage=""
extract_tmp=""

cleanup() {
  if [[ -n "${extract_tmp:-}" && -d "$extract_tmp" ]]; then
    rm -rf "$extract_tmp"
  fi
  if [[ -n "${remote_stage:-}" && "$keep_remote" -eq 0 ]]; then
    run_remote_script "$REMOTE_CLEANUP_SCRIPT" "$remote_stage" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

log "Creating remote working directory on $server"
remote_stage="$(run_remote_script "$REMOTE_MKTEMP_SCRIPT" "$remote_work_dir")"
[[ -n "$remote_stage" ]] || die "remote mktemp returned an empty path"

log "Uploading packager to $server:$remote_stage"
scp_copy "$PACKAGER" "$server:$remote_stage/package-archive-snapshot.sh" >/dev/null

log "Packaging remote archive source: $remote_source"
package_output="$(run_remote_script "$REMOTE_PACKAGE_SCRIPT" "$remote_stage" "$remote_source")"
printf '%s\n' "$package_output"

remote_tarball="$(printf '%s\n' "$package_output" | awk '
  /^[[:space:]]*tarball:/ {
    sub(/^[[:space:]]*tarball:[[:space:]]*/, "")
    print
    exit
  }
')"
[[ -n "$remote_tarball" ]] || die "could not parse remote tarball path from packager output"

mkdir -p "$local_tar_dir"
local_tarball="$local_tar_dir/${remote_tarball##*/}"
log "Copying $server:$remote_tarball to $local_tarball"
scp_copy "$server:$remote_tarball" "$local_tarball"

if [[ "$no_extract" -eq 1 ]]; then
  cat <<EOF
Archive package fetched:
  tarball: $local_tarball
  extracted: no
EOF
  exit 0
fi

assert_safe_extract_dir "$extract_dir"
mkdir -p "$(dirname "$extract_dir")"
extract_tmp="$(mktemp -d "$(dirname "$extract_dir")/.usernode-archive-extract.XXXXXX")"

log "Extracting $local_tarball into staging directory $extract_tmp"
tar -xzf "$local_tarball" -C "$extract_tmp"

backup_dir=""
if [[ -e "$extract_dir" ]]; then
  if dir_is_empty "$extract_dir"; then
    rmdir "$extract_dir"
  elif [[ "$replace" -eq 1 ]]; then
    backup_dir="${extract_dir}.old.$$"
    log "Moving existing archive directory to $backup_dir"
    mv "$extract_dir" "$backup_dir"
  else
    die "extract directory already exists and is not empty: $extract_dir (use --replace)"
  fi
fi

log "Installing extracted archive at $extract_dir"
mv "$extract_tmp" "$extract_dir"
extract_tmp=""
if [[ -n "$backup_dir" ]]; then
  rm -rf "$backup_dir"
fi

cat <<EOF
Archive package fetched and extracted:
  tarball: $local_tarball
  archive_path: $extract_dir
EOF
