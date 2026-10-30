import { Fragment, type ReactNode } from "react";
import { Link } from "react-router";
import { Orb, OrbStack } from "../components/Orb";
import { useFleet } from "../lib/fleet";
import { useApi, useCan, useLoad } from "../lib/hooks";

function greeting(name: string | null): string {
  const h = new Date().getHours();
  const part = h < 5 ? "good night" : h < 12 ? "good morning" : h < 18 ? "good afternoon" : "good evening";
  const first = (name ?? "").trim().split(/\s+/)[0]?.toLowerCase();
  return first ? `${part}, ${first}.` : `${part}.`;
}

/** Home: who is here, what they are doing, and what needs you. Nothing else. */
export function HomePage({ onNewGroup }: { onNewGroup: () => void }) {
  const { me, pulse } = useApi();
  const isAdmin = useCan("admin");
  const canWrite = useCan("member");
  const { bots, activity, approvals } = useFleet();
  const groups = useLoad((a) => a.listGroups(), [pulse]);
  const setup = useLoad((a) => (isAdmin ? a.setup() : Promise.resolve(null)), []);
  const live = bots.filter((b) => b.status !== "archived");

  const waiting = live.filter((b) => activity[b.id] === "waiting");
  const working = live.filter((b) => activity[b.id] === "working");
  const lines: ReactNode[] = [];
  if (waiting.length)
    lines.push(
      <Fragment key="w">
        {join(waiting.map((b) => <Link key={b.id} className="waiting" to={approvals.length > 1 ? "/approvals" : `/bots/${b.id}`}>{b.name}</Link>))} {waiting.length === 1 ? "is" : "are"} waiting for your approval.{" "}
      </Fragment>,
    );
  if (working.length)
    lines.push(
      <Fragment key="k">
        {join(working.map((b) => <Link key={b.id} to={`/bots/${b.id}`}>{b.name}</Link>))} {working.length === 1 ? "is" : "are"} working.{" "}
      </Fragment>,
    );
  if (!lines.length && live.length) lines.push(<Fragment key="q">Everyone is quiet. Who do you want to talk to?</Fragment>);
  const needsModel = setup.data && !setup.data.agentEnv.length && !setup.data.providers.chat.length;

  return (
    <div className="home">
      <h1>{greeting(me.name)}</h1>
      {!live.length ? (
        <p className="say">
          {canWrite ? (
            <>
              No bots yet. <Link to="/bots/new">Create the first one</Link>
              {needsModel ? (
                <>
                  , after you <Link to="/settings">give your bots a model</Link>.
                </>
              ) : (
                "."
              )}
            </>
          ) : (
            "No bots yet."
          )}
        </p>
      ) : (
        <p className="say">
          {lines}
          {needsModel && (
            <>
              {" "}
              Bots have no model credentials yet: <Link to="/settings">add one in settings</Link>.
            </>
          )}
        </p>
      )}
      <nav className="orbit-row" aria-label="Bots">
        {live.map((b) => (
          <Link key={b.id} to={`/bots/${b.id}`} aria-label={`${b.name}, ${activity[b.id] ?? "idle"}`}>
            <Orb id={b.id} name={b.name} avatar={b.avatar ?? null} activity={activity[b.id]} size="xl" />
            {b.name}
          </Link>
        ))}
        {canWrite && (
          <Link to="/bots/new" aria-label="New bot">
            <span className="orb xl add">+</span>
            New bot
          </Link>
        )}
      </nav>
      {(groups.data?.length ?? 0) > 0 && (
        <nav className="orbit-row" aria-label="Groups">
          {groups.data!.map((g) => (
            <Link key={g.id} to={`/groups/${g.id}`}>
              <OrbStack members={g.members} size="lg" />
              {g.name}
            </Link>
          ))}
        </nav>
      )}
      <div className="home-foot">
        {canWrite && live.length > 1 && (
          <button className="btn" onClick={onNewGroup}>
            Start a group
          </button>
        )}
        {approvals.length > 0 && (
          <Link className="btn" to="/approvals">
            Review approvals
          </Link>
        )}
      </div>
    </div>
  );
}

function join(items: ReactNode[]): ReactNode {
  if (items.length <= 1) return items;
  return items.flatMap((x, i) => (i === 0 ? [x] : i === items.length - 1 ? [" and ", x] : [", ", x]));
}
