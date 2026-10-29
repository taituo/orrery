import { Context } from "@temporalio/activity";
import { OrreryError } from "@orrery/core";
import { bots } from "@orrery/db";
import type { MemoryActivities } from "@orrery/workflows";
import type { WorkerDeps } from "../context.js";
import { wrap } from "./agent.js";

export function createMemoryActivities(deps: WorkerDeps): MemoryActivities {
  return {
    consolidateMemories: ({ teamId, botId }) =>
      wrap(async () => {
        const bot = await bots.getById(deps.db, botId);
        if (!bot) throw new OrreryError("not_found", `bot ${botId} not found`);
        const total = { episodes: 0, created: 0, updated: 0, superseded: 0, skipped: 0, decayed: 0 };
        // Drain the backlog in batches so one activity attempt stays short-lived per batch.
        for (let i = 0; i < 40; i++) {
          const s = await deps.memory.consolidate({ teamId, botId, botName: bot.name, autoExtract: bot.memory.autoExtract, batch: 20 });
          for (const k of Object.keys(total) as Array<keyof typeof total>) total[k] += s[k];
          Context.current().heartbeat(total);
          if (s.episodes < 20) break;
        }
        return total;
      }),

    ingestSource: ({ sourceId }) =>
      wrap(async () => {
        const ctx = Context.current();
        return deps.knowledge.ingestSource(sourceId, (p) => ctx.heartbeat(p));
      }),
  };
}
