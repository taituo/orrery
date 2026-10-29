import { Auth, type OidcConfig } from "./auth";
import { HttpApi } from "./http";
import type { OrreryApi } from "./types";

declare const __ORRERY_PROTOTYPE__: boolean;

export interface RuntimeConfig {
  apiUrl: string;
  oidc: OidcConfig | null;
  langfuseUrl: string | null;
  mock: boolean;
}

declare global {
  interface Window {
    __ORRERY_CONFIG__?: Partial<RuntimeConfig>;
  }
}

export const config: RuntimeConfig = {
  apiUrl: "",
  oidc: null,
  langfuseUrl: null,
  mock: false,
  ...(typeof window !== "undefined" ? window.__ORRERY_CONFIG__ : {}),
};

export const isPrototype = __ORRERY_PROTOTYPE__;
export const useMock = isPrototype || config.mock || new URLSearchParams(location.search).has("mock");

export const auth = new Auth(config.oidc);

let unauthorizedHandler: () => void = () => undefined;
export const onUnauthorized = (fn: () => void) => {
  unauthorizedHandler = fn;
};

async function createApi(): Promise<OrreryApi> {
  if (useMock) {
    const { MockApi } = await import("./mock");
    return new MockApi();
  }
  return new HttpApi(config.apiUrl.replace(/\/+$/, ""), () => auth.token(), () => unauthorizedHandler());
}

export const apiPromise = createApi();
export * from "./types";
