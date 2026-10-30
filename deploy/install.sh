#!/bin/sh
# Install (or upgrade) Orrery on the cluster of the current kubectl context.
#
#   curl -fsSL https://raw.githubusercontent.com/taituo/orrery/main/deploy/install.sh | sh
#   # or from a checkout:  ./deploy/install.sh [extra helm args…]
#
# Everything is bundled (PostgreSQL + pgvector, Temporal, secrets, an admin token), so no values
# are needed. Optional environment:
#   ORRERY_NAMESPACE   namespace (default: orrery)
#   ORRERY_RELEASE     Helm release name (default: orrery)
#   ORRERY_REF         git ref of the chart when not run from a checkout (default: main)
#   ORRERY_IMAGE_TAG   image tag (default: the chart's, "main")
#   KIRO_API_KEY       Kiro API key for Kiro bots (stored as a Kubernetes secret)
#   ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY / GEMINI_API_KEY
#                      model keys for OpenCode bots (stored in the agent environment secret)
# Agent credentials can also be set later in the console (Settings → Agent credentials).
set -eu

NS="${ORRERY_NAMESPACE:-orrery}"
RELEASE="${ORRERY_RELEASE:-orrery}"
REF="${ORRERY_REF:-main}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
for bin in kubectl helm; do command -v "$bin" >/dev/null 2>&1 || die "$bin is required (https://kubernetes.io/docs/tasks/tools/, https://helm.sh/docs/intro/install/)"; done
kubectl version --request-timeout=10s >/dev/null 2>&1 || die "kubectl cannot reach a cluster (check your context: kubectl config current-context)"

# The chart: from this checkout, or downloaded from GitHub.
here=$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)
if [ -n "$here" ] && [ -f "$here/helm/orrery/Chart.yaml" ]; then
  CHART="$here/helm/orrery"
else
  command -v curl >/dev/null 2>&1 || die "curl is required"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  say "Downloading the Orrery chart ($REF)…"
  curl -fsSL "https://codeload.github.com/taituo/orrery/tar.gz/$REF" | tar -xz -C "$tmp"
  CHART=$(find "$tmp" -maxdepth 4 -path '*/deploy/helm/orrery' -type d | head -n 1)
  [ -n "$CHART" ] || die "chart not found in the downloaded archive"
fi

set -- "$@"
[ -n "${ORRERY_IMAGE_TAG:-}" ] && set -- "$@" --set "image.tag=$ORRERY_IMAGE_TAG"
[ -n "${KIRO_API_KEY:-}" ] && set -- "$@" --set-string "computers.kiro.apiKey=$KIRO_API_KEY"
for k in ANTHROPIC_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY GEMINI_API_KEY; do
  eval "v=\${$k:-}"
  [ -n "$v" ] && set -- "$@" --set-string "computers.agentEnv.values.$k=$v"
done

say "Installing Orrery into namespace $NS (release $RELEASE)…"
helm upgrade --install "$RELEASE" "$CHART" --namespace "$NS" --create-namespace --wait --timeout 15m "$@"

secret=$(kubectl -n "$NS" get secret -l "app.kubernetes.io/instance=$RELEASE" -o name 2>/dev/null | grep -- '-platform$' | head -n 1 || true)
token=""
[ -n "$secret" ] && token=$(kubectl -n "$NS" get "$secret" -o jsonpath='{.data.admin-token}' 2>/dev/null | base64 -d 2>/dev/null || true)
web=$(kubectl -n "$NS" get svc -l "app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=web" -o name | head -n 1)

say ""
say "Orrery is running."
echo "  Open it:     kubectl -n $NS port-forward $web 8080:8080   →  http://localhost:8080"
[ -n "$token" ] && echo "  Admin token: $token"
echo "  CLI:         curl -fsSLo orrery http://localhost:8080/cli/orrery.mjs && chmod +x orrery"
echo "               ./orrery login --url http://localhost:8080 --token <token>"
echo "  MCP:         http://localhost:8080/mcp  (Authorization: Bearer <token>; ./orrery mcp prints a client config)"
echo "  Next: in the console, set a model credential (Settings → Agent credentials) and create a bot."
