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
# The release archive ships ready-to-run binaries in kirocli/bin (kiro-cli, kiro-cli-chat,
# kiro-cli-term, …). Its install.sh only copies them into ~/.local/bin and wires up shell
# integration (and refuses to run as root), so install the binaries directly.
bindir="$(find . -maxdepth 3 -type d -path '*kirocli/bin' | head -1)"
if [ -z "$bindir" ]; then
  installer="$(find . -maxdepth 3 -name install.sh | head -1)"
  [ -n "$installer" ] || { echo "kiro-cli: no bin/ directory or installer in the archive" >&2; exit 1; }
  export HOME="$work/home"; mkdir -p "$HOME/.local/bin"
  bash "$installer" --no-confirm --force </dev/null
  bindir="$HOME/.local/bin"
fi
bins="$(find "$bindir" -maxdepth 1 \( -type f -o -type l \) | sort)"
[ -n "$bins" ] || { echo "kiro-cli: no executables found" >&2; exit 1; }
for b in $bins; do install -m 0755 "$(readlink -f "$b")" "/usr/local/bin/$(basename "$b")"; done
echo "kiro-cli: installed $(echo $bins | xargs -n1 basename | tr '\n' ' ')"
kiro-cli --version 2>/dev/null || kiro-cli version
