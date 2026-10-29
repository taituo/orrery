import { useMemo } from "react";
import type { Approval, Bot, Run } from "../api";
import type { BotActivity } from "../components/ui";
import { useApi, useLoad } from "./hooks";

/** Bots with their live activity, refreshed on team notices. */
export function useFleet() {
  const { pulse } = useApi();
  const q = useLoad(async (api) => {
    const [bots, active, approvals] = await Promise.all([api.listBots(), api.activeRuns(), api.listApprovals()]);
    return { bots, active, approvals };
  }, [pulse]);
  const activity = useMemo(() => {
    const out: Record<string, BotActivity> = {};
    for (const b of q.data?.bots ?? []) out[b.id] = activityOf(b, q.data!.active, q.data!.approvals);
    return out;
  }, [q.data]);
  return { ...q, bots: q.data?.bots ?? [], active: q.data?.active ?? [], approvals: q.data?.approvals ?? [], activity };
}

export function activityOf(b: Bot, active: Run[], approvals: Approval[]): BotActivity {
  if (b.status === "paused") return "paused";
  if (approvals.some((a) => a.botId === b.id)) return "waiting";
  if (active.some((r) => r.botId === b.id)) return "working";
  return "idle";
}
