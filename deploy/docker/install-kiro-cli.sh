#!/bin/bash
# Installs kiro-cli system-wide (into /usr/local/bin) for the bot computer image.
#   KIRO_CLI_URL  optional: pin a specific release zip (defaults to the latest for this CPU)
set -euo pipefail
arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) arch=x86_64 ;;
  aarch64|arm64) arch=aarch64 ;;
  *) echo "unsupported architecture: $arch" >&2; exit 1 ;;
esac
url="${KIRO_CLI_URL:-https://desktop-release.q.us-east-1.amazonaws.com/latest/kirocli-${arch}-linux.zip}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"
echo "kiro-cli: downloading $url"
curl --proto '=https' --tlsv1.2 -fSL --retry 3 "$url" -o kirocli.zip
unzip -q kirocli.zip
echo "kiro-cli: archive contents:"; find . -maxdepth 3 -not -path './kirocli.zip' | head -40
installer="$(find . -maxdepth 3 -name install.sh | head -1)"
export HOME="$work/home"
mkdir -p "$HOME/.local/bin"
if [ -n "$installer" ]; then
  bash "$installer" --no-confirm </dev/null
fi
# Collect the installed executables (or the archive's own binaries if the installer layout differs).
bins="$( { find "$HOME/.local/bin" -maxdepth 1 \( -type f -o -type l \) 2>/dev/null; find . -path ./home -prune -o -type f -perm -u+x -name 'kiro-cli*' -print; } | sort -u )"
[ -n "$bins" ] || { echo "kiro-cli: no executables found after install" >&2; exit 1; }
for b in $bins; do install -m 0755 "$(readlink -f "$b")" "/usr/local/bin/$(basename "$b")"; done
echo "kiro-cli: installed $(echo $bins | xargs -n1 basename | tr '\n' ' ')"
kiro-cli --version 2>/dev/null || kiro-cli version
