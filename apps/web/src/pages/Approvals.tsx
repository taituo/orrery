import { Link } from "react-router";
import { ApprovalCard } from "../components/Run";
import { Avatar, Empty, ErrorBox } from "../components/ui";
import { relTime } from "../lib/format";
import { useApi, useLoad } from "../lib/hooks";

export function ApprovalsPage() {
  const { pulse } = useApi();
  const q = useLoad(async (api) => {
    const [approvals, bots] = await Promise.all([api.listApprovals(), api.listBots()]);
    return { approvals, bots: new Map(bots.map((b) => [b.id, b])) };
  }, [pulse]);
  const list = q.data?.approvals ?? [];
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Approvals</h1>
          <p>Tool calls your policies send to a human. Bots keep their place in the turn while they wait; the options are exactly the ones the agent offered.</p>
        </div>
      </div>
      <ErrorBox error={q.error} />
      {!q.loading && !list.length ? (
        <Empty title="Nothing is waiting on you">When a bot asks to run something your policy marks for review, it shows up here and in the conversation.</Empty>
      ) : (
        <div className="panel">
          {list.map((a) => {
            const bot = q.data!.bots.get(a.botId);
            return (
              <div key={a.id} className="approval-row">
                <div className="stack" style={{ gap: 8, minWidth: 0 }}>
                  <div className="row wrap">
                    {bot && <Avatar bot={bot} activity="waiting" size="sm" />}
                    <strong>{bot?.name ?? a.botId}</strong>
                    <span className="muted small">wants to run</span>
                    <span className="chip">{a.capability}</span>
                    {a.mcpTool?.server && <span className="chip">MCP: {a.mcpTool.server}</span>}
                    <span className="xs faint">{relTime(a.createdAt)}</span>
                  </div>
                  <ApprovalCard
                    a={{
                      approvalId: a.id,
                      toolCall: { toolCallId: a.toolCallId, title: a.title, kind: a.kind, status: "pending", rawInput: a.rawInput },
                      options: a.options,
                      ...(a.consent ? { consent: a.consent } : {}),
                      policy: { ...(a.risk !== null ? { risk: a.risk } : {}) },
                      expiresAt: a.expiresAt,
                    }}
                  />
                </div>
                <div>
                  <Link className="btn sm" to={`/bots/${a.botId}/t/${a.threadId}`}>
                    Open conversation
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
