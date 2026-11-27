import type { ZodType } from "zod";
import v1Spec from "@agentclientprotocol/sdk/schema/v1/schema.unstable.json";
// A literal relative path, so `bun build --compile` embeds the validators. The package's
// exports map hides this file, and the SDK ships no types for it.
// @ts-expect-error TS7016: untyped JavaScript module.
import * as sdkValidators from "../node_modules/@agentclientprotocol/sdk/dist/v1/unstable/schema/zod.gen.js";
import { JsonRpcId, JsonRpcMessage } from "./schemas.ts";

/**
 * ACP v1 payload validation.
 *
 * The method table comes from the official ACP v1 JSON Schema, whose payload
 * types carry `x-method` and `x-side` annotations. The validators are the zod
 * schemas the ACP TypeScript SDK generates from that same JSON Schema. The SDK
 * does not export them, so they are imported from its `dist` folder by relative
 * path; keep `@agentclientprotocol/sdk` pinned to an exact version.
 */

export const ACP_VERSION = 1;

/** The side that handles a method: `agent` methods are sent by clients, `client` methods by agents. */
export type Side = "agent" | "client" | "protocol";

export interface MethodSchema {
    /** Name of the params type in the ACP schema. */
    params: string;
    /** Name of the result type, or undefined for a notification. */
    result?: string;
}

export type MethodTable = Record<Side, Record<string, MethodSchema>>;

export type Spec = { $defs: Record<string, { "x-method"?: string; "x-side"?: string }> };

const isSide = (side: string | undefined): side is Side => side === "agent" || side === "client" || side === "protocol";

/** Builds the method table from the `x-method` and `x-side` annotations on each payload type. */
export function methodTable(spec: Spec): MethodTable {
    const table: MethodTable = { agent: {}, client: {}, protocol: {} };
    for (const [name, def] of Object.entries(spec.$defs)) {
        const method = def["x-method"];
        const side = def["x-side"];
        if (!method || !isSide(side)) continue;
        const entry = table[side][method] ??= { params: "" };
        if (name.endsWith("Response")) entry.result = name;
        else entry.params = name;
    }
    return table;
}

/** The official ACP v1 JSON Schema (the unstable variant, which includes the stable methods). */
export const spec = v1Spec as Spec;
export const methods = methodTable(spec);

export const validators = sdkValidators as Record<string, ZodType>;

function validate(type: string, value: unknown): boolean {
    const schema = validators[`z${type}`];
    if (!schema) throw new Error(`The ACP SDK has no validator for ${type}.`);
    return schema.safeParse(value).success;
}

const isExtension = (method: string) => method.startsWith("_");

/** Who sent a message. */
export type Peer = "client" | "agent";

/** What to do with one message read from a peer: pass it on, answer the sender, or both. */
export interface Checked {
    valid: boolean;
    forward?: JsonRpcMessage;
    reply?: JsonRpcMessage;
}

type Id = string | number;
const error = (id: Id, code: number, message: string): JsonRpcMessage => ({ jsonrpc: "2.0", id, error: { code, message } });

/**
 * Validates the messages of one ACP connection against JSON-RPC 2.0 and ACP v1.
 * Messages that pass are forwarded unchanged.
 *
 * - `initialize` must come first, and the agent must answer with protocol version 1.
 * - An invalid request is answered to its sender: `-32600` for a bad envelope,
 *   `-32601` for a method ACP does not define, `-32602` for bad params.
 * - An invalid response is replaced with `-32603` for whoever is waiting on it.
 * - An invalid notification is dropped.
 * - Methods starting with `_` are ACP extensions; only their envelope is checked.
 */
export class AcpValidator {
    initialized = false;
    /** Requests awaiting a response, keyed by sender and ID, with the result type the response must match. */
    private readonly pending = new Map<string, { method: string; result?: string }>();

    check(message: unknown, from: Peer): Checked {
        const parsed = JsonRpcMessage.safeParse(message);
        if (!parsed.success) return this.invalidEnvelope(message);
        const msg = parsed.data;
        const ok: Checked = { valid: true, forward: message as JsonRpcMessage };

        if ("method" in msg) {
            const id = "id" in msg ? msg.id : undefined;
            const fail = (code: number, text: string): Checked => id === undefined ? { valid: false } : { valid: false, reply: error(id, code, text) };
            if (!isExtension(msg.method)) {
                if (!this.initialized && msg.method !== "initialize") return fail(-32600, "Send initialize first.");
                const handler: Side = from === "client" ? "agent" : "client";
                const schema = methods[handler][msg.method] ?? methods.protocol[msg.method];
                if (!schema || (id !== undefined) !== (schema.result !== undefined)) return fail(-32601, "Method not found");
                if (!validate(schema.params, msg.params ?? {})) return fail(-32602, "Invalid params");
                if (id !== undefined) this.pending.set(`${from}:${id}`, { method: msg.method, result: schema.result });
            } else if (id !== undefined) {
                this.pending.set(`${from}:${id}`, { method: msg.method });
            }
            return ok;
        }

        // A response answers a request the other peer sent.
        if (msg.id === null) return ok;
        const key = `${from === "client" ? "agent" : "client"}:${msg.id}`;
        const request = this.pending.get(key);
        if (!request) return { valid: false };
        this.pending.delete(key);
        if ("error" in msg || !request.result) return ok;

        const invalid = (text = "The peer sent an invalid response."): Checked => ({ valid: false, forward: error(msg.id!, -32603, text) });
        if (request.method === "initialize" && (msg.result as { protocolVersion?: unknown } | null)?.protocolVersion !== ACP_VERSION) {
            return invalid(`The agent must answer with ACP protocol version ${ACP_VERSION}.`);
        }
        if (!validate(request.result, msg.result)) return invalid();
        if (request.method === "initialize") this.initialized = true;
        return ok;
    }

    /** Envelope failures: answer a bad request, stand in for a bad response, drop anything else. */
    private invalidEnvelope(message: unknown): Checked {
        const record = typeof message === "object" && message !== null ? message as Record<string, unknown> : {};
        const id = JsonRpcId.safeParse(record.id);
        if (!id.success) return { valid: false };
        return "method" in record
            ? { valid: false, reply: error(id.data, -32600, "Invalid Request") }
            : { valid: false, forward: error(id.data, -32603, "The peer sent an invalid response.") };
    }
}
