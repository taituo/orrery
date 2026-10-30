# Deployment

## Images

One Dockerfile (`deploy/docker/Dockerfile`) builds every image. CI publishes multi-arch images (amd64 and arm64) to GHCR as `ghcr.io/<owner>/orrery-<target>`.

| Target | Contents |
| --- | --- |
| `api` | REST/SSE API, the platform MCP server, and the migration CLI (`node dist/migrate.js`) |
| `worker` | Temporal workers, with the prebuilt workflow bundle |
| `web` | The console on unprivileged nginx. Runtime config comes from env (`ORRERY_API_URL`, `ORRERY_OIDC_*`, `ORRERY_LANGFUSE_URL`). Optionally it proxies the API through `API_UPSTREAM`. |
| `computer` | A bot computer: `kiro-cli`, `opencode`, the ACP gateway, and git, ripgrep, jq, python3 and make. Set `KIRO_CLI_URL` at build time to pin a CLI build, and `OPENCODE_VERSION` to change OpenCode (default 1.19.5). `AGENT_KIND` picks the agent. |
| `computer-mock` | `computer-base` with the mock Kiro CLI, for trials and CI without a Kiro account. It also has a fake OpenAI-compatible model server (`/opt/orrery/mock/fake-models.js`). |

```sh
docker build -f deploy/docker/Dockerfile --target api -t orrery/api .
```

## Local stack (Docker Compose)

```sh
cp .env.example .env               # KIRO_API_KEY=… (Pro, Pro+, Pro Max or Power plan)
docker compose up --build
open http://localhost:8080         # sign in with the dev token (default: dev-token)
```

The stack runs Postgres + pgvector, a Temporal dev server (UI on http://localhost:8233), the API (http://localhost:8090), one worker for all queues, a single computer shared by every bot, and the console.

To run without a Kiro account, set `ORRERY_COMPUTER_TARGET=computer-mock docker compose up --build`. Then check the whole path, including a worker crash in the middle of a turn:

```sh
node scripts/e2e.mjs --api http://localhost:8090 --token dev-token --mock \
  --crash-cmd "docker compose kill -s SIGKILL worker" --restart-cmd "docker compose up -d worker"
```

## Kubernetes (Helm)

The chart installs a complete, working platform with no values: API, workers, console, a bundled PostgreSQL 16 + pgvector, a bundled Temporal server, generated secrets and a bootstrap admin token. CI installs it this way on a kind cluster, with NetworkPolicies enforced by Calico, and runs the end-to-end checks against it.

```sh
curl -fsSL https://raw.githubusercontent.com/taituo/orrery/main/deploy/install.sh | sh
# or, from a checkout:
helm install orrery deploy/helm/orrery -n orrery --create-namespace
```

Then:

```sh
kubectl -n orrery port-forward svc/orrery-web 8080:8080      # console, API, /mcp and /docs
kubectl -n orrery get secret orrery-platform -o jsonpath='{.data.admin-token}' | base64 -d
```

1. Open http://localhost:8080 and sign in with the admin token.
2. In **Settings → Agent credentials**, set `KIRO_API_KEY` for Kiro bots or a model key such as `ANTHROPIC_API_KEY` for OpenCode bots. Bots can also use the platform's OpenAI-compatible providers.
3. Create a bot and talk to it.

The install serves its own CLI:

```sh
curl -fsSLo orrery http://localhost:8080/cli/orrery.mjs && chmod +x orrery   # Node.js 20+
./orrery login --url http://localhost:8080 --token <token>
./orrery mcp                                                              # config for MCP clients
```

The installer reads optional environment variables: `ORRERY_NAMESPACE`, `ORRERY_RELEASE`, `ORRERY_IMAGE_TAG`, `KIRO_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and others. Extra arguments are passed to `helm upgrade --install`.

**Production.** Point the chart at managed services and an identity provider, and turn the bundled ones off:

```sh
helm upgrade --install orrery deploy/helm/orrery -n orrery --create-namespace \
  --set image.tag=sha-<commit> \
  --set ingress.enabled=true --set ingress.host=orrery.example.com --set ingress.tls.enabled=true \
  --set postgresql.enabled=false --set config.database.existingSecret=orrery-db \
  --set temporalServer.enabled=false --set config.temporal.address=temporal-frontend.temporal:7233 \
  --set config.oidc.issuer=https://idp.example.com/realms/orrery --set config.oidc.webClientId=orrery-web
```

Production also needs:
- Kubernetes 1.27 or newer.
- PostgreSQL 16 with `vector` and `pg_trgm` (CloudNativePG, RDS, Cloud SQL, …).
- Temporal (the official chart or Temporal Cloud).

Optional:
- Langfuse.
- Cilium, for per-bot FQDN egress.
- KEDA, for queue-based autoscaling.
- gVisor or Kata, for sandboxed agent pods.

The admin token can stay as a break-glass owner, or you can set `config.adminToken.enabled=false` once OIDC works.

### What the chart creates

**Platform namespace**
- API, with an HPA and a PDB.
- One worker Deployment per role (`agent`, `acp`, `memory`), each scaled by an HPA or by the KEDA Temporal scaler.
- The console.
- The console proxies `/v1`, `/mcp`, `/openapi.json` and `/docs` to the API, so a single address serves everything (port-forward, LoadBalancer or Ingress).
- Optionally, an Ingress (`ingress.enabled`, `ingress.host`).
- A ConfigMap that includes `providers.yaml`.
- The platform Secret: MCP and gateway token secrets, the encryption key and the admin token. They are generated once and kept across upgrades.
- Unless disabled, single-pod PostgreSQL + pgvector and Temporal (`temporal server start-dev` with SQLite on a volume, Web UI on port 8233).
- A migration hook Job for upgrades. Fresh installs migrate on start, using an advisory lock.

**Computers namespace** (the restricted Pod Security Standard is enforced here)
- An optional Kiro API key Secret, and an optional agent environment Secret with model credentials for OpenCode bots (`computers.agentEnv`).
- A Role and RoleBinding that let the workers manage pods, services, PVCs, ConfigMaps and Secrets.
- NetworkPolicies:
  - Only workers can reach the gateways.
  - Computers can reach DNS and the API's MCP endpoint.
  - Per-bot egress depends on the network mode, and with Cilium can be an FQDN allowlist.
  - `computers.networkPolicy.extraEgress` adds rules for every computer, such as an in-cluster model server.

**Bot computers** are not part of the chart. Workers create them on demand (server-side apply) and stop them when idle. Each one is:
- a Pod and a Service on port 7777;
- a steering ConfigMap;
- a PVC for the home directory;
- a Secret holding **the computer's own gateway key**.

The key is derived from the platform's gateway secret, which never enters the computers namespace, so an agent that reads its environment can only reach its own gateway. The pod rolls when its spec hash changes.

### Images

The images on `ghcr.io/taituo` are public, so the chart pulls them without credentials. From a private registry, set `image.registry` and `imagePullSecrets`. Bot computers run in the computers namespace, so create the pull secret there too; set `computers.imagePullSecrets` if it has a different name there.

### Upgrades and running turns

`helm upgrade` and node drains don't interrupt conversations. An ACP worker that gets SIGTERM lets go of its running turns without cancelling them: the agent keeps working on its computer, and another worker re-attaches, replays what it missed and finishes the turn. A pending approval stays pending. CI checks this by restarting the ACP workers in the middle of a turn. A worker that crashes outright is covered too, after the activity heartbeat timeout (45 seconds).

### Kiro credentials

Kiro headless mode authenticates with an API key from a Pro, Pro+, Pro Max or Power plan. Store it in the computers namespace:

```sh
kubectl -n orrery-computers create secret generic orrery-kiro --from-literal=api-key=$KIRO_API_KEY
```

V3 bots can instead use `authMethod: client`. Orrery then answers `_kiro/auth/getAccessToken` from the gateway (`KIRO_ACCESS_TOKEN_FILE`).

### OpenCode credentials

OpenCode bots that use the platform's OpenAI-compatible providers need no extra credentials beyond the provider's `apiKeyEnv` variable in the agent environment secret. Bots on other OpenCode providers read their keys from the same secret (`ANTHROPIC_API_KEY`, …). See [OPENCODE.md](OPENCODE.md).

### Scaling notes

- The **acp** queue holds one long-running activity per live turn. Size `ACP_ACTIVITY_CONCURRENCY` (default 200 per pod) against the turns you expect at once.
- The **agent** queue runs short activities and the workflows themselves. Scale it on CPU or on queue backlog (KEDA).
- Each bot runs at most four threads at once; turns within a thread are serialized.
- The ACP heartbeat timeout (45 s) sets how quickly a turn fails over after a worker dies.

## Configuration

Environment variables are validated at startup (`packages/core/src/config.ts`). The most important ones:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL`, `DATABASE_SSL`, `ORRERY_VECTOR_DIMS` | Postgres connection. The embedding column width is fixed at first migration (default 1536, smaller embeddings are zero-padded). |
| `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TASK_QUEUE_PREFIX`, `TEMPORAL_TLS*`, `TEMPORAL_API_KEY` | Temporal connection (mTLS or Cloud API key) |
| `PUBLIC_BASE_URL`, `WEB_ORIGINS`, `INTERNAL_API_URL` | URLs. Agents reach the platform MCP server at `INTERNAL_API_URL/mcp`. |
| `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_TEAM_CLAIM`, `OIDC_ROLE_CLAIM` | Authentication. Role claim values: owner, admin, member, viewer. |
| `MCP_TOKEN_SECRET`, `GATEWAY_TOKEN_SECRET`, `ENCRYPTION_KEY` | HMAC secrets for bot-scoped MCP and gateway tokens, and the AES-256-GCM key (32 bytes, base64) for stored secrets |
| `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_UI_URL`, `OTEL_EXPORTER_OTLP_ENDPOINT` | Tracing |
| `PROVIDERS_FILE` / `PROVIDERS_JSON`, `EMBED_PROVIDER_ID`, `FAST_PROVIDER_ID`, `CLEF_PROVIDER_ID` | Model providers (see below) |
| `COMPUTER_PROVIDER` (`kubernetes`, `local` or `static`), `COMPUTER_NAMESPACE`, `COMPUTER_IMAGE`, `COMPUTER_RUNTIME_CLASS`, `COMPUTER_STORAGE_CLASS`, `COMPUTER_KIRO_SECRET`, `COMPUTER_AGENT_SECRET`, `COMPUTER_CILIUM`, `COMPUTER_STATIC_URL` | Bot computers |
| `KIRO_CLI_PATH`, `OPENCODE_PATH` | Agent binaries for the `local` computer provider |
| `WORKER_QUEUES`, `ACP_ACTIVITY_CONCURRENCY`, `AGENT_ACTIVITY_CONCURRENCY`, `MEMORY_ACTIVITY_CONCURRENCY` | Worker roles and concurrency |
| `DEV_AUTH_TOKEN` | Development only. Refused when `NODE_ENV=production`. |

### Providers

Kiro needs no provider entry: it runs in the bot computers. `providers.yaml` configures the side models.

```yaml
- kind: openai                 # any OpenAI-compatible server: vLLM, SGLang, Ollama, LiteLLM, OpenAI, …
  id: local-vllm
  baseUrl: http://vllm.inference:8000/v1
  apiKeyEnv: VLLM_API_KEY      # name of an env var (from config.providerSecret); keys never live here
  roles: [chat, fast, extract, summarize]
  models: { chat: [qwen3-235b-a22b, qwen3-30b-a3b] }
- kind: openai
  id: tei
  baseUrl: http://tei.inference/v1
  roles: [embed, rerank]
  models: { embed: bge-m3, embedDims: 1024, rerank: bge-reranker-v2-m3 }
  rerankPath: /rerank
- kind: clef                   # Cloudflare Clef / Clef-flash (System One API)
  id: clef
  format: workers-ai           # or systemone with baseUrl: http://clef.inference/v1/systemone
  accountIdEnv: CF_ACCOUNT_ID
  apiKeyEnv: CF_API_TOKEN
  model: clef
  fastModel: clef-flash
```

Each role does the following:

| Role | Used for |
| --- | --- |
| `chat` | OpenAI-compatible primary bots |
| `fast` | Quick replies when routing is `auto` |
| `extract` | Memory extraction |
| `summarize` | Episodes and thread titles |
| `embed` | Memory and knowledge vectors |
| `rerank` | Knowledge search |
| Clef | Routing, the risk guardrail, memory write gates and reconciliation, and RAG injection and evidence filters |

Every role is optional. Without them, Orrery degrades gracefully: search falls back to full-text, there is no guardrail, and memory extraction does not run.
