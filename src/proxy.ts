import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type { ServerWebSocket } from "bun";
import { ndJsonStream, type AgentConnector, type AnyMessage } from "@agentclientprotocol/sdk";
import { AcpServer, type PreparedWebSocketUpgrade } from "@agentclientprotocol/sdk/experimental/server";
import type { AgentConfig, Config } from "./config.ts";
import { AcpValidator, type Peer } from "./acp.ts";
import { errorResponse, JsonRpcMessage } from "./schemas.ts";

type Writer = WritableStreamDefaultWriter<AnyMessage>;

async function relay(source: ReadableStream<AnyMessage>, to: Writer, back: Writer, from: Peer, validator: AcpValidator) {
    try {
        for await (const message of source) {
            const { valid, forward, reply } = validator.check(message, from);
            if (!valid) console.warn(`acpd: invalid JSON-RPC message from the ${from}`);
            if (forward) await to.write(forward as AnyMessage);
            if (reply) await back.write(reply as AnyMessage).catch(() => {});
        }
    } finally {
        await to.close().catch(() => {});
    }
}

/**
 * Starts the agent's process for one ACP connection and relays messages in
 * both directions, validated against JSON-RPC and the negotiated ACP version. The process ends with the connection, and the
 * connection ends with the process.
 */
export function stdioAgent(agent: AgentConfig, env: NodeJS.ProcessEnv): AgentConnector {
    return {
        connect(stream) {
            const child = spawn(agent.command, agent.args, { env: { ...env, ...agent.env }, stdio: ["pipe", "pipe", "inherit"] });
            child.once("error", (error) => console.error(`acpd: ${agent.command} failed: ${error.message}`));
            // Node's Web Stream declarations differ from the DOM declarations used by ACP.
            const stdout = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>;
            const agentStream = ndJsonStream(Writable.toWeb(child.stdin), stdout);
            const toClient = stream.writable.getWriter();
            const toAgent = agentStream.writable.getWriter();
            const validator = new AcpValidator();
            const relays = [
                relay(stream.readable, toAgent, toClient, "client", validator),
                relay(agentStream.readable, toClient, toAgent, "agent", validator),
            ];
            const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
            // Whichever side finishes first ends the other.
            void Promise.race(relays.map((done) => done.catch(() => {}))).then(() => child.kill());
            return { closed: Promise.allSettled([...relays, exited]).then(() => {}) };
        },
    };
}

/**
 * Adapts Bun's handler-based server socket to the event-based socket `AcpServer`
 * reads. Every outgoing frame is checked against the JSON-RPC schema, so clients
 * only receive messages that `openapi.yaml` describes.
 */
class BunSocket extends EventTarget {
    constructor(private readonly socket: ServerWebSocket<unknown>) {
        super();
    }

    get readyState() { return this.socket.readyState; }
    get bufferedAmount() { return this.socket.getBufferedAmount(); }
    close(code?: number, reason?: string) { this.socket.close(code, reason); }

    send(data: string) {
        let message: unknown;
        try {
            message = JSON.parse(data);
        } catch {
            message = undefined;
        }
        if (!JsonRpcMessage.safeParse(message).success) {
            console.warn("acpd: dropped an outgoing frame that is not a valid JSON-RPC message");
            return;
        }
        this.socket.send(data);
    }
}

/** Browsers do not apply CORS to WebSockets, so refuse upgrades that another site's page starts. */
function sameOrigin(request: Request): boolean {
    const origin = request.headers.get("Origin");
    if (origin === null) return true;
    try {
        return new URL(origin).host === new URL(request.url).host;
    } catch {
        return false;
    }
}

/**
 * Serves ACP at `/acp` with the WebSocket binding of the ACP Streamable HTTP
 * & WebSocket transport RFD. `?agentId=` picks a configured agent.
 */
export function startProxy(config: Config, { env = process.env } = {}) {
    const agents = new Map(Object.entries(config.agents).map(([id, agent]) => [id, stdioAgent(agent, env)]));
    const acp = new AcpServer({ agent: agents.get(config.defaultAgent)! });

    const server = Bun.serve({
        hostname: config.host,
        port: config.port,
        routes: {
            "/acp": (request, server) => {
                if (!sameOrigin(request)) return errorResponse("forbidden");
                if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
                    // Streamable HTTP requires HTTP/2, which Bun.serve does not provide.
                    return errorResponse(request.method === "GET" ? "upgrade_required" : "method_not_allowed");
                }
                const agent = agents.get(new URL(request.url).searchParams.get("agentId") ?? config.defaultAgent);
                if (!agent) return errorResponse("unknown_agent");
                const upgrade = acp.prepareWebSocketUpgrade({ agent });
                if (server.upgrade(request, { headers: { "Acp-Connection-Id": upgrade.connectionId }, data: { upgrade } })) return;
                upgrade.reject();
                return errorResponse("upgrade_failed");
            },
        },
        fetch: () => errorResponse("not_found"),
        error(error) {
            console.error("acpd:", error);
            return errorResponse("internal_error");
        },
        websocket: {
            data: {} as { upgrade: PreparedWebSocketUpgrade; socket?: BunSocket },
            idleTimeout: 0,
            open(ws) {
                ws.data.socket = new BunSocket(ws);
                ws.data.upgrade.accept(ws.data.socket);
            },
            message(ws, data) {
                ws.data.socket?.dispatchEvent(new MessageEvent("message", { data }));
            },
            close(ws, code, reason) {
                ws.data.socket?.dispatchEvent(new CloseEvent("close", { code, reason }));
            },
        },
    });

    return Object.assign(server, {
        async shutdown() {
            await acp.close();
            await server.stop(true);
        },
    });
}
