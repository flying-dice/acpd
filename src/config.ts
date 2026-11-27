import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, posix, resolve, win32 } from "node:path";
import { z } from "zod";

const agentSchema = z.strictObject({
    /** Executable that speaks ACP over stdio. */
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    /** Added to acpd's environment. */
    env: z.record(z.string(), z.string()).default({}),
});

const configSchema = z.strictObject({
    host: z.string().min(1).default("127.0.0.1"),
    port: z.number().int().min(0).max(65535).default(3000),
    /** Agent used when a client names none. Defaults to the first agent. */
    defaultAgent: z.string().min(1).optional(),
    agents: z.record(z.string(), agentSchema),
});

export type AgentConfig = z.output<typeof agentSchema>;
export type Config = z.output<typeof configSchema> & { defaultAgent: string };

/** `./` and `../` values are relative to the config file. */
const relativeTo = (base: string, value: string) => /^\.\.?[\\/]/.test(value) ? resolve(base, value) : value;

export function parseConfig(value: unknown, base = process.cwd()): Config {
    const parsed = configSchema.safeParse(value);
    if (!parsed.success) throw new Error(`Invalid acpd config: ${z.prettifyError(parsed.error)}`);
    const { agents, defaultAgent = Object.keys(agents)[0] } = parsed.data;
    for (const id of Object.keys(agents)) {
        if (!/^[\w.-]+$/.test(id)) throw new Error(`Agent ID ${id} may only contain letters, digits, '_', '.', and '-'.`);
    }
    if (!defaultAgent || !agents[defaultAgent]) throw new Error(defaultAgent ? `defaultAgent ${defaultAgent} is not configured.` : "Configure at least one agent.");
    return {
        ...parsed.data,
        defaultAgent,
        agents: Object.fromEntries(Object.entries(agents).map(([id, agent]) => [id, {
            command: relativeTo(base, agent.command),
            args: agent.args.map((arg) => relativeTo(base, arg)),
            env: Object.fromEntries(Object.entries(agent.env).map(([name, env]) => [name, relativeTo(base, env)])),
        }])),
    };
}

export const CONFIG_FILE = "acpd.config.json";

export interface SearchOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    home?: string;
}

/**
 * Where acpd looks for its config when none is named, first match wins:
 * `acpd.config.json` in the working directory and each parent, then
 * `~/.acpd/config.json`, then the user config directory, then the system
 * config directory.
 */
export function configSearchPaths({ cwd = process.cwd(), env = process.env, platform = process.platform, home = homedir() }: SearchOptions = {}): string[] {
    const { dirname, join, resolve } = platform === "win32" ? win32 : posix;
    const paths: string[] = [];
    for (let dir = resolve(cwd); ; dir = dirname(dir)) {
        paths.push(join(dir, CONFIG_FILE));
        if (dirname(dir) === dir) break;
    }
    paths.push(join(home, ".acpd", "config.json"));
    const user = (dir: string | undefined) => dir && paths.push(join(dir, "acpd", "config.json"));
    if (platform === "win32") {
        user(env.APPDATA ?? join(home, "AppData", "Roaming"));
        user(env.ProgramData ?? env.PROGRAMDATA ?? "C:\\ProgramData");
    } else {
        user(env.XDG_CONFIG_HOME || join(home, ".config"));
        if (platform === "darwin") user(join(home, "Library", "Application Support"));
        for (const dir of (env.XDG_CONFIG_DIRS || "/etc/xdg").split(":")) user(dir);
        user("/etc");
    }
    return [...new Set(paths)];
}

/**
 * Finds the config file: the explicit path (from `--config`), then
 * `ACPD_CONFIG`, then the first of `configSearchPaths` that exists.
 */
export function findConfig(explicit?: string, options: SearchOptions = {}): string {
    const named = explicit ?? (options.env ?? process.env).ACPD_CONFIG;
    if (named) {
        const path = resolve(options.cwd ?? process.cwd(), named);
        if (!existsSync(path)) throw new Error(`Config file ${path} does not exist.`);
        return path;
    }
    const searched = configSearchPaths(options);
    const found = searched.find((path) => existsSync(path));
    if (!found) throw new Error(`No acpd config found. Create one of:\n  ${searched.join("\n  ")}`);
    return found;
}

/** Finds and parses the config. Relative paths inside it resolve against its directory. */
export async function readConfig(explicit?: string, options?: SearchOptions): Promise<{ path: string; config: Config }> {
    const path = findConfig(explicit, options);
    return { path, config: parseConfig(await Bun.file(path).json(), dirname(path)) };
}
