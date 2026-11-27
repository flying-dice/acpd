# acpd

`acpd` is a minimal [Agent Client Protocol](https://agentclientprotocol.com) (ACP v1) proxy. Remote ACP clients connect over a WebSocket, and acpd connects each one to a stdio ACP agent listed in its config file. Messages are validated against ACP v1 and otherwise passed through unchanged.

## Install

On Linux, macOS, or WSL, with [Bun](https://bun.sh) installed:

```sh
./scripts/install.sh
```

This builds a standalone binary and installs it as `~/.local/bin/acpd`. Set `ACPD_BIN_DIR` to install somewhere else.
- If that folder isn't on your `PATH`, the installer adds it to your shell's startup file (`~/.zshrc`, `~/.bashrc` (`~/.bash_profile` on macOS), fish's `conf.d`, or `~/.profile`), then prints the line to run in your current shell.
- If you have no user config (`~/.acpd/config.json` or `~/.config/acpd/config.json`), it copies the example config to `~/.acpd/config.json`.
- Running it again updates the binary without duplicating the `PATH` entry.

Then run `acpd` and connect an ACP client to `ws://127.0.0.1:3000/acp`.

`bun run build` builds the binary alone, as `dist/acpd`. Bun can cross-compile with `--target`, for example `bun run build --target=bun-linux-arm64`.

## Run from source

```sh
bun install
bun start            # or `bun dev` to restart on changes
```

## Configuration

acpd reads one JSON config file. It uses the first one it finds, in this order:

1. `--config <path>` (or `-c <path>`)
2. The `ACPD_CONFIG` environment variable
3. `acpd.config.json` in the working directory, then in each parent directory up to the root
4. `~/.acpd/config.json` (`%USERPROFILE%\.acpd\config.json` on Windows)
5. The user config directory:
   - Linux and macOS: `$XDG_CONFIG_HOME/acpd/config.json`, which defaults to `~/.config/acpd/config.json`
   - macOS also checks `~/Library/Application Support/acpd/config.json`
   - Windows: `%APPDATA%\acpd\config.json`
6. The system config directory:
   - Linux and macOS: each `$XDG_CONFIG_DIRS` entry (default `/etc/xdg`) as `<dir>/acpd/config.json`, then `/etc/acpd/config.json`
   - Windows: `%ProgramData%\acpd\config.json`

A path named by `--config` or `ACPD_CONFIG` must exist. If no config is found, acpd exits and lists every path it checked. On startup it logs the file it used. Files are not merged.

```json
{
  "host": "127.0.0.1",
  "port": 3000,
  "defaultAgent": "claude-code",
  "agents": {
    "claude-code": { "command": "bunx", "args": ["@agentclientprotocol/claude-agent-acp"] },
    "my-agent": { "command": "/usr/local/bin/my-agent", "args": ["acp"], "env": { "MY_AGENT_MODE": "fast" } }
  }
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `host`, `port` | `127.0.0.1`, `3000` | Where acpd listens. |
| `defaultAgent` | first agent | The agent a client gets when it names none. |
| `agents.<id>.command`, `args` | | A process that speaks ACP over stdio. |
| `agents.<id>.env` | `{}` | Variables added to acpd's environment for that agent. |

Values in `command`, `args`, and `env` that start with `./` or `../` are resolved against the config file's directory. Agent IDs may contain letters, digits, `_`, `.`, and `-`.

The checked-in config runs the Claude Code, Codex, and Pi ACP adapters with `bunx`, which downloads each package on first use and caches it. Pin a version with `package@version` in `args`. Each adapter uses its own sign-in. For Claude Code, run `bunx @agentclientprotocol/claude-agent-acp --cli auth login`. `pi-acp` needs the `pi` CLI on `PATH`, or set `PI_ACP_PI_COMMAND` in the agent's `env`.

## Protocol

acpd uses the WebSocket binding of the ACP [Streamable HTTP & WebSocket transport RFD](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport). The RFD is a proposal, so acpd follows it as it changes. The ACP TypeScript SDK's `AcpServer` provides the transport.

- `GET /acp` with `Upgrade: websocket` returns `101 Switching Protocols` with an `Acp-Connection-Id` header.
- Each text frame carries one JSON-RPC message. `initialize` must come first, and binary frames are ignored.
- Each connection starts its own agent process. Closing the socket stops the process, and the socket closes if the process exits.
- To reconnect, open a new socket and resume the session with the methods the agent advertises, such as `session/load` or `session/resume`.
- The RFD requires HTTP/2 for Streamable HTTP, and Bun does not serve HTTP/2. So `/acp` only accepts WebSockets, which the RFD allows, and `POST` and `DELETE` return 405.

## API schema

Two generated documents describe acpd:

- [`openapi.yaml`](openapi.yaml) (OpenAPI 3.2) describes the HTTP handshake, its errors, and every message schema. `src/openapi.ts` builds it with the `oas32` API of [openapi3-ts](https://www.npmjs.com/package/openapi3-ts).
- [`asyncapi.yaml`](asyncapi.yaml) (AsyncAPI 3.1) describes the `/acp` WebSocket channel: acpd receives `ClientMessage` and sends `AgentMessage`. It includes the `agentId` query binding and request/response matching on the JSON-RPC `id`. Its message payloads are JSON Schema 2020-12 references into `openapi.yaml`, so the schemas exist in one place. `src/asyncapi.ts` builds it.

`bun run specs` regenerates both files. Tests fail if either committed file is out of date. Another test parses `asyncapi.yaml` with the official `@asyncapi/parser`, requiring zero diagnostics and checking that every payload resolves. Its schemas come from the same zod schemas in `src/schemas.ts` that the proxy validates against at runtime, so the spec and the server's behavior cannot drift apart.

- **HTTP errors** always return an `HttpError` JSON body, `{ "error": "<code>", "message": "<fixed text>" }`, with the status and headers listed in the spec. Messages are fixed per code and never echo request or internal details. Unknown paths return `not_found`, and unexpected server errors return `internal_error`.
- **WebSocket frames** after the `101` response are `JsonRpcMessage` values: a JSON-RPC 2.0 request, notification, success, or error response. Every message is validated in both directions. acpd answers an invalid request with `-32600` sent back to whoever sent it. It replaces an invalid response with a `-32603` error to whoever was waiting for it, so no request hangs. Anything else that is invalid is dropped and logged. Every frame sent to a client is also checked against `JsonRpcMessage` before it leaves.
- **Message payloads** (`params`, `result`) are validated against ACP v1. `initialize` must come first, and the agent must answer with `protocolVersion` 1, or the client gets a `-32603` in place of the response.
  - An invalid request gets `-32602`, and a method ACP doesn't define in that direction gets `-32601`.
  - An invalid result is replaced with `-32603`, and an invalid notification is dropped.
  - Methods starting with `_` are ACP extensions and only get envelope checks. Error responses pass through.
  - Messages that pass are forwarded unchanged.
- **Where the payload rules come from.** The method table comes from the official ACP v1 JSON Schema that the SDK publishes (`schema/v1`, unstable variant included). The validators are the zod schemas the SDK generates from that same file, so they apply the same leniency the SDK does: required fields are enforced, and some invalid optional fields are tolerated. The SDK doesn't export these validators, so `src/acp.ts` loads them from its `dist` folder. That's why `@agentclientprotocol/sdk` is pinned to an exact version. A test fails if any method in the official schema lacks a validator, which catches drift when you upgrade the SDK.
- **The full ACP spec is in `openapi.yaml`.**
  - Every ACP v1 type from the official JSON Schema is a component, prefixed `Acp` (for example `AcpInitializeRequest`).
  - `ClientMessage` and `AgentMessage` describe every frame each peer may send: each method's params type, the result types, error responses, and `_` extensions.
  - The root `x-acp-methods` extension maps each method to its params and result types, per handling side, exactly as the proxy validates.
  - OpenAPI has no standard way to describe WebSocket messages, so the 101 response references these schemas through an `x-websocket-message` extension (`envelope`, `clientToAgent`, `agentToClient`). Code generators produce the types, but not a WebSocket client; use an ACP SDK as the client after the upgrade.
  - Upgrading the SDK changes `openapi.yaml`, and the up-to-date test fails until you run `bun run specs`.

Two additions sit outside ACP:

- **Agent selection.** `?agentId=<id>` picks an agent, for example `ws://127.0.0.1:3000/acp?agentId=codex`. An unknown ID returns 404. ACP has no standard way to choose between agents behind one endpoint, but the ID is just part of the URL a client is given.
- **Origin check.** Upgrades whose `Origin` differs from acpd's host are rejected with 403, because browsers do not apply CORS to WebSockets. acpd has no authentication. Anyone who can reach `host` and `port` can run the configured agents, so keep it bound to loopback or behind something that controls access.

## Tests

`bun test` checks config parsing, that `openapi.yaml` is current and matches every HTTP error the server returns, that `asyncapi.yaml` is current and valid, JSON-RPC and ACP v1 payload validation in both directions, that every method in the official ACP v1 schema has a validator, and runs a stdio mock agent through the proxy. It covers pass-through, agent-to-client requests, `agentId` routing, the 101 headers, the Origin check, and process cleanup. `bun run typecheck` checks TypeScript.
