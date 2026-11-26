import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { configSearchPaths, findConfig, parseConfig } from "../src/config.ts";

test("applies defaults and resolves ./ paths against the config file", () => {
    const base = resolve("/etc/acpd");
    expect(parseConfig({ agents: { pi: { command: "node", args: ["./pi.js", "--x"], env: { BIN: "./bin/pi", MODE: "rpc" } } } }, base)).toEqual({
        host: "127.0.0.1", port: 3000, defaultAgent: "pi",
        agents: { pi: { command: "node", args: [resolve(base, "pi.js"), "--x"], env: { BIN: resolve(base, "bin/pi"), MODE: "rpc" } } },
    });
});

test("rejects invalid configs", () => {
    expect(() => parseConfig({ agents: {} })).toThrow("at least one agent");
    expect(() => parseConfig({ defaultAgent: "x", agents: { a: { command: "a" } } })).toThrow("defaultAgent x");
    expect(() => parseConfig({ agents: { "a/b": { command: "a" } } })).toThrow("Agent ID a/b");
    expect(() => parseConfig({ agents: { a: { command: "a", cmd: "b" } } })).toThrow("Invalid acpd config");
});

test("searches the working directory upward, then user and system config directories", () => {
    expect(configSearchPaths({ platform: "linux", cwd: "/home/u/proj", home: "/home/u", env: { XDG_CONFIG_HOME: "/xdg" } })).toEqual([
        "/home/u/proj/acpd.config.json", "/home/u/acpd.config.json", "/home/acpd.config.json", "/acpd.config.json",
        "/xdg/acpd/config.json", "/etc/xdg/acpd/config.json", "/etc/acpd/config.json",
    ]);
    expect(configSearchPaths({ platform: "darwin", cwd: "/", home: "/Users/u", env: {} })).toEqual([
        "/acpd.config.json", "/Users/u/.config/acpd/config.json", "/Users/u/Library/Application Support/acpd/config.json",
        "/etc/xdg/acpd/config.json", "/etc/acpd/config.json",
    ]);
    expect(configSearchPaths({ platform: "win32", cwd: String.raw`C:\proj`, home: String.raw`C:\Users\u`, env: { APPDATA: String.raw`C:\Users\u\AppData\Roaming` } })).toEqual([
        String.raw`C:\proj\acpd.config.json`, String.raw`C:\acpd.config.json`,
        String.raw`C:\Users\u\AppData\Roaming\acpd\config.json`, String.raw`C:\ProgramData\acpd\config.json`,
    ]);
});

test("prefers --config, then ACPD_CONFIG, then the nearest discovered file", () => {
    const root = mkdtempSync(join(tmpdir(), "acpd-"));
    try {
        const cwd = join(root, "project", "nested");
        mkdirSync(cwd, { recursive: true });
        const options = { cwd, home: root, env: { XDG_CONFIG_HOME: root, APPDATA: root, ProgramData: root } };
        expect(() => findConfig(undefined, options)).toThrow("No acpd config found");

        const userConfig = join(root, "acpd", "config.json");
        mkdirSync(dirname(userConfig));
        writeFileSync(userConfig, "{}");
        expect(findConfig(undefined, options)).toBe(userConfig);

        const projectConfig = join(root, "project", "acpd.config.json");
        writeFileSync(projectConfig, "{}");
        expect(findConfig(undefined, options)).toBe(projectConfig);

        expect(findConfig(undefined, { ...options, env: { ...options.env, ACPD_CONFIG: userConfig } })).toBe(userConfig);
        expect(findConfig("../acpd.config.json", { ...options, env: { ACPD_CONFIG: userConfig } })).toBe(projectConfig);
        expect(() => findConfig("missing.json", options)).toThrow("does not exist");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
