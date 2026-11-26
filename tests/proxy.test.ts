import { afterAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";
import { ClientApp, methods, type SessionNotification } from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { parseConfig } from "../src/config.ts";
import { startProxy } from "../src/proxy.ts";

const mock = (name: string) => ({ command: process.execPath, args: [fileURLToPath(new URL("./mockAgent.ts", import.meta.url))], env: { MOCK_NAME: name } });
const server = startProxy(parseConfig({ port: 0, agents: { first: mock("first"), second: mock("second") } }));
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => server.shutdown());

async function connect(path: string) {
    const updates: SessionNotification[] = [];
    const connection = new ClientApp()
        .onRequest(methods.client.session.requestPermission, () => ({ outcome: { outcome: "selected", optionId: "allow" } }))
        .onNotification(methods.client.session.update, ({ params }) => { updates.push(params); })
        .connect(createWebSocketStream(`${base.replace("http", "ws")}${path}`));
    const initialized = await connection.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
    return { connection, initialized, updates };
}

function upgrade(path: string, headers: Record<string, string> = {}) {
    return new Promise<IncomingMessage>((resolve, reject) => {
        const req = httpRequest(`${base}${path}`, { headers: {
            Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13",
            "Sec-WebSocket-Key": randomBytes(16).toString("base64"), ...headers,
        } });
        req.on("upgrade", (response, socket) => { socket.destroy(); resolve(response); });
        req.on("response", resolve);
        req.on("error", reject);
        req.end();
    });
}

test("passes ACP through to the default agent, including agent-to-client requests", async () => {
    const { connection, initialized, updates } = await connect("/acp");
    try {
        expect(initialized.agentInfo?.name).toBe("first");
        const cwd = process.cwd();
        const { sessionId } = await connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [] });
        expect(sessionId).toBe(`session:${cwd}`);
        const { stopReason } = await connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "hello" }] });
        expect(stopReason).toBe("end_turn");
        expect(updates).toEqual([{ sessionId, update: { sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello [selected]" } } }]);
    } finally {
        connection.close();
    }
});

test("routes ?agentId= to the configured agent", async () => {
    const { connection, initialized } = await connect("/acp?agentId=second");
    expect(initialized.agentInfo?.name).toBe("second");
    connection.close();
    // Closing the WebSocket ends the agent process.
    const pid = Number(initialized.agentInfo?.title);
    await Bun.sleep(500);
    expect(() => process.kill(pid, 0)).toThrow();
    expect((await upgrade("/acp?agentId=missing")).statusCode).toBe(404);
});

test("follows the RFD WebSocket binding and guards the endpoint", async () => {
    const accepted = await upgrade("/acp");
    expect(accepted.statusCode).toBe(101);
    expect(accepted.headers["acp-connection-id"]).toBeTruthy();
    expect((await upgrade("/acp", { Origin: "https://example.com" })).statusCode).toBe(403);
    expect((await fetch(`${base}/acp`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/other`)).status).toBe(404);
});

test("never relays invalid agent messages to the client", async () => {
    const { connection, updates } = await connect("/acp");
    try {
        await expect(connection.agent.request("_mock/invalid_response", {})).rejects.toMatchObject({ code: -32603 });
        expect(await connection.agent.request("_mock/invalid_notification", {})).toEqual({ ok: true });
        // A well-formed JSON-RPC notification whose params break the ACP v1 schema.
        expect(await connection.agent.request("_mock/invalid_update", {})).toEqual({ ok: true });
        expect(updates).toEqual([]);
    } finally {
        connection.close();
    }
});

test("answers invalid client requests with -32600 instead of forwarding them", async () => {
    const socket = new WebSocket(`${base.replace("http", "ws")}/acp`);
    const received: unknown[] = [];
    const next = () => new Promise<unknown>((resolve) => {
        const check = () => received.length ? resolve(received.shift()) : setTimeout(check, 10);
        check();
    });
    socket.addEventListener("message", (event) => received.push(JSON.parse(String(event.data))));
    await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
    try {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } }));
        expect(await next()).toMatchObject({ id: 1, result: { protocolVersion: 1 } });
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "" }));
        expect(await next()).toEqual({ jsonrpc: "2.0", id: 2, error: { code: -32600, message: "Invalid Request" } });
    } finally {
        socket.close();
    }
});
