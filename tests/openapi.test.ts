import { afterAll, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import { methods, spec as acpSpec } from "../src/acp.ts";
import { buildOpenApi, openApiYaml } from "../src/openapi.ts";
import { startProxy } from "../src/proxy.ts";
import { HttpError } from "../src/schemas.ts";

type Response31 = { headers?: Record<string, { schema: { const: string } }>; content: Record<string, { schema: unknown }> };
const spec = buildOpenApi();
const server = startProxy(parseConfig({ port: 0, agents: { mock: { command: "unused" } } }), { env: {} });
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => server.shutdown());

/** The error codes a documented response allows. */
function codes(schema: unknown): string[] {
    const node = schema as { oneOf?: unknown[]; properties?: { error?: { const: string } } };
    return node.oneOf ? node.oneOf.flatMap(codes) : [node.properties!.error!.const];
}

test("openapi.yaml is generated from src/openapi.ts", async () => {
    expect(await Bun.file(new URL("../openapi.yaml", import.meta.url)).text()).toBe(openApiYaml());
    expect(spec.openapi).toBe("3.2.0");
    expect(spec.info.version).toBe((await Bun.file(new URL("../package.json", import.meta.url)).json()).version);
});

test("every HTTP error matches its documented status, body, and headers", async () => {
    const crossOrigin = { Origin: "https://example.com" };
    const cases: [string, string, RequestInit][] = [
        ["get", "upgrade_required", {}],
        ["get", "forbidden", { headers: crossOrigin }],
        ["post", "method_not_allowed", { method: "POST" }],
        ["post", "forbidden", { method: "POST", headers: crossOrigin }],
        ["delete", "method_not_allowed", { method: "DELETE" }],
        ["delete", "forbidden", { method: "DELETE", headers: crossOrigin }],
    ];
    for (const [method, code, init] of cases) {
        const response = await fetch(`${base}/acp`, init);
        const documented = spec.paths!["/acp"]![method as "get"]!.responses![String(response.status)] as Response31;
        expect(documented).toBeDefined();
        const body = HttpError.parse(await response.json());
        expect(body.error).toBe(code as typeof body.error);
        expect(codes(documented.content["application/json"]!.schema)).toContain(code);
        for (const [name, header] of Object.entries(documented.headers ?? {})) {
            expect(response.headers.get(name)).toBe(header.schema.const);
        }
    }
    expect(HttpError.parse(await (await fetch(`${base}/elsewhere`)).json()).error).toBe("not_found");
});

test("includes every ACP v1 type and resolves every reference", () => {
    const schemas = spec.components!.schemas!;
    for (const type of Object.keys(acpSpec.$defs)) expect(schemas[`Acp${type}`], type).toBeDefined();
    expect((schemas.ClientMessage as { description: string }).description).toBe("A message a client sends under ACP v1.");
    expect((schemas.AgentMessage as { description: string }).description).toBe("A message an agent sends under ACP v1.");
    const refs = new Set<string>();
    JSON.stringify(spec, (key, value) => {
        if (key === "$ref") refs.add(value);
        return value;
    });
    const missing = [...refs].filter((ref) => {
        const [, kind, name] = /^#\/components\/(\w+)\/(.+)$/.exec(ref) ?? [];
        return !kind || !(spec.components as Record<string, Record<string, unknown>>)[kind]?.[name!];
    });
    expect(missing).toEqual([]);
});

test("publishes the method table the proxy validates with", () => {
    const published = spec["x-acp-methods"] as Record<string, Record<string, { params: { $ref: string }; result?: { $ref: string } }>>;
    for (const [side, table] of Object.entries(methods)) {
        expect(Object.keys(published[side]!).sort()).toEqual(Object.keys(table).sort());
        for (const [method, { params, result }] of Object.entries(table)) {
            expect(published[side]![method]).toEqual({
                params: { $ref: `#/components/schemas/Acp${params}` },
                ...(result && { result: { $ref: `#/components/schemas/Acp${result}` } }),
            });
        }
    }
});
