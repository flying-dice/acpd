import { expect, test } from "bun:test";
import v1Spec from "@agentclientprotocol/sdk/schema/v1/schema.unstable.json";
import { AcpValidator, methods, validators } from "../src/acp.ts";

const request = (id: number, method: string, params?: unknown) => ({ jsonrpc: "2.0", id, method, params });
const notification = (method: string, params?: unknown) => ({ jsonrpc: "2.0", method, params });
const result = (id: number, value: unknown) => ({ jsonrpc: "2.0", id, result: value });
const errorReply = (id: number, code: number) => expect.objectContaining({ valid: false, reply: expect.objectContaining({ id, error: expect.objectContaining({ code }) }) });
const errorForward = (id: number, code: number) => expect.objectContaining({ valid: false, forward: expect.objectContaining({ id, error: expect.objectContaining({ code }) }) });

function initialized() {
    const validator = new AcpValidator();
    expect(validator.check(request(0, "initialize", { protocolVersion: 1, clientCapabilities: {} }), "client")).toMatchObject({ valid: true });
    expect(validator.check(result(0, { protocolVersion: 1, agentCapabilities: {} }), "agent")).toMatchObject({ valid: true });
    expect(validator.initialized).toBe(true);
    return validator;
}

test("every method in the official v1 JSON Schema has an SDK validator", () => {
    type Def = { "x-method"?: string; "x-side"?: string };
    const expected = (Object.entries(v1Spec.$defs) as [string, Def][])
        .filter(([, def]) => def["x-method"] && def["x-side"] !== "proxy").map(([name]) => name).sort();
    const listed = Object.values(methods).flatMap((table) => Object.values(table))
        .flatMap(({ params, result }) => result ? [params, result] : [params]).sort();
    expect(listed).toEqual(expected);
    for (const type of listed) expect(validators[`z${type}`], type).toBeDefined();
});

test("pins the SDK whose private validators it loads", async () => {
    const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
    expect(pkg.dependencies["@agentclientprotocol/sdk"]).toMatch(/^\d+\.\d+\.\d+$/);
});

test("requires initialize first and protocol version 1", () => {
    const validator = new AcpValidator();
    expect(validator.check(request(1, "session/new", { cwd: "/", mcpServers: [] }), "client")).toEqual(errorReply(1, -32600));
    expect(validator.check(request(2, "initialize", {}), "client")).toEqual(errorReply(2, -32602));
    expect(validator.check(request(3, "initialize", { protocolVersion: 1, clientCapabilities: {} }), "client")).toMatchObject({ valid: true });
    expect(validator.check(result(3, { protocolVersion: 99, agentCapabilities: {} }), "agent")).toEqual(errorForward(3, -32603));
    expect(validator.initialized).toBe(false);
    expect(validator.check(request(4, "initialize", { protocolVersion: 1, clientCapabilities: {} }), "client")).toMatchObject({ valid: true });
    expect(validator.check(result(4, { protocolVersion: 1, agentCapabilities: {} }), "agent")).toMatchObject({ valid: true });
    expect(validator.initialized).toBe(true);
});

test("checks params, results, and method direction", () => {
    const validator = initialized();
    expect(validator.check(request(1, "session/new", { mcpServers: [] }), "client")).toEqual(errorReply(1, -32602));
    expect(validator.check(request(2, "session/new", { cwd: "/", mcpServers: [] }), "client")).toMatchObject({ valid: true });
    expect(validator.check(result(2, {}), "agent")).toEqual(errorForward(2, -32603));
    expect(validator.check(request(3, "session/new", { cwd: "/", mcpServers: [] }), "client")).toMatchObject({ valid: true });
    expect(validator.check(result(3, { sessionId: "s" }), "agent")).toMatchObject({ valid: true });
    expect(validator.check(request(4, "session/new", { cwd: "/", mcpServers: [] }), "agent")).toEqual(errorReply(4, -32601));
    expect(validator.check(request(5, "made/up", {}), "client")).toEqual(errorReply(5, -32601));
    expect(validator.check(notification("session/prompt", {}), "client")).toEqual({ valid: false });
    expect(validator.check(notification("session/update", { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: 5 } }), "agent"))
        .toEqual({ valid: false });
    expect(validator.check(notification("session/update", { sessionId: "s", update: { sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hi" } } }), "agent")).toMatchObject({ valid: true });
    expect(validator.check(result(99, {}), "agent")).toEqual({ valid: false });
});

test("requires session/prompt results to carry a stop reason", () => {
    const validator = initialized();
    expect(validator.check(request(1, "session/prompt", { sessionId: "s", prompt: [{ type: "text", text: "hi" }] }), "client"))
        .toMatchObject({ valid: true });
    expect(validator.check(result(1, {}), "agent")).toEqual(errorForward(1, -32603));
    expect(validator.check(request(2, "session/prompt", { sessionId: "s", prompt: [{ type: "text", text: "hi" }] }), "client"))
        .toMatchObject({ valid: true });
    expect(validator.check(result(2, { stopReason: "end_turn" }), "agent")).toMatchObject({ valid: true });
});

test("passes extension methods and error responses with envelope checks only", () => {
    const validator = initialized();
    expect(validator.check(request(1, "_vendor/thing", { anything: true }), "client")).toMatchObject({ valid: true });
    expect(validator.check(result(1, "free-form"), "agent")).toMatchObject({ valid: true });
    expect(validator.check(request(2, "session/new", { cwd: "/", mcpServers: [] }), "client")).toMatchObject({ valid: true });
    expect(validator.check({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: "Internal error" } }, "agent")).toMatchObject({ valid: true });
    expect(validator.check({ jsonrpc: "2.0", id: 3, method: "" }, "client")).toEqual(errorReply(3, -32600));
});
