/**
 * Browser sign-in: OpenID Connect authorization code flow with PKCE (no client secret), tokens
 * kept in sessionStorage. When no IdP is configured (local development) a developer token can
 * be pasted instead; the API only accepts it outside production.
 */
export interface OidcConfig {
  issuer: string;
  clientId: string;
  scope?: string;
  audience?: string;
}

const KEY = "orrery.auth";
const PKCE = "orrery.pkce";

interface Stored {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
}

const store = {
  get(): Stored | null {
    try {
      return JSON.parse(sessionStorage.getItem(KEY) ?? "null") as Stored | null;
    } catch {
      return null;
    }
  },
  set(v: Stored | null) {
    try {
      if (v) sessionStorage.setItem(KEY, JSON.stringify(v));
      else sessionStorage.removeItem(KEY);
    } catch {
      /* storage unavailable: session-only */
    }
  },
};

const b64url = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function discover(issuer: string): Promise<{ authorization_endpoint: string; token_endpoint: string; end_session_endpoint?: string }> {
  const r = await fetch(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`);
  if (!r.ok) throw new Error(`OIDC discovery failed (${r.status})`);
  return r.json();
}

export class Auth {
  private memoryToken: string | null = null;
  constructor(private readonly oidc: OidcConfig | null) {}

  get configured(): boolean {
    return Boolean(this.oidc);
  }

  async token(): Promise<string | null> {
    if (this.memoryToken) return this.memoryToken;
    const s = store.get();
    if (!s) return null;
    if (s.expiresAt - 30_000 > Date.now()) return s.accessToken;
    if (s.refreshToken && this.oidc) {
      try {
        return await this.refresh(s.refreshToken);
      } catch {
        store.set(null);
      }
    }
    return s.expiresAt > Date.now() ? s.accessToken : null;
  }

  useDeveloperToken(token: string): void {
    this.memoryToken = token;
    store.set({ accessToken: token, expiresAt: Date.now() + 12 * 3600_000 });
  }

  async login(): Promise<void> {
    if (!this.oidc) throw new Error("No identity provider configured");
    const meta = await discover(this.oidc.issuer);
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const state = b64url(crypto.getRandomValues(new Uint8Array(16)).buffer);
    sessionStorage.setItem(PKCE, JSON.stringify({ verifier, state, returnTo: location.pathname + location.search + location.hash }));
    const u = new URL(meta.authorization_endpoint);
    u.search = new URLSearchParams({
      response_type: "code",
      client_id: this.oidc.clientId,
      redirect_uri: `${location.origin}/auth/callback`,
      scope: this.oidc.scope ?? "openid profile email offline_access",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      ...(this.oidc.audience ? { audience: this.oidc.audience } : {}),
    }).toString();
    location.assign(u.toString());
  }

  /** Completes the redirect; returns where to go next, or null if this isn't a callback. */
  async handleCallback(): Promise<string | null> {
    if (!this.oidc || location.pathname !== "/auth/callback") return null;
    const params = new URLSearchParams(location.search);
    const saved = JSON.parse(sessionStorage.getItem(PKCE) ?? "null") as { verifier: string; state: string; returnTo: string } | null;
    sessionStorage.removeItem(PKCE);
    if (params.get("error")) throw new Error(params.get("error_description") ?? params.get("error")!);
    if (!saved || params.get("state") !== saved.state) throw new Error("Sign-in state did not match. Start sign-in again.");
    const meta = await discover(this.oidc.issuer);
    const r = await fetch(meta.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: params.get("code") ?? "", redirect_uri: `${location.origin}/auth/callback`, client_id: this.oidc.clientId, code_verifier: saved.verifier }),
    });
    if (!r.ok) throw new Error(`Token exchange failed (${r.status})`);
    this.save(await r.json());
    return saved.returnTo || "/";
  }

  private async refresh(refreshToken: string): Promise<string> {
    const meta = await discover(this.oidc!.issuer);
    const r = await fetch(meta.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: this.oidc!.clientId }),
    });
    if (!r.ok) throw new Error("refresh failed");
    return this.save(await r.json());
  }

  private save(t: { access_token: string; expires_in?: number; refresh_token?: string }): string {
    store.set({ accessToken: t.access_token, expiresAt: Date.now() + (t.expires_in ?? 300) * 1000, ...(t.refresh_token ? { refreshToken: t.refresh_token } : {}) });
    return t.access_token;
  }

  logout(): void {
    this.memoryToken = null;
    store.set(null);
  }
}
