import { z } from "zod";

/**
 * Minimal OpenAPI 3.1 registry: routes declare zod schemas once; they are used both for
 * runtime validation and for the generated spec (served at /openapi.json).
 */
export interface RouteDoc {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  summary: string;
  tag: string;
  role?: string;
  body?: z.ZodType;
  query?: z.ZodType;
  stream?: boolean;
}

export class OpenApiRegistry {
  readonly routes: RouteDoc[] = [];

  add(doc: RouteDoc): void {
    this.routes.push(doc);
  }

  document(info: { title: string; version: string; serverUrl: string }): Record<string, unknown> {
    const paths: Record<string, Record<string, unknown>> = {};
    for (const r of this.routes) {
      const p = r.path.replace(/:([a-zA-Z]+)/g, "{$1}");
      const params = [...r.path.matchAll(/:([a-zA-Z]+)/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
      if (r.query) {
        const js = z.toJSONSchema(r.query) as { properties?: Record<string, unknown>; required?: string[] };
        for (const [name, schema] of Object.entries(js.properties ?? {})) params.push({ name, in: "query", required: (js.required ?? []).includes(name), schema } as never);
      }
      paths[p] ??= {};
      paths[p]![r.method] = {
        summary: r.summary,
        tags: [r.tag],
        ...(params.length ? { parameters: params } : {}),
        ...(r.body ? { requestBody: { required: true, content: { "application/json": { schema: z.toJSONSchema(r.body, { io: "input", unrepresentable: "any" }) } } } } : {}),
        responses: r.stream
          ? { "200": { description: "Server-sent events", content: { "text/event-stream": { schema: { type: "string" } } } } }
          : { "200": { description: "OK", content: { "application/json": { schema: {} } } }, "4XX": { description: "Error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } } },
        ...(r.role ? { "x-required-role": r.role } : {}),
      };
    }
    return {
      openapi: "3.1.0",
      info: { title: info.title, version: info.version, description: "Orrery API — durable AI teammates on Temporal with Kiro ACP." },
      servers: [{ url: info.serverUrl }],
      security: [{ bearer: [] }],
      components: {
        securitySchemes: { bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
        schemas: {
          Error: { type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, retryable: { type: "boolean" } } } } },
        },
      },
      paths,
    };
  }
}
