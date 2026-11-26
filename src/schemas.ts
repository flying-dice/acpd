import { z } from "zod";

/**
 * Schemas for everything acpd sends or forwards. The proxy validates against
 * them at runtime, and `src/openapi.ts` publishes them in `openapi.yaml`.
 */
export const registry = z.registry<{ id: string; description?: string }>();

const jsonrpc = z.literal("2.0");
const JsonValue = z.json().register(registry, { id: "JsonValue", description: "Any JSON value." });
const params = z.union([z.record(z.string(), JsonValue), z.array(JsonValue)]);

export const JsonRpcId = z.union([z.string(), z.int()]).register(registry, {
    id: "JsonRpcId", description: "ACP request IDs are strings or integers, never null in requests.",
});

export const JsonRpcRequest = z.strictObject({ jsonrpc, id: JsonRpcId, method: z.string().min(1), params: params.optional() })
    .register(registry, { id: "JsonRpcRequest" });

export const JsonRpcNotification = z.strictObject({ jsonrpc, method: z.string().min(1), params: params.optional() })
    .register(registry, { id: "JsonRpcNotification" });

export const JsonRpcSuccess = z.strictObject({ jsonrpc, id: JsonRpcId, result: JsonValue })
    .register(registry, { id: "JsonRpcSuccess" });

export const JsonRpcErrorResponse = z.strictObject({
    jsonrpc,
    id: JsonRpcId.nullable(),
    error: z.strictObject({ code: z.int(), message: z.string(), data: JsonValue.optional() }),
}).register(registry, { id: "JsonRpcErrorResponse" });

export const JsonRpcMessage = z.union([JsonRpcRequest, JsonRpcNotification, JsonRpcSuccess, JsonRpcErrorResponse])
    .register(registry, {
        id: "JsonRpcMessage",
        description: "One WebSocket text frame on /acp. Payloads follow the ACP schema of the selected agent.",
    });

export type JsonRpcMessage = z.output<typeof JsonRpcMessage>;

/** Every HTTP error acpd returns, with its fixed status, message, and headers. */
export const httpErrors = {
    upgrade_failed: { status: 400, message: "The WebSocket handshake could not be completed." },
    forbidden: { status: 403, message: "Cross-origin ACP connections are not allowed." },
    unknown_agent: { status: 404, message: "agentId does not name a configured agent." },
    not_found: { status: 404, message: "Not found." },
    method_not_allowed: { status: 405, message: "Only the ACP WebSocket transport is served.", headers: { Allow: "GET" } },
    upgrade_required: { status: 426, message: "Connect with a WebSocket.", headers: { Upgrade: "websocket" } },
    internal_error: { status: 500, message: "Internal server error." },
} as const satisfies Record<string, { status: number; message: string; headers?: Record<string, string> }>;

export type HttpErrorCode = keyof typeof httpErrors;

export const HttpError = z.strictObject({
    error: z.enum(Object.keys(httpErrors) as [HttpErrorCode, ...HttpErrorCode[]]),
    message: z.string(),
}).register(registry, { id: "HttpError", description: "Body of every acpd HTTP error response." });

/** Builds an error response that always matches `HttpError` and never echoes request or internal details. */
export function errorResponse(code: HttpErrorCode): Response {
    const { status, message, ...rest } = httpErrors[code];
    const headers = "headers" in rest ? rest.headers : undefined;
    return Response.json(HttpError.parse({ error: code, message }), { status, headers });
}

/** JSON Schemas for the registered schemas, with refs into `#/components/schemas`. */
export function jsonSchemas(): Record<string, Record<string, unknown>> {
    const { schemas } = z.toJSONSchema(registry, { uri: (id) => `#/components/schemas/${id}` });
    return Object.fromEntries(Object.entries(schemas).map(([id, { $schema: _, $id: __, ...schema }]) => [id, schema]));
}
