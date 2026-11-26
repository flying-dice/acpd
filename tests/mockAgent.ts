// A minimal ACP v1 agent over stdio. It echoes prompts after asking the client for permission.
import { Readable, Writable } from "node:stream";
import { AgentApp, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const app = new AgentApp()
    .onRequest(methods.agent.initialize, () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {},
        agentInfo: { name: process.env.MOCK_NAME ?? "mock", version: "1.0.0", title: String(process.pid) },
    }))
    .onRequest(methods.agent.session.new, ({ params }) => ({ sessionId: `session:${params.cwd}` }))
    .onRequest(methods.agent.session.prompt, async ({ params: { sessionId, prompt }, client }) => {
        const { outcome } = await client.request(methods.client.session.requestPermission, {
            sessionId,
            toolCall: { toolCallId: "echo", title: "Echo the prompt" },
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        });
        const text = prompt.map((block) => block.type === "text" ? block.text : "").join("");
        await client.notify(methods.client.session.update, { sessionId, update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `${text} [${outcome.outcome}]` },
        } });
        return { stopReason: "end_turn" };
    })
    // Answers with a response that has both `result` and `error`, which JSON-RPC forbids.
    .onRequest("_mock/invalid_response", (params) => params, ({ requestId }) => {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, result: 1, error: { code: 1, message: "both" } })}\n`);
        return new Promise<never>(() => {});
    })
    // Sends a notification whose params are a string, then answers normally.
    .onRequest("_mock/invalid_notification", (params) => params, () => {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: "invalid" })}\n`);
        return { ok: true };
    })
    // Sends a session/update whose content is not a content block, then answers normally.
    .onRequest("_mock/invalid_update", (params) => params, () => {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update",
            params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: 5 } } })}\n`);
        return { ok: true };
    });

const stdin = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
await app.connect(ndJsonStream(Writable.toWeb(process.stdout), stdin)).closed;
