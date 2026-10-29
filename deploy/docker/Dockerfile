# syntax=docker/dockerfile:1.7
#
# One Dockerfile, four images (select with --target):
#   api       REST/SSE API + platform MCP server + migration CLI
#   worker    Temporal workers (agent / acp / memory roles, chosen with WORKER_QUEUES)
#   web       the console (static files on unprivileged nginx, runtime config from env)
#   computer  a bot computer: kiro-cli + the Orrery ACP gateway + common dev tools
#   computer-mock  the same with a wire-faithful mock Kiro CLI instead (no Kiro account needed;
#             for local end-to-end trials and CI)
#
#   docker build -f deploy/docker/Dockerfile --target api -t orrery/api .

ARG NODE_VERSION=22
ARG NGINX_VERSION=1.27-alpine

############################################################ build
FROM node:${NODE_VERSION}-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
# pnpm from the npm registry (older bundled corepack builds can't verify newer pnpm signatures)
RUN npm install -g pnpm@10.28.0
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch --frozen-lockfile
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --offline
RUN pnpm --filter @orrery/api build \
 && pnpm --filter @orrery/worker build \
 && pnpm --filter @orrery/acp-gateway build \
 && pnpm --filter @orrery/web build \
 && node scripts/bundle.mjs --standalone packages/testkit/src/mock-kiro-cli.ts /out/mock/mock-kiro-cli.js
# Production node_modules for the externals each bundle keeps (native Temporal core,
# OpenTelemetry, pg, pino, ws, …), flattened so bundles resolve them from /app/node_modules.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --config.node-linker=hoisted --filter @orrery/api deploy --prod --legacy /out/api \
 && pnpm --config.node-linker=hoisted --filter @orrery/worker deploy --prod --legacy /out/worker \
 && pnpm --config.node-linker=hoisted --filter @orrery/acp-gateway deploy --prod --legacy /out/gateway \
 && for app in api worker; do rm -rf /out/$app/dist /out/$app/src /out/$app/test && cp -r apps/$app/dist /out/$app/dist; done \
 && rm -rf /out/gateway/dist /out/gateway/src && cp -r packages/acp-gateway/dist /out/gateway/dist

############################################################ runtime base
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production NODE_OPTIONS=--enable-source-maps
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]

############################################################ api
FROM runtime AS api
COPY --from=build --chown=node:node /out/api /app
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]

############################################################ worker
FROM runtime AS worker
COPY --from=build --chown=node:node /out/worker /app
ENV WORKFLOW_BUNDLE_PATH=/app/dist/workflow-bundle.js
EXPOSE 8081 9464
HEALTHCHECK --interval=15s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||8081)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]

############################################################ web
FROM nginxinc/nginx-unprivileged:${NGINX_VERSION} AS web
COPY --from=build /src/apps/web/dist /usr/share/nginx/html
COPY deploy/docker/web/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY deploy/docker/web/40-orrery-config.sh /docker-entrypoint.d/40-orrery-config.sh
ENV API_UPSTREAM="" ORRERY_API_URL="" ORRERY_OIDC_ISSUER="" ORRERY_OIDC_CLIENT_ID="" ORRERY_OIDC_SCOPE="openid profile email offline_access" ORRERY_OIDC_AUDIENCE="" ORRERY_LANGFUSE_URL=""
EXPOSE 8080

############################################################ computer-base
# Bot computer without an agent: dev tools + the Orrery ACP gateway.
FROM node:${NODE_VERSION}-bookworm-slim AS computer-base
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip git openssh-client jq ripgrep less procps python3 python3-venv make tini \
 && rm -rf /var/lib/apt/lists/*
# uid 1000 ("node") matches the pod securityContext; its home is the persistent volume.
RUN usermod -d /home/agent node && mkdir -p /home/agent/workspace && chown -R node:node /home/agent
COPY --from=build --chown=node:node /out/gateway /opt/orrery/gateway
ENV NODE_ENV=production HOME=/home/agent WORKSPACE_ROOT=/home/agent/workspace KIRO_CLI_PATH=/usr/local/bin/kiro-cli GATEWAY_PORT=7777
WORKDIR /home/agent/workspace
EXPOSE 7777
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/orrery/gateway/dist/main.js"]

############################################################ computer
FROM computer-base AS computer
# Pin a Kiro CLI build by overriding the URL (defaults to the latest release for the platform).
ARG KIRO_CLI_URL=""
COPY deploy/docker/install-kiro-cli.sh /tmp/install-kiro-cli.sh
RUN KIRO_CLI_URL="$KIRO_CLI_URL" bash /tmp/install-kiro-cli.sh && rm /tmp/install-kiro-cli.sh
USER node

############################################################ computer-mock
FROM computer-base AS computer-mock
COPY --from=build --chown=node:node /out/mock /opt/orrery/mock
ENV KIRO_CLI_PATH="node /opt/orrery/mock/mock-kiro-cli.js" MOCK_KIRO_GENERATION=v3
USER node
