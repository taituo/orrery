import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { OrreryError } from "@orrery/core";
import type { Queryable } from "./pool.js";

/**
 * Team secrets (MCP header tokens, integration credentials) encrypted with AES-256-GCM under
 * ENCRYPTION_KEY (32 bytes, base64). Referenced from bot configs as `secret://<name>` and only
 * resolved inside workers / bot computers — the API never returns plaintext.
 */
function key(raw: string | undefined): Buffer {
  if (!raw) throw new OrreryError("internal", "ENCRYPTION_KEY is not configured");
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new OrreryError("internal", "ENCRYPTION_KEY must be 32 bytes (base64)");
  return k;
}

export function encryptSecret(plaintext: string, rawKey: string | undefined): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(rawKey), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ct]);
}

export function decryptSecret(blob: Buffer, rawKey: string | undefined): string {
  if (blob[0] !== 1) throw new OrreryError("internal", "unknown secret format");
  const iv = blob.subarray(1, 13);
  const tag = blob.subarray(13, 29);
  const ct = blob.subarray(29);
  const d = createDecipheriv("aes-256-gcm", key(rawKey), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

export const secrets = {
  async put(db: Queryable, teamId: string, name: string, value: string, rawKey: string | undefined): Promise<void> {
    if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(name)) throw new OrreryError("bad_request", "invalid secret name");
    await db.query(
      "INSERT INTO secrets (team_id, name, ciphertext) VALUES ($1, $2, $3) ON CONFLICT (team_id, name) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, created_at = now()",
      [teamId, name, encryptSecret(value, rawKey)],
    );
  },
  async list(db: Queryable, teamId: string): Promise<Array<{ name: string; createdAt: string }>> {
    const r = await db.query("SELECT name, created_at FROM secrets WHERE team_id = $1 ORDER BY name", [teamId]);
    return r.rows.map((x) => ({ name: x.name, createdAt: new Date(x.created_at).toISOString() }));
  },
  async delete(db: Queryable, teamId: string, name: string): Promise<void> {
    await db.query("DELETE FROM secrets WHERE team_id = $1 AND name = $2", [teamId, name]);
  },
  /** Resolve `secret://name` references; other values pass through unchanged. */
  async resolve(db: Queryable, teamId: string, value: string, rawKey: string | undefined): Promise<string> {
    if (!value.startsWith("secret://")) return value;
    const name = value.slice("secret://".length);
    const r = await db.query("SELECT ciphertext FROM secrets WHERE team_id = $1 AND name = $2", [teamId, name]);
    if (!r.rows[0]) throw new OrreryError("not_found", `secret ${name} not found`);
    return decryptSecret(r.rows[0].ciphertext as Buffer, rawKey);
  },
};
