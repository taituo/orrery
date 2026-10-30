import { describe, expect, it } from "vitest";
import { BotCreateSchema, loadEnv, type Bot } from "@orrery/core";
import { gatewayKeyFor } from "@orrery/acp";
import { computerManifests, podWaitReason } from "../src/computers.js";

const MASTER = "platform-gateway-secret-0123456789";
const env = (extra: Record<string, string> = {}) =>
  loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://x@localhost/x",
    GATEWAY_TOKEN_SECRET: MASTER,
    MCP_TOKEN_SECRET: "mcp-secret-0123456789abcdef",
    ENCRYPTION_KEY: "bG9jYWwtZGV2LWVuY3J5cHRpb24ta2V5LTMyYnl0ZXM=",
    COMPUTER_PROVIDER: "kubernetes",
    COMPUTER_IMAGE: "ghcr.io/taituo/orrery-computer:main",
    ...extra,
  });

const bot = (over: Partial<Bot> = {}): Bot => ({
  ...BotCreateSchema.parse({ name: "Ada", primary: { kind: "kiro-acp", engine: "v3" } }),
  id: "bot_ada",
  teamId: "team_default",
  status: "active",
  createdAt: "2026-10-30T10:00:00Z",
  updatedAt: "2026-10-30T10:00:00Z",
  ...over,
});

const find = <T>(objects: unknown[], kind: string) => objects.find((o) => (o as { kind: string }).kind === kind) as T;
type Pod = { spec: { imagePullSecrets?: Array<{ name: string }>; containers: Array<{ env: Array<{ name: string; value?: string }>; envFrom: Array<{ secretRef: { name: string } }> }> } };
type Secret = { metadata: { name: string }; stringData: Record<string, string> };

describe("bot computer manifests", () => {
  it("gives each computer its own gateway key; the platform secret never leaves the platform namespace", () => {
    const { objects, name } = computerManifests(bot(), env(), { secretEnv: { ANTHROPIC_API_KEY: "sk-ant" } });
    const secret = find<Secret>(objects, "Secret");
    expect(secret.metadata.name).toBe(`${name}-env`);
    expect(secret.stringData.GATEWAY_TOKEN_KEY).toBe(gatewayKeyFor(MASTER, computerIdOf(objects)));
    expect(secret.stringData.ANTHROPIC_API_KEY).toBe("sk-ant");
    expect(JSON.stringify(objects)).not.toContain(MASTER);
    const pod = find<Pod>(objects, "Pod");
    expect(pod.spec.containers[0]!.envFrom.map((e) => e.secretRef.name)).toEqual(["orrery-agent-env", `${name}-env`]);
    expect(pod.spec.imagePullSecrets).toBeUndefined();
  });

  it("uses pull secrets for the computer image when configured", () => {
    const { objects } = computerManifests(bot(), env({ COMPUTER_IMAGE_PULL_SECRETS: "regcred, other" }));
    expect(find<Pod>(objects, "Pod").spec.imagePullSecrets).toEqual([{ name: "regcred" }, { name: "other" }]);
  });

  it("rolls the computer when a credential changes, and only then", () => {
    const a = computerManifests(bot(), env(), { secretEnv: { OPENAI_API_KEY: "one" } }).specHash;
    expect(computerManifests(bot(), env(), { secretEnv: { OPENAI_API_KEY: "one" } }).specHash).toBe(a);
    expect(computerManifests(bot(), env(), { secretEnv: { OPENAI_API_KEY: "two" } }).specHash).not.toBe(a);
  });

  it("a Kiro key set in the console replaces the cluster's Kiro secret", () => {
    const withKey = find<Pod>(computerManifests(bot(), env(), { secretEnv: { KIRO_API_KEY: "k" } }).objects, "Pod");
    const without = find<Pod>(computerManifests(bot(), env()).objects, "Pod");
    expect(withKey.spec.containers[0]!.env.some((e) => e.name === "KIRO_API_KEY")).toBe(false);
    expect(without.spec.containers[0]!.env.some((e) => e.name === "KIRO_API_KEY")).toBe(true);
  });
});

describe("waiting for a computer", () => {
  it("says why a pod is not starting", () => {
    expect(podWaitReason(null)).toMatch(/does not exist/);
    expect(podWaitReason({ status: { conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable", message: "0/1 nodes are available: 1 Insufficient cpu." }] } })).toMatch(/no room for it \(0\/1 nodes are available: 1 Insufficient cpu\.\)/);
    expect(podWaitReason({ status: { containerStatuses: [{ name: "computer", image: "x", imageID: "", ready: false, restartCount: 0, state: { waiting: { reason: "ImagePullBackOff", message: "pull access denied" } } }] } })).toBe("ImagePullBackOff: pull access denied");
    expect(podWaitReason({ status: { containerStatuses: [{ name: "computer", image: "x", imageID: "", ready: false, restartCount: 0, state: { waiting: { reason: "ContainerCreating" } } }] } })).toBeNull();
  });
});

function computerIdOf(objects: unknown[]): string {
  const pod = find<Pod>(objects, "Pod");
  return pod.spec.containers[0]!.env.find((e) => e.name === "COMPUTER_ID")!.value!;
}
