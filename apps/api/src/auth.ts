import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { timingSafeEqual } from "node:crypto";
import { OrreryError, type Env } from "@orrery/core";
import { teams, users, type Db } from "@orrery/db";

export type Role = "owner" | "admin" | "member" | "viewer";

export interface Principal {
  userId: string;
  teamId: string;
  role: Role;
  name: string | null;
  email: string | null;
}

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export function hasRole(p: Principal, min: Role): boolean {
  return RANK[p.role] >= RANK[min];
}

export function requireRole(p: Principal, min: Role): void {
  if (!hasRole(p, min)) throw new OrreryError("forbidden", `requires ${min} role`);
}

function normalizeRole(v: unknown): Role {
  const s = String(Array.isArray(v) ? v[0] : (v ?? "member")).toLowerCase();
  if (s.includes("owner")) return "owner";
  if (s.includes("admin")) return "admin";
  if (s.includes("viewer") || s.includes("read")) return "viewer";
  return "member";
}

/**
 * Authentication: OIDC bearer JWTs (any compliant IdP — Keycloak, Auth0, Entra, Okta, Dex),
 * verified against the issuer's JWKS; team and role come from configurable claims. A static
 * development token is accepted only outside production.
 */
export class Authenticator {
  private jwks: Promise<ReturnType<typeof createRemoteJWKSet>> | null;
  private readonly cache = new Map<string, { p: Principal; exp: number }>();

  constructor(private readonly env: Env, private readonly db: Db) {
    this.jwks = env.OIDC_ISSUER ? this.discover(env.OIDC_ISSUER) : null;
  }

  /** OIDC discovery → jwks_uri (falls back to the conventional path). */
  private async discover(issuer: string): Promise<ReturnType<typeof createRemoteJWKSet>> {
    const base = issuer.replace(/\/+$/, "");
    try {
      const r = await fetch(`${base}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
      if (r.ok) {
        const doc = (await r.json()) as { jwks_uri?: string };
        if (doc.jwks_uri) return createRemoteJWKSet(new URL(doc.jwks_uri));
      }
    } catch {
      /* fall back */
    }
    return createRemoteJWKSet(new URL(`${base}/.well-known/jwks.json`));
  }

  async authenticate(authorization: string | undefined | null): Promise<Principal> {
    const token = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1]?.trim();
    if (!token) throw new OrreryError("unauthorized", "missing bearer token");

    if (this.env.DEV_AUTH_TOKEN && this.env.NODE_ENV !== "production") {
      const a = Buffer.from(token);
      const b = Buffer.from(this.env.DEV_AUTH_TOKEN);
      if (a.length === b.length && timingSafeEqual(a, b)) return this.devPrincipal();
      if (token.startsWith(`${this.env.DEV_AUTH_TOKEN}:`)) {
        // dev-only role impersonation for local testing of RBAC: "<token>:viewer"
        const role = normalizeRole(token.slice(this.env.DEV_AUTH_TOKEN.length + 1));
        const base = await this.devPrincipal();
        return { ...base, role, userId: `usr_dev_${role}` };
      }
    }
    if (!this.jwks) throw new OrreryError("unauthorized", "invalid token");

    const cached = this.cache.get(token);
    if (cached && cached.exp > Date.now()) return cached.p;
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, await this.jwks, { issuer: this.env.OIDC_ISSUER, ...(this.env.OIDC_AUDIENCE ? { audience: this.env.OIDC_AUDIENCE } : {}) }));
    } catch {
      throw new OrreryError("unauthorized", "invalid token");
    }
    const teamId = String((payload as Record<string, unknown>)[this.env.OIDC_TEAM_CLAIM] ?? "");
    if (!teamId) throw new OrreryError("forbidden", `token has no ${this.env.OIDC_TEAM_CLAIM} claim`);
    await teams.ensure(this.db, teamId, teamId);
    const role = normalizeRole((payload as Record<string, unknown>)[this.env.OIDC_ROLE_CLAIM]);
    const u = await users.upsertExternal(this.db, {
      teamId,
      externalId: String(payload.sub),
      email: typeof payload.email === "string" ? payload.email : null,
      name: typeof payload.name === "string" ? payload.name : null,
      role,
    });
    const p: Principal = { userId: u.id, teamId, role, name: u.name, email: u.email };
    this.cache.set(token, { p, exp: Math.min((payload.exp ?? 0) * 1000, Date.now() + 5 * 60_000) });
    if (this.cache.size > 10_000) this.cache.clear();
    return p;
  }

  private devTeamReady: Promise<void> | null = null;

  private async devPrincipal(): Promise<Principal> {
    this.devTeamReady ??= teams.ensure(this.db, this.env.DEV_TEAM_ID, "Development").catch((err: unknown) => {
      this.devTeamReady = null;
      throw err;
    });
    await this.devTeamReady;
    return { userId: "usr_dev", teamId: this.env.DEV_TEAM_ID, role: "owner", name: "Developer", email: "dev@localhost" };
  }
}
