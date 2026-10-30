# Orrery

Durable, self-hosted AI teammates: always-on agents (in the spirit of Grok Bots) that each have their own computer, memory, tools and approval policy, and that keep working across restarts.

- **Inference:** Kiro over the Agent Client Protocol, with Kiro CLI V3 (`kiro-cli acp --agent-engine=v3`) as the primary engine and CLI v2 still supported. [OpenCode](docs/OPENCODE.md) (`opencode acp`) is supported too, and can run on the platform's own OpenAI-compatible models; any other ACP agent works as well. OpenAI-compatible endpoints handle quick replies, memory extraction, embeddings and reranking. Cloudflare Clef (the System One API) makes routing, guardrail and memory decisions.
- **Durability:** Temporal. Each bot is an entity workflow, each turn is a child workflow, routines are Temporal Schedules, and the ACP activity heartbeats so it can resume.
- **Bot computers:** a Kubernetes pod per bot running the Orrery ACP gateway. The gateway keeps the agent process alive across worker restarts, journals session updates and re-delivers held permission requests. A turn is never prompted twice.
- **Memory:**
  - Core memory blocks that are always in context.
  - Long-term memories with hybrid recall (pgvector + full text + trigram, fused with reciprocal rank fusion).
  - Clef-gated writes, secret screening, and bitemporal superseding of contradicted facts.
  - Episodes and periodic consolidation.
- **Knowledge (RAG):** chunked, embedded sources with a prompt-injection gate, reranking and a Clef evidence filter.
- **Governance:** tool policies (deny > ask > allow) plus a risk guardrail. Approvals show exactly the options the agent offered, including Kiro's persistent consent. You also get an audit log, encrypted secrets and OIDC with RBAC.
- **Observability:** Langfuse. One trace per turn, with agent, tool, generation and retriever observations. User feedback is recorded as scores.
- **API, MCP and UI:**
  - A REST + SSE API with an OpenAPI 3.1 spec at `/openapi.json`.
  - A platform MCP server at `/mcp` that gives agents memory, knowledge and delegation tools.
  - A React console with a clickable prototype build.

## Status

Pre-release. What is and isn't verified:

| Area | State |
| --- | --- |
| ACP client, Kiro V3/v2 adapters, gateway | Tested against a wire-faithful mock built from the Kiro docs, the official ACP SDK and the official JSON schema, and the crash/resume paths are covered. The real `kiro-cli` (2.35.1) installs and launches in CI. Without credentials it stops at sign-in, which Orrery reports clearly. **A full turn against the real CLI needs a `KIRO_API_KEY`** — add it as a repository secret and the CI job `e2e-kiro` runs. See [docs/KIRO.md](docs/KIRO.md). |
| OpenCode over ACP | The real `opencode` (1.19.5) is tested in CI through the gateway: policy-governed tools, approvals, session reuse and load after a restart, cancellation, model and agent selection. A compose end-to-end job kills the worker while a turn waits for approval; the turn then completes once. See [docs/OPENCODE.md](docs/OPENCODE.md). |
| Providers, Clef, memory, RAG | Tested against fake OpenAI/Clef servers on real Postgres 16 + pgvector |
| Temporal workflows | Tested on the Temporal dev server (locally and in CI) |
| API | End-to-end tests: auth/RBAC, bots, threads, steering, approvals, memory, knowledge, routines, secrets, webhooks, SSE resume, MCP, the delivery outbox |
| Full stack | `scripts/e2e.mjs` run against the production bundles: API → Temporal → worker → gateway → mock Kiro, with an approval, session reuse and a worker SIGKILL mid-turn (the turn resumes, nothing is re-prompted, output appears once). CI repeats this on Docker Compose. |
| Web console | Typechecked and built, then exercised in a browser against the in-browser mock |
| Images | `api`, `worker`, `web`, `computer` and `computer-mock` build for amd64 and arm64 in CI and are pushed to `ghcr.io/taituo/orrery-*` from `main` |
| Helm chart | `helm lint` and kubeconform pass in CI. Not yet installed on a live cluster. |

Docs:
- [Architecture](docs/ARCHITECTURE.md)
- [Kiro over ACP compatibility](docs/KIRO.md)
- [OpenCode over ACP](docs/OPENCODE.md)
- [Deployment and configuration](docs/DEPLOYMENT.md)

## Layout

```
packages/
  core           domain model, events, policy engine, config, ids, tokens
  acp            JSON-RPC peer, ACP client, Kiro V3 / v2 / OpenCode / generic adapters, turn runner
  acp-gateway    per-computer ACP gateway (WebSocket, journal, held requests, restarts)
  providers      OpenAI-compatible client, Clef System One client, router, registry
  memory         core + long-term memory, recall, write gate, consolidation
  rag            loaders, chunker, knowledge ingestion and search
  db             Postgres schema, migrations, repositories, LISTEN/NOTIFY, secrets
  workflows      Temporal workflows (bot entity, turn, routines, memory, ingest, janitor)
  tools          platform tools (memory, knowledge, delegation) for MCP and native loops
  observability  logging, OpenTelemetry + Langfuse, turn tracer
  testkit        mock Kiro CLI (V3/v2), fake model servers, test Postgres, gateway smoke tool
apps/
  api            Hono REST + SSE API, OIDC auth, platform MCP server
  worker         Temporal workers (agent / acp / memory queues), bot computer provider
  web            React console; `build:prototype` makes a single-file clickable prototype
```

## Quick start

```sh
cp .env.example .env                       # add KIRO_API_KEY, or:
ORRERY_COMPUTER_TARGET=computer-mock docker compose up --build
open http://localhost:8080                 # sign in with: dev-token
```

## Development

Requires Node 22.12+, pnpm 10, PostgreSQL 16 with pgvector, and a Temporal server (`temporal server start-dev`).

```sh
pnpm install
pnpm typecheck
pnpm test                       # starts a throwaway Postgres if TEST_DATABASE_URL is unset

export DATABASE_URL=postgres://postgres@localhost:5432/orrery
pnpm db:migrate
DEV_AUTH_TOKEN=dev-token pnpm dev:api
COMPUTER_PROVIDER=local KIRO_CLI_PATH=kiro-cli pnpm dev:worker
pnpm dev:web                    # http://localhost:5173 (sign in with the dev token)
pnpm --filter @orrery/web dev -- --open "/?mock=1"   # UI only, simulated data
```

To check a bot computer (or a local gateway) end to end:

```sh
GATEWAY_TOKEN_SECRET=… node --conditions=@orrery/source --import tsx \
  packages/testkit/src/gateway-smoke.ts ws://host:7777/acp cmp_bot_ada v3
```

## License

Apache-2.0
