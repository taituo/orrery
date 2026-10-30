# OpenCode over ACP

Orrery runs [OpenCode](https://opencode.ai) as a bot's agent through the Agent Client Protocol (`opencode acp`). It uses the same path as Kiro: the agent process lives in the bot's computer behind the Orrery ACP gateway, and workers drive turns over an authenticated WebSocket. Durable turns, journal replay, held permission requests, approvals, policies, Langfuse tracing and memory all work the same way.

Verified against **opencode 1.19.5** (the version installed in the `computer` image and in CI).

## A bot on OpenCode

```jsonc
"primary": {
  "kind": "opencode-acp",
  "modelId": "orrery-local-vllm/qwen3-235b-a22b",   // provider/model, see below
  "smallModelId": "orrery-local-vllm/qwen3-30b-a3b",  // optional: titles and summaries
  "modeId": "build",                                  // optional: OpenCode agent (build, plan, custom)
  "permissions": "orrery",                            // orrery (default) | agent
  "config": { "agent": { "review": { "description": "Reviews diffs" } } }  // optional, merged in
}
```

In the console, choose **OpenCode (ACP)** as the engine.

### Models

- **`orrery-<provider>/<model>`** uses one of the platform's OpenAI-compatible providers (`providers.yaml`) whose roles include `chat` or `fast`. Orrery passes it to OpenCode through `@ai-sdk/openai-compatible` with the provider's base URL and headers. The API key is a `{env:…}` reference to the provider's `apiKeyEnv`, so the key itself never appears in the config. The API rejects ids that name a provider or model the platform doesn't serve.
- **Any other `provider/model`** that OpenCode knows (`anthropic/…`, `openai/…`, `openrouter/…`, …) uses the credentials in the computer's agent environment secret (below).

Model and agent are applied per session with `session/set_config_option`, checked against what the session advertises. A value OpenCode doesn't offer is reported as a notice on the turn; Orrery never invents one.

## Governance

With `permissions: "orrery"` (the default), every tool call is asked over ACP and decided by the bot's policy, guardrail and approvals, exactly as for Kiro. OpenCode offers *once / always / reject*. Automatic decisions only ever use the one-time options.

Probing opencode 1.19.5 turned up two ways an agent could get around a top-level `permission: {"*": "ask"}`. Orrery closes both:

| Finding | What Orrery does |
| --- | --- |
| An agent-level `permission` in any lower-precedence config (global, project `opencode.json`, `.opencode/`) overrides the top-level rule | The generated config sets `{"*": "ask"}` on every tool-running agent (`build`, `plan`, `general`, `explore`) and on every agent defined in the bot's extra config. That inline config is applied last, so it wins. |
| The workspace is writable by the agent, so it could write a project config that grants itself permissions | `OPENCODE_DISABLE_PROJECT_CONFIG=true`. The workspace's `AGENTS.md` is still loaded, listed explicitly in `instructions`. |

Two more points:
- Writes to OpenCode's global config (`~/.config/opencode`) fall outside the workspace, so they are subject to the bot's policy too.
- `permissions: "agent"` hands the decisions to OpenCode's own rules. Use it only for trusted, sandboxed bots.

Read permissions from OpenCode carry an empty `rawInput`. The adapter fills it in from the tool call it has already seen, so path rules work: the default `no-secrets-read` rule denies reading `**/.ssh/**`. The integration tests cover this.

## Differences from Kiro

| | OpenCode | Effect in Orrery |
| --- | --- | --- |
| Mid-turn steering | not supported | "Steer" becomes "queue next": the message runs as the next turn. Guidance that can't be injected is never dropped; it is re-queued through the delivery outbox. |
| Compaction | OpenCode compacts on its own | no `/compact` command from Orrery |
| Usage | tokens in the prompt response | recorded per run; no credits |
| Standing instructions | `instructions` file (`/etc/orrery/bot/instructions.md`, from the bot's instructions) | — |
| Session restore | `session/load` replays history as plain updates | replayed content is not re-emitted as new output |

## Credentials and network

- **Kubernetes:** model keys go in the agent environment secret. Every key becomes an environment variable in bot computers. Either set `computers.agentEnv.values` (the chart creates the secret) or point `computers.agentEnv.existingSecret` at your own:

  ```sh
  kubectl -n orrery-computers create secret generic orrery-agent-env \
    --from-literal=ANTHROPIC_API_KEY=… --from-literal=VLLM_API_KEY=…
  ```

  `restricted` bots without Cilium can reach public HTTPS only. For an in-cluster model server, add an egress rule with `computers.networkPolicy.extraEgress`. With Cilium, add the provider's API host to the bot's allowed hosts.
- **Compose:** `ORRERY_AGENT_KIND=opencode docker compose up --build`, with `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in `.env` or a full config in `OPENCODE_CONFIG_CONTENT`. Without a config the gateway uses Orrery's default (tools governed by the bot's policy).

Workers generate the OpenCode config per bot (`OPENCODE_CONFIG_CONTENT`). A config that OpenCode rejects is reported as `agent_config_invalid`: the turn fails straight away with the reason, and the computer isn't restarted in a loop.

## Verification

- `packages/acp/test/opencode.test.ts`: the adapter (launch, permission enrichment, edit and shell facts), config generation (governance rules, providers, instructions), and startup failure classification.
- `packages/testkit/test/opencode.real.test.ts`: the **real binary** through the gateway, with the fake OpenAI-compatible model server. It covers:
  - shell under policy, and a read denied by policy;
  - session reuse, model and agent selection, and unknown values;
  - writes through the workspace, cancellation, and session load after an agent restart;
  - a hostile project config being ignored;
  - an invalid config being classified.

  CI installs `opencode-ai@1.19.5` and runs it with `OPENCODE_TEST=1`.
- CI job **end-to-end (compose + real OpenCode)**: API → Temporal → worker → gateway → OpenCode. It includes an approval and session reuse, and kills the worker while a turn waits for approval. The restarted worker continues with the same approval, and the tool runs once.
