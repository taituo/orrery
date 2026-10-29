# Kiro over ACP: compatibility

Orrery drives Kiro through the Agent Client Protocol (ACP v1: JSON-RPC 2.0, newline-delimited over stdio). Kiro runs inside each bot computer behind the Orrery ACP gateway. Workers reach the gateway over an authenticated WebSocket.

Pick the engine per bot (`primary.engine`):

| Engine | Launch | Use when |
| --- | --- | --- |
| `v3` (default) | `kiro-cli acp --agent-engine=v3 [--auth-method=client]` | Kiro CLI with the V3 agent engine |
| `v2` | `kiro-cli acp [--agent <name>] [--model <id>]` | Older CLI builds, or custom v2 agents |
| `auto` | tries V3; falls back to v2 when the binary rejects `--agent-engine` | Mixed fleets |

## Behaviour by engine

| Concern | Kiro CLI V3 | Kiro CLI v2 |
| --- | --- | --- |
| Mode / agent | `_meta.kiro.modeId` on `session/new`; `session/set_mode` afterwards | `--agent` launch flag; reported via `_kiro.dev/agent/switched` |
| Model | `_meta.kiro.modelId` on `session/new`; `session/set_config_option` (`model`). `session/set_model` is not used. | `--model` launch flag; `session/set_model` |
| Effort | `_meta.kiro.effortLevel` / `set_config_option` (`effortLevel`) | `/effort` command |
| Values | validated against what the server advertises; never invented | validated against `availableModels` |
| MCP servers | sent on `session/new` and **re-sent on `session/load`** | sent on `session/new` |
| Turn completion | settled only by the `session/prompt` response. `session_info_update` with `kind: turn_end` is not completion. | `session/prompt` response |
| Usage / credits | `usage_update`, plus `session_info_update` with `kind: context_usage` / `turn_completion` (`promptTurnSummaries`) | `_kiro.dev/metadata` (credits, context %) |
| Steering | `_session/steer` (advertised in `agentCapabilities._meta.kiro.extensionMethods`); `steering_queued` / `steering_injected` / `steering_cleared` | `_message/send` |
| Compaction | `_kiro/session/compact` | `_kiro.dev/commands/execute` → `/compact`; `_kiro.dev/compaction/status` |
| Commands | `available_commands_update` | `_kiro.dev/commands/available`; executed with nested `{command:{command,args}}` |
| Tool streaming | `tool_call` / `tool_call_update` | `_kiro.dev/session/update` → `tool_call_chunk`, then standard updates |
| MCP status | `_kiro/mcp/status` (full snapshot); `_kiro/tools/didChange` | `_kiro.dev/mcp/*` |
| Permissions | `session/request_permission` with `_meta.kiro.consent` (capability, resource, workspace root, persistable) | `_meta.trustOptions` on the request, `_meta.trustOption` on the response |
| MCP tool identity | `_meta.kiro.mcpTool` (v1 identity + annotations) | flat `mcpToolIdentity` / `mcpAnnotations` |
| Failure reasons | `_meta.kiro.failureReason` on tool updates | — |
| Replay on load | `_meta.kiro.replay` marks replayed history; replayed content is not re-emitted | history replayed on load is suppressed outside an in-flight prompt |
| Browser sign-in for MCP OAuth | `_kiro/openExternalUrl` (client advertises `clientCapabilities._meta.kiro.openExternalUrl`) → shown in the console | `_kiro.dev/mcp/oauth_request` |
| Auth | CLI's own login / `KIRO_API_KEY`, or `--auth-method=client` + `_kiro/auth/getAccessToken` | `KIRO_API_KEY` |
| Sessions | list / load / resume / fork / close (when advertised) | `_kiro.dev/session/list`, load |

## Rules Orrery follows

- **Never resend a prompt.** A retried worker re-attaches to the gateway and waits for the same request key. If no checkpoint exists, it adopts the running prompt from the gateway journal.
- **Unknown agent→client requests get an explicit JSON-RPC error** (`-32601`), never silence.
- **Unknown updates never fail a session.** They are kept as `unknown_update` / `extension` events.
- **Permission decisions use only the options the agent offered.** Persistent consent is honoured only when the agent marks the request persistable and an admin chooses it.
- **Extension notifications stay ordered with `session/update`** in one per-session queue. Behind the gateway they share the session's sequence space.
- **MCP annotations are untrusted.** They are shown in the UI but never used to auto-approve or to lower risk.

## Verification

The adapters are tested against a wire-faithful mock built from the Kiro documentation (`packages/testkit/src/mock-kiro.ts`). The tests:

- run over stdio and through the gateway;
- check launch flags against the right generation (V3 rejects v2-only flags and vice versa);
- check interop with the official ACP SDK and conformance with the official ACP JSON schema.

`packages/testkit/src/gateway-smoke.ts` runs a real turn against any gateway, including a bot computer running the real `kiro-cli`:

```sh
GATEWAY_TOKEN_SECRET=… node --conditions=@orrery/source --import tsx \
  packages/testkit/src/gateway-smoke.ts ws://orrery-cmp-bot-ada.orrery-computers.svc:7777/acp cmp_bot_ada v3
```

The first run against a real Kiro CLI build is the most valuable test still to do. Please report any mismatch along with the gateway's debug log (`LOG_LEVEL=debug`).
