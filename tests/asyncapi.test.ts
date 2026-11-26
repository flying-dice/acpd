import { expect, test } from "bun:test";
import { Parser, fromFile } from "@asyncapi/parser";
import { asyncApiYaml, buildAsyncApi } from "../src/asyncapi.ts";
import { buildOpenApi } from "../src/openapi.ts";

const path = new URL("../asyncapi.yaml", import.meta.url);

test("asyncapi.yaml is generated from src/asyncapi.ts", async () => {
    expect(await Bun.file(path).text()).toBe(asyncApiYaml());
    const doc = buildAsyncApi();
    expect(doc.info.version).toBe((await Bun.file(new URL("../package.json", import.meta.url)).json()).version);
});

test("is a valid AsyncAPI document whose payloads resolve into openapi.yaml", async () => {
    const { document, diagnostics } = await fromFile(new Parser(), Bun.fileURLToPath(path)).parse();
    expect(diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)).toEqual([]);
    expect(document).toBeDefined();
    const operations = Object.fromEntries(document!.operations().all().map((operation) =>
        [operation.id(), { action: operation.action(), messages: operation.messages().all().map((message) => message.id()) }]));
    expect(operations).toEqual({
        receiveClientMessage: { action: "receive", messages: ["ClientMessage"] },
        sendAgentMessage: { action: "send", messages: ["AgentMessage"] },
    });
    for (const message of document!.messages().all()) {
        // The external reference was followed: the payload is the message schema itself, not a bare $ref.
        const { schema } = message.payload()!.json() as { schema: { $ref?: string; description?: string; anyOf?: unknown[] } };
        expect(schema.$ref).toBeUndefined();
        expect(schema.description).toStartWith(`A message ${message.id().startsWith("Client") ? "a client" : "an agent"} sends`);
        expect(schema.anyOf!.length).toBeGreaterThan(3);
    }
});

test("references message schemas that openapi.yaml defines", () => {
    const schemas = buildOpenApi().components!.schemas!;
    for (const message of Object.values(buildAsyncApi().channels.acp.messages)) {
        const id = message.payload.schema.$ref.replace("./openapi.yaml#/components/schemas/", "");
        expect(schemas[id], id).toBeDefined();
    }
});
