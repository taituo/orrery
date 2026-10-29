#!/bin/sh
# Writes the console's runtime config from environment variables (no rebuild per environment).
set -eu
mkdir -p /tmp/orrery
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
oidc=null
if [ -n "${ORRERY_OIDC_ISSUER:-}" ] && [ -n "${ORRERY_OIDC_CLIENT_ID:-}" ]; then
  oidc="{\"issuer\":\"$(json_escape "$ORRERY_OIDC_ISSUER")\",\"clientId\":\"$(json_escape "$ORRERY_OIDC_CLIENT_ID")\",\"scope\":\"$(json_escape "${ORRERY_OIDC_SCOPE:-openid profile email}")\"$( [ -n "${ORRERY_OIDC_AUDIENCE:-}" ] && printf ',"audience":"%s"' "$(json_escape "$ORRERY_OIDC_AUDIENCE")" )}"
fi
langfuse=null
[ -n "${ORRERY_LANGFUSE_URL:-}" ] && langfuse="\"$(json_escape "$ORRERY_LANGFUSE_URL")\""
cat > /tmp/orrery/config.js <<JS
window.__ORRERY_CONFIG__ = {"apiUrl":"$(json_escape "${ORRERY_API_URL:-}")","oidc":${oidc},"langfuseUrl":${langfuse},"mock":false};
JS
if [ -n "${API_UPSTREAM:-}" ]; then
  cat > /etc/nginx/conf.d/api-proxy.inc <<NGINX
location ~ ^/(v1|mcp|openapi\.json|docs)(/|$) {
  proxy_pass ${API_UPSTREAM};
  proxy_http_version 1.1;
  proxy_set_header Host \$host;
  proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto \$scheme;
  proxy_set_header Connection "";
  proxy_buffering off;
  proxy_cache off;
  proxy_read_timeout 1h;
  client_max_body_size 30m;
}
NGINX
else
  rm -f /etc/nginx/conf.d/api-proxy.inc
fi
