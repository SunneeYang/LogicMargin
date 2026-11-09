#!/bin/sh
set -eu

fail() { printf 'LogicMargin: %s\n' "$*" >&2; exit 1; }

script=$0
case "$script" in */*) ;; *) script=$(command -v "$script") || fail 'Cannot locate launcher.' ;; esac
links=0
while [ -L "$script" ]; do
  links=$((links + 1))
  [ "$links" -le 40 ] || fail 'Too many launcher symlinks.'
  directory=$(CDPATH= cd -P "$(dirname "$script")" && pwd) || fail 'Cannot resolve launcher directory.'
  link=$(readlink "$script") || fail 'Cannot resolve launcher symlink.'
  case "$link" in /*) script=$link ;; *) script=$directory/$link ;; esac
done
directory=$(CDPATH= cd -P "$(dirname "$script")" && pwd) || fail 'Cannot resolve launcher directory.'
manifest=$directory/../../../plugin.json
[ -f "$manifest" ] || fail "Missing plugin manifest: $manifest"
version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p' "$manifest")
case "$version" in ''|*[!0-9.]*) fail 'Plugin manifest must pin a version X.Y.Z.' ;; esac

check_version() {
  actual_version=$("$1" --version) || fail "Cannot read native executable version: $1"
  [ "$actual_version" = "$version" ] || fail "Native executable version $actual_version does not match plugin $version: $1"
}

binary=$directory/logic-margin
if [ -e "$binary" ]; then
  [ -f "$binary" ] && [ -x "$binary" ] || fail "Native executable is not executable: $binary"
  check_version "$binary"
  exec "$binary" "$@"
fi

system=$(uname -s)
machine=$(uname -m)
case "$system" in Darwin) platform=darwin ;; Linux) platform=linux ;; *) fail "Unsupported platform: $system/$machine" ;; esac
case "$machine" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) fail "Unsupported platform: $system/$machine" ;; esac
target=$platform-$arch
cache_base=${XDG_CACHE_HOME:-}
if [ -z "$cache_base" ]; then
  [ -n "${HOME:-}" ] || fail 'HOME or XDG_CACHE_HOME must be set.'
  case "$platform" in darwin) cache_base=$HOME/Library/Caches ;; *) cache_base=$HOME/.cache ;; esac
fi
cache=$cache_base/logic-margin/native/$version/$target
binary=$cache/logic-margin
if [ ! -e "$binary" ]; then
  for dependency in curl unzip; do
    command -v "$dependency" >/dev/null 2>&1 || fail "Required command is missing: $dependency"
  done
  if command -v sha256sum >/dev/null 2>&1; then
    checksum_command=sha256sum
  elif command -v shasum >/dev/null 2>&1; then
    checksum_command=shasum
  else
    fail 'Required command is missing: sha256sum or shasum'
  fi
  previous_umask=$(umask)
  umask 077
  mkdir -p "$cache" || fail "Cannot create native cache: $cache"
  temporary=$(mktemp -d "$cache/.download.XXXXXXXX") || fail 'Cannot create download directory.'
  trap 'rm -rf "$temporary"' 0
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  package=logic-margin-agent-$version-$target
  asset=$package.zip
  url=https://github.com/SunneeYang/LogicMargin/releases/download/v$version/$asset
  printf 'LogicMargin: Downloading %s\n' "$asset" >&2
  curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 120 --output "$temporary/$asset" "$url" || fail "Download failed: $url"
  curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 120 --output "$temporary/checksum" "$url.sha256" || fail "Download failed: $url.sha256"
  read -r expected checksum_name < "$temporary/checksum" || fail 'Invalid release SHA-256 file.'
  case "$expected" in ''|*[!0-9a-f]*) fail 'Invalid release SHA-256 file.' ;; esac
  [ "${#expected}" -eq 64 ] && [ "$checksum_name" = "$asset" ] || fail 'Invalid release SHA-256 file.'
  if [ "$checksum_command" = shasum ]; then
    actual=$(shasum -a 256 "$temporary/$asset") || fail 'Cannot calculate SHA-256.'
  else
    actual=$(sha256sum "$temporary/$asset") || fail 'Cannot calculate SHA-256.'
  fi
  [ "${actual%% *}" = "$expected" ] || fail "SHA-256 mismatch for $asset"
  entry=$package/plugins/logic-margin/skills/logic-margin/scripts/logic-margin
  unzip -p "$temporary/$asset" "$entry" > "$temporary/logic-margin" || fail "Missing or invalid executable in $asset"
  chmod 700 "$temporary/logic-margin" || fail 'Cannot make native executable runnable.'
  check_version "$temporary/logic-margin"
  mv -f "$temporary/logic-margin" "$binary" || fail "Cannot install native executable: $binary"
  rm -rf "$temporary"
  trap - 0 HUP INT TERM
  umask "$previous_umask"
fi
[ -f "$binary" ] && [ -x "$binary" ] || fail "Cached native executable is not executable: $binary"
check_version "$binary"
exec "$binary" "$@"
