import { readFileSync } from "node:fs";
import { Connection, type ConnectionOptions } from "@temporalio/client";
import type { Env } from "@orrery/core";

/** Same connection settings as the workers: plain, mTLS (cert/key files) or Temporal Cloud API key. */
export function temporalConnectionOptions(env: Env): ConnectionOptions {
  const tls =
    env.TEMPORAL_TLS || env.TEMPORAL_API_KEY
      ? env.TEMPORAL_TLS_CERT_PATH && env.TEMPORAL_TLS_KEY_PATH
        ? { clientCertPair: { crt: readFileSync(env.TEMPORAL_TLS_CERT_PATH), key: readFileSync(env.TEMPORAL_TLS_KEY_PATH) } }
        : {}
      : undefined;
  return {
    address: env.TEMPORAL_ADDRESS,
    connectTimeout: "5s",
    ...(tls ? { tls } : {}),
    ...(env.TEMPORAL_API_KEY ? { apiKey: env.TEMPORAL_API_KEY, metadata: { "temporal-namespace": env.TEMPORAL_NAMESPACE } } : {}),
  };
}

/**
 * Lazy connection: the API starts (and serves reads, auth, SSE) even while Temporal is
 * unreachable; calls that need Temporal fail with a retryable error until it is back.
 */
export function lazyTemporalConnection(env: Env): Connection {
  return Connection.lazy(temporalConnectionOptions(env));
}
