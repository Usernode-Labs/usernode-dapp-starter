#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob

HOME_DIR="${HOME%/}"
if [[ "$HOME_DIR" == */~ ]]; then
  HOME_DIR="${HOME_DIR%/~}"
fi

DEFAULT_SOURCE="$HOME_DIR/.coolify-volumes/storage/shared/archive"
DEFAULT_OUTPUT_DIR="/tmp"

usage() {
  cat <<'EOF'
Usage: scripts/package-archive-snapshot.sh [SOURCE_ARCHIVE_ROOT] [OUTPUT_TARBALL_OR_DIR]

Packages the latest archive snapshot plus all block .binprot files from the
snapshot block through best_tip into a tarball that can be extracted and passed
directly as --archive-path.

Defaults:
  SOURCE_ARCHIVE_ROOT: ~/.coolify-volumes/storage/shared/archive
  OUTPUT_TARBALL_OR_DIR: /tmp

The source should normally be the archive root containing:
  chain_id
  <chain_id>/manifest.json
  <chain_id>/blocks/

For convenience, passing the <chain_id> directory itself is also accepted.
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >&2
}

expand_path() {
  local path="$1"
  if [[ "$path" == "~" ]]; then
    printf '%s\n' "$HOME_DIR"
  elif [[ "$path" == "~/"* ]]; then
    printf '%s/%s\n' "$HOME_DIR" "${path#~/}"
  elif [[ "$path" == "$HOME_DIR/~/"* ]]; then
    printf '%s/%s\n' "$HOME_DIR" "${path#"$HOME_DIR/~/"}"
  else
    printf '%s\n' "$path"
  fi
}

json_string_field() {
  local file="$1"
  local field="$2"
  sed -n "s/.*\"${field}\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" "$file" | head -n 1
}

json_number_field() {
  local file="$1"
  local field="$2"
  sed -n "s/.*\"${field}\"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p" "$file" | head -n 1
}

block_height_from_path() {
  local base
  base="${1##*/}"
  if [[ "$base" =~ ^block_([0-9]+)_ ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
    return 0
  fi
  return 1
}

list_block_dir_names() {
  local dir="$1"
  if ls --help 2>/dev/null | grep -q -- '-U'; then
    LC_ALL=C ls -1U -- "$dir"
  else
    LC_ALL=C ls -1 "$dir"
  fi
}

read_nonempty_file() {
  local path="$1"
  local label="$2"
  local value
  local attempt

  for attempt in {1..20}; do
    if [[ -f "$path" ]]; then
      value="$(tr -d '[:space:]' < "$path" || true)"
      if [[ -n "$value" ]]; then
        printf '%s\n' "$value"
        return 0
      fi
    fi
    sleep 0.1
  done

  die "empty or missing $label after waiting: $path"
}

stage_file() {
  local src="$1"
  local rel="$2"
  local dest="$stage/$rel"

  [[ "$rel" != /* ]] || die "refusing to stage absolute path: $rel"
  [[ "$rel" != *..* ]] || die "refusing to stage path containing '..': $rel"
  [[ -f "$src" ]] || die "source file not found while staging: $src"

  mkdir -p "$(dirname "$dest")"
  rm -f "$dest"
  if ! ln "$src" "$dest" 2>/dev/null; then
    cp -p "$src" "$dest"
  fi
}

block_name_by_hash_from_list() {
  local list_file="$1"
  local hash="$2"
  awk -v hash="$hash" '
    /^block_[0-9]+_.*[.]binprot$/ {
      name = $0
      sub(/[.]binprot$/, "", name)
      n = split(name, parts, "_")
      if (n >= 3 && parts[1] == "block" && parts[3] == hash) {
        print $0
        exit
      }
    }
  ' "$list_file"
}

find_block_by_hash() {
  local blocks_dir="$1"
  local hash="$2"
  local path

  for path in "$blocks_dir"/block_*_"$hash".binprot "$blocks_dir"/block_*_"$hash"_*.binprot; do
    if [[ -f "$path" ]]; then
      printf '%s\n' "$path"
      return 0
    fi
  done

  return 1
}

snapshot_slot_from_protocol_file() {
  local protocol_file="$1"
  local base
  base="$(basename "$protocol_file")"
  if [[ "$base" =~ ^mid_epoch_([0-9]+)_([0-9]+)_ ]]; then
    printf '%s\n' "${BASH_REMATCH[2]}"
  elif [[ "$base" =~ ^epoch_([0-9]+)_ ]]; then
    printf '%s\n' "boundary"
  else
    printf '%s\n' "unknown"
  fi
}

block_json_name_from_binprot_name() {
  local block_name="$1"
  printf '%s.json\n' "${block_name%.binprot}"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

source_arg="${1:-$DEFAULT_SOURCE}"
output_arg="${2:-$DEFAULT_OUTPUT_DIR}"

source_path="$(expand_path "$source_arg")"
output_path="$(expand_path "$output_arg")"

[[ -d "$source_path" ]] || die "source archive directory not found: $source_path"
log "Inspecting archive source: $source_path"

archive_root="$source_path"
chain_id=""
chain_dir=""

if [[ -f "$source_path/chain_id" ]]; then
  chain_id="$(tr -d '[:space:]' < "$source_path/chain_id")"
  [[ -n "$chain_id" ]] || die "empty chain_id file: $source_path/chain_id"
  chain_dir="$source_path/$chain_id"
elif [[ -f "$source_path/manifest.json" ]]; then
  chain_dir="$source_path"
  chain_id="$(basename "$source_path")"
  archive_root="$(dirname "$source_path")"
else
  while IFS= read -r manifest; do
    if [[ -z "$chain_dir" ]]; then
      chain_dir="$(dirname "$manifest")"
      chain_id="$(basename "$chain_dir")"
    else
      die "multiple chain manifests found under $source_path; pass the archive root with chain_id or the desired chain directory"
    fi
  done < <(find "$source_path" -mindepth 2 -maxdepth 2 -type f -name manifest.json)
  [[ -n "$chain_dir" ]] || die "no chain manifest found under $source_path"
fi

manifest_path="$chain_dir/manifest.json"
blocks_dir="$chain_dir/blocks"

[[ -f "$manifest_path" ]] || die "manifest not found: $manifest_path"
[[ -d "$blocks_dir" ]] || die "blocks directory not found: $blocks_dir"
log "Using chain directory: $chain_dir"
log "Reading latest snapshot manifest: $manifest_path"

stage="$(mktemp -d "${TMPDIR:-/tmp}/usernode-archive-package.XXXXXX")"
tar_tmp=""
cleanup() {
  rm -rf "$stage"
  if [[ -n "${tar_tmp:-}" ]]; then
    rm -f "$tar_tmp"
  fi
}
trap cleanup EXIT

mkdir -p "$stage/$chain_id/blocks"
printf '%s\n' "$chain_id" > "$stage/chain_id"
stage_file "$manifest_path" "$chain_id/manifest.json"
manifest_path="$stage/$chain_id/manifest.json"

snapshot_epoch="$(json_number_field "$manifest_path" "epoch")"
snapshot_hash="$(json_string_field "$manifest_path" "block_hash")"
utxo_file="$(json_string_field "$manifest_path" "utxo_file")"
utxo_hashes_file="$(json_string_field "$manifest_path" "utxo_hashes_file" || true)"
identity_file="$(json_string_field "$manifest_path" "identity_file")"
protocol_file="$(json_string_field "$manifest_path" "protocol_file")"

[[ -n "$snapshot_epoch" ]] || die "manifest is missing latest.epoch"
[[ -n "$snapshot_hash" ]] || die "manifest is missing latest.block_hash"
[[ -n "$utxo_file" ]] || die "manifest is missing latest.utxo_file"
[[ -n "$identity_file" ]] || die "manifest is missing latest.identity_file"
[[ -n "$protocol_file" ]] || die "manifest is missing latest.protocol_file"

for required in "$utxo_file" "$identity_file" "$protocol_file"; do
  [[ -f "$chain_dir/$required" ]] || die "manifest references missing file: $chain_dir/$required"
  stage_file "$chain_dir/$required" "$chain_id/$required"
done
if [[ -n "$utxo_hashes_file" && ! -f "$chain_dir/$utxo_hashes_file" ]]; then
  die "manifest references missing file: $chain_dir/$utxo_hashes_file"
fi
if [[ -n "$utxo_hashes_file" ]]; then
  stage_file "$chain_dir/$utxo_hashes_file" "$chain_id/$utxo_hashes_file"
fi

best_tip_path="$blocks_dir/best_tip"
[[ -f "$best_tip_path" ]] || die "best_tip marker not found: $best_tip_path"
best_tip_hash="$(read_nonempty_file "$best_tip_path" "best_tip marker")"
printf '%s\n' "$best_tip_hash" > "$stage/$chain_id/blocks/best_tip"
log "Listing block directory once"
block_names_file="$stage/block-names.txt"
list_block_dir_names "$blocks_dir" > "$block_names_file"
block_name_count="$(wc -l < "$block_names_file" | tr -d '[:space:]')"
log "Listed $block_name_count directory entries"

snapshot_block_name="$(block_name_by_hash_from_list "$block_names_file" "$snapshot_hash")"
best_tip_block_name="$(block_name_by_hash_from_list "$block_names_file" "$best_tip_hash")"
[[ -n "$snapshot_block_name" ]] || die "snapshot block dump not found for hash $snapshot_hash"
[[ -n "$best_tip_block_name" ]] || die "best_tip block dump not found for hash $best_tip_hash"

snapshot_height="$(block_height_from_path "$snapshot_block_name")" || die "could not parse snapshot block height from $snapshot_block_name"
best_tip_height="$(block_height_from_path "$best_tip_block_name")" || die "could not parse best_tip block height from $best_tip_block_name"

if (( best_tip_height < snapshot_height )); then
  die "best_tip height $best_tip_height is lower than snapshot height $snapshot_height"
fi

snapshot_slot="$(snapshot_slot_from_protocol_file "$protocol_file")"
best_tip_json_name="$(block_json_name_from_binprot_name "$best_tip_block_name")"
best_tip_json_path="$blocks_dir/$best_tip_json_name"
best_tip_epoch=""
best_tip_slot=""
if [[ -f "$best_tip_json_path" ]]; then
  log "Reading best_tip metadata from: $best_tip_json_path"
  best_tip_epoch="$(json_number_field "$best_tip_json_path" "epoch")"
  best_tip_slot="$(json_number_field "$best_tip_json_path" "epoch_slot")"
else
  log "Best tip JSON metadata not found; filename will use tip height instead of tip slot: $best_tip_json_path"
fi

if [[ -n "$best_tip_epoch" && -n "$best_tip_slot" ]]; then
  default_filename="usernode-archive-epoch-${best_tip_epoch}-slot-${best_tip_slot}.tar.gz"
  log "Packaging snapshot epoch=$snapshot_epoch slot=$snapshot_slot height=$snapshot_height through best_tip epoch=$best_tip_epoch slot=$best_tip_slot height=$best_tip_height"
else
  default_filename="usernode-archive-snapshot-epoch-${snapshot_epoch}-slot-${snapshot_slot}-tip-height-${best_tip_height}.tar.gz"
  log "Packaging snapshot epoch=$snapshot_epoch slot=$snapshot_slot height=$snapshot_height through best_tip height=$best_tip_height"
fi

if [[ -d "$output_path" || "${output_arg}" == */ ]]; then
  mkdir -p "$output_path"
  tarball="$output_path/$default_filename"
else
  mkdir -p "$(dirname "$output_path")"
  tarball="$output_path"
fi
case "$tarball" in
  /*) ;;
  *) tarball="$PWD/$tarball" ;;
esac

filelist="$stage/archive-files.txt"
block_list="$stage/block-files.txt"
block_stats="$stage/block-stats.txt"

log "Building tar file list"
{
  printf '%s\n' "chain_id"
  printf '%s\n' "$chain_id/manifest.json"
  printf '%s\n' "$chain_id/$utxo_file"
  printf '%s\n' "$chain_id/$identity_file"
  printf '%s\n' "$chain_id/$protocol_file"
  printf '%s\n' "$chain_id/blocks/best_tip"
} > "$filelist"
if [[ -n "$utxo_hashes_file" ]]; then
  printf '%s\n' "$chain_id/$utxo_hashes_file" >> "$filelist"
fi

log "Filtering $block_name_count listed entries to height range ${snapshot_height}..${best_tip_height}"
awk -v chain="$chain_id" \
  -v lo="$snapshot_height" \
  -v hi="$best_tip_height" \
  -v stats="$block_stats" '
    BEGIN {
      block_count = 0
      height_count = 0
    }
    /^block_[0-9]+_.*[.]binprot$/ {
      name = $0
      sub(/^block_/, "", name)
      split(name, parts, "_")
      height = parts[1] + 0
      if (height >= lo && height <= hi) {
        print chain "/blocks/" $0
        block_count++
        if (!(height in seen_heights)) {
          seen_heights[height] = 1
          height_count++
        }
      }
    }
    END {
      print block_count, height_count > stats
    }
  ' "$block_names_file" > "$block_list"

read -r block_count height_count < "$block_stats"
cat "$block_list" >> "$filelist"

if (( block_count == 0 )); then
  die "no block .binprot files selected for height range ${snapshot_height}..${best_tip_height}"
fi

log "Selected $block_count block files across $height_count observed heights"
log "Staging selected block files"
while IFS= read -r block_rel; do
  block_name="${block_rel#"$chain_id/blocks/"}"
  [[ "$block_name" != "$block_rel" ]] || die "unexpected block path in file list: $block_rel"
  stage_file "$blocks_dir/$block_name" "$block_rel"
done < "$block_list"

log "Creating compressed tarball: $tarball"
tar_tmp="${tarball}.tmp.$$"
rm -f "$tar_tmp"
if command -v pigz >/dev/null 2>&1 && command -v pv >/dev/null 2>&1; then
  log "Compressing with pigz -1; pv will show stream throughput"
  (cd "$stage" && tar -cf - -T "$filelist") | pv | pigz -1 > "$tar_tmp"
elif command -v pigz >/dev/null 2>&1; then
  log "Compressing with pigz -1"
  (cd "$stage" && tar -cf - -T "$filelist") | pigz -1 > "$tar_tmp"
elif command -v pv >/dev/null 2>&1; then
  log "Compressing with gzip -1; pv will show stream throughput"
  (cd "$stage" && tar -cf - -T "$filelist") | pv | gzip -1 > "$tar_tmp"
else
  log "Compressing with gzip -1"
  (cd "$stage" && tar -cf - -T "$filelist") | gzip -1 > "$tar_tmp"
fi
mv "$tar_tmp" "$tarball"
log "Finished writing tarball"

cat <<EOF
Archive package written:
  tarball: $tarball
  source: $archive_root
  chain_id: $chain_id
  snapshot_epoch: $snapshot_epoch
  snapshot_slot: $snapshot_slot
  snapshot_height: $snapshot_height
  snapshot_hash: $snapshot_hash
  best_tip_epoch: ${best_tip_epoch:-unknown}
  best_tip_slot: ${best_tip_slot:-unknown}
  best_tip_height: $best_tip_height
  best_tip_hash: $best_tip_hash
  block_binprot_files: $block_count
EOF
