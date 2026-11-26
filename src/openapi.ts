import { OpenApiBuilder, type OpenAPIObject, type OperationObject, type ResponsesObject, type SchemaObject } from "openapi3-ts/oas32";
import { version } from "../package.json";
import { methods, spec, type Peer } from "./acp.ts";
import { httpErrors, jsonSchemas, type HttpErrorCode } from "./schemas.ts";

const schema = (id: string) => ({ $ref: `#/components/schemas/${id}` });

/** Component name for an ACP v1 type. The prefix keeps ACP types apart from acpd's own schemas. */
const acpName = (type: string) => `Acp${type}`;

/** Component name for every message one peer may send. It must not start with `Acp`, which ACP types use. */
export const messageName = (sender: Peer) => sender === "client" ? "ClientMessage" : "AgentMessage";

/** Every type in the official ACP v1 JSON Schema, with `#/$defs/` references pointed at the prefixed components. */
function acpSchemas(): Record<string, SchemaObject> {
    const rewrite = (node: unknown): unknown => Array.isArray(node) ? node.map(rewrite)
        : node !== null && typeof node === "object"
            ? Object.fromEntries(Object.entries(node).map(([key, value]) => [key, key === "$ref" && typeof value === "string"
                ? value.replace("#/$defs/", `#/components/schemas/${acpName("")}`) : rewrite(value)]))
            : node;
    return Object.fromEntries(Object.entries(spec.$defs).map(([type, definition]) => [acpName(type), rewrite(definition) as SchemaObject]));
}

/**
 * Every message one peer may send: requests and notifications for the methods
 * the other peer handles, results of the methods this peer handles, error
 * responses, and `_` extension methods.
 */
function acpMessages(sender: Peer): SchemaObject {
    const handler = sender === "client" ? "agent" : "client";
    const calls = Object.entries({ ...methods.protocol, ...methods[handler] }).map(([method, { params, result }]): SchemaObject => ({
        type: "object",
        additionalProperties: false,
        required: result ? ["jsonrpc", "id", "method"] : ["jsonrpc", "method"],
        properties: {
            jsonrpc: { const: "2.0" },
            ...(result && { id: schema("JsonRpcId") }),
            method: { const: method },
            params: schema(acpName(params)),
        },
    }));
    const results = [...new Set(Object.values(methods[sender]).flatMap(({ result }) => result ? [result] : []))];
    return {
        description: `A message ${sender === "client" ? "a client" : "an agent"} sends under ACP v1.`,
        anyOf: [
            ...calls,
            { allOf: [schema("JsonRpcSuccess")], properties: { result: { anyOf: results.map((type) => schema(acpName(type))) } } },
            schema("JsonRpcErrorResponse"),
            { allOf: [{ anyOf: [schema("JsonRpcRequest"), schema("JsonRpcNotification")] }, { properties: { method: { pattern: "^_" } } }] },
        ],
    };
}

/** The method table acpd validates with, as references to the ACP components. */
function acpMethods() {
    return Object.fromEntries(Object.entries(methods).map(([side, table]) => [side, Object.fromEntries(Object.entries(table)
        .map(([method, { params, result }]) => [method, { params: schema(acpName(params)), ...(result && { result: schema(acpName(result)) }) }]))]));
}

/** Responses for the given error codes. Each body is an `HttpError` with its `error` fixed to that code. */
function errors(...codes: HttpErrorCode[]): ResponsesObject {
    const responses: ResponsesObject = {};
    for (const code of codes) {
        const error = httpErrors[code];
        const status = String(error.status);
        const body = { allOf: [schema("HttpError")], properties: { error: { const: code }, message: { const: error.message } } };
        const existing = responses[status];
        responses[status] = {
            description: existing ? `${existing.description} Or: ${error.message}` : error.message,
            ...("headers" in error && {
                headers: Object.fromEntries(Object.entries(error.headers).map(([name, value]) =>
                    [name, { required: true, schema: { type: "string", const: value } }])),
            }),
            content: { "application/json": { schema: existing ? { oneOf: [existing.content["application/json"].schema, body] } : body } },
        };
    }
    return responses;
}

const unsupported = (operationId: string, summary: string): OperationObject => ({
    operationId,
    summary,
    description: "The RFD requires HTTP/2 for Streamable HTTP. acpd only serves the WebSocket binding.",
    responses: errors("forbidden", "method_not_allowed", "internal_error"),
});

/** Builds acpd's OpenAPI document from the same schemas the proxy validates with. */
export function buildOpenApi(): OpenAPIObject {
    const builder = OpenApiBuilder.create()
        .addOpenApiVersion("3.2.0")
        .addInfo({
            title: "acpd",
            version,
            summary: "Minimal Agent Client Protocol (ACP) proxy over WebSocket.",
            description: [
                "acpd connects remote ACP clients to stdio ACP agents listed in its config file. This document covers the "
                    + "HTTP handshake and the message schemas; `asyncapi.yaml` describes the WebSocket channel and its messages.",
                "After `101 Switching Protocols`, each WebSocket text frame in either direction carries one `JsonRpcMessage`. "
                    + "acpd validates every frame against that schema, and validates `params` and `result` against ACP v1. "
                    + "`initialize` must come first and the agent must answer with protocol version 1. "
                    + "It answers an invalid request with `-32600` (bad envelope), `-32601` "
                    + "(method not in ACP), or `-32602` (bad params). It replaces an invalid response with `-32603` and drops an "
                    + "invalid notification. Methods starting with `_` are ACP extensions and get envelope checks only. "
                    + "See https://agentclientprotocol.com.",
            ].join("\n\n"),
        })
        .addServer({ url: "http://127.0.0.1:3000", description: "Default local address. `host` and `port` in the config file change it." })
        .addExternalDocs({ description: "ACP Streamable HTTP & WebSocket transport RFD", url: "https://agentclientprotocol.com/rfds/streamable-http-websocket-transport" })
        .addParameter("AgentId", {
            name: "agentId",
            in: "query",
            required: false,
            description: "ID of a configured agent. Defaults to the config's `defaultAgent`. This is not part of ACP.",
            schema: { type: "string", pattern: "^[\\w.-]+$" },
        })
        .addPath("/acp", {
            get: {
                operationId: "connectAcp",
                summary: "Open an ACP connection over WebSocket.",
                description: [
                    "Starts the selected agent's process and upgrades to a WebSocket. Send `initialize` first.",
                    "Closing the socket stops the agent process, and the socket closes if the process exits.",
                ].join(" "),
                parameters: [
                    { $ref: "#/components/parameters/AgentId" },
                    { name: "Upgrade", in: "header", required: true, schema: { type: "string", const: "websocket" } },
                    { name: "Connection", in: "header", required: true, schema: { type: "string", const: "Upgrade" } },
                    { name: "Sec-WebSocket-Version", in: "header", required: true, schema: { type: "string", const: "13" } },
                    { name: "Sec-WebSocket-Key", in: "header", required: true, description: "Base64 of 16 random bytes (RFC 6455).", schema: { type: "string" } },
                    { name: "Origin", in: "header", required: false, description: "If present, its host must equal the request's `Host`.", schema: { type: "string" } },
                ],
                responses: {
                    "101": {
                        description: "Switched to the ACP WebSocket transport. Frames carry `JsonRpcMessage` values.",
                        headers: {
                            "Acp-Connection-Id": { required: true, description: "Transport-level identifier for this ACP connection.", schema: { type: "string" } },
                            Upgrade: { required: true, schema: { type: "string", const: "websocket" } },
                            "Sec-WebSocket-Accept": { required: true, schema: { type: "string" } },
                        },
                        "x-websocket-message": {
                            envelope: schema("JsonRpcMessage"),
                            clientToAgent: schema(messageName("client")),
                            agentToClient: schema(messageName("agent")),
                        },
                    },
                    ...errors("upgrade_failed", "forbidden", "unknown_agent", "upgrade_required", "internal_error"),
                },
            },
            post: unsupported("postAcp", "Streamable HTTP (not supported)."),
            delete: unsupported("deleteAcp", "Streamable HTTP connection termination (not supported)."),
        });
    const added = new Set<string>();
    const addSchema = (id: string, definition: SchemaObject) => {
        if (added.has(id)) throw new Error(`Two schemas are named ${id}.`);
        added.add(id);
        builder.addSchema(id, definition);
    };
    for (const [id, definition] of Object.entries(jsonSchemas())) addSchema(id, definition);
    addSchema(messageName("client"), acpMessages("client"));
    addSchema(messageName("agent"), acpMessages("agent"));
    for (const [id, definition] of Object.entries(acpSchemas())) addSchema(id, definition);
    const spec = builder.getSpec();
    // The builder starts with every component section; drop the ones acpd leaves empty.
    spec.components = Object.fromEntries(Object.entries(spec.components ?? {}).filter(([, section]) => Object.keys(section ?? {}).length > 0));
    // Which ACP v1 params and result types each method uses, per handling side.
    spec["x-acp-methods"] = acpMethods();
    return spec;
}

export function openApiYaml(): string {
    return `# Generated by \`bun run openapi\` from src/openapi.ts. Do not edit.\n${OpenApiBuilder.create(buildOpenApi()).getSpecAsYaml()}`;
}

if (import.meta.main) {
    await Bun.write(new URL("../openapi.yaml", import.meta.url), openApiYaml());
    console.log("Wrote openapi.yaml");
}
