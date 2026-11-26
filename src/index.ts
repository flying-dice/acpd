import { parseArgs } from "node:util";
import { readConfig } from "./config.ts";
import { startProxy } from "./proxy.ts";

try {
    const { values } = parseArgs({ options: { config: { type: "string", short: "c" } } });
    const { path, config } = await readConfig(values.config);
    console.log(`acpd using ${path}`);
    const server = startProxy(config);
    const stop = () => void server.shutdown();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    console.log(`acpd serving ACP at ws://${server.hostname}:${server.port}/acp with ${Object.keys(config.agents).join(", ")}`);
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
}
