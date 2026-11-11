import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { Config } from "../src/config.js";
import {
  claudeServerConfig,
  codexServerConfig,
  handleHookEvent,
  hookCommand,
  hookFilePath,
  hookStatus,
  installHook,
  launchOf,
  parseToolName,
  removeHook,
  resolveEntry,
  serverCachePath,
  tomlServer,
} from "../src/hooks.js";

let tmp: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "lookupd-hooks-"));
  env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, "xdg"), PATH: process.env.PATH ?? "" };
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const readJson = (path: string) =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

test("the hook command runs this cli by absolute path, quoted, with the client as argument", () => {
  const cmd = hookCommand("claude-code", "/opt/with space/cli.js", "/usr/local/bin/node");
  expect(cmd).toBe('"/usr/local/bin/node" "/opt/with space/cli.js" hook-event claude-code');
});

test("install adds our hook to Claude Code's settings without touching other settings or hooks, and is idempotent", () => {
  const path = hookFilePath("claude-code", env);
  expect(path).toBe(join(tmp, ".claude", "settings.json"));
  mkdirSync(join(tmp, ".claude"), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      model: "opus",
      hooks: {
        PostToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: "prettier" }] }],
      },
    }),
  );
  const first = installHook("claude-code", env, "node cli.js hook-event claude-code");
  expect(first).toEqual({ path, events: ["PostToolUse", "PostToolUseFailure"] });
  installHook("claude-code", env, "node cli.js hook-event claude-code");
  const file = readJson(path) as {
    model: string;
    hooks: Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>;
  };
  expect(file.model).toBe("opus");
  expect(file.hooks.PostToolUse).toHaveLength(2);
  expect(file.hooks.PostToolUse?.[0]?.hooks[0]?.command).toBe("prettier");
  expect(file.hooks.PostToolUse?.[1]).toEqual({
    matcher: "mcp__.*",
    hooks: [{ type: "command", command: "node cli.js hook-event claude-code", timeout: 10 }],
  });
  expect(file.hooks.PostToolUseFailure).toHaveLength(1);
  expect(hookStatus(env).map((s) => [s.client, s.installed])).toEqual([
    ["claude-code", true],
    ["codex", false],
  ]);

  const removed = removeHook("claude-code", env);
  expect(removed).toEqual({ path, removed: true });
  const after = readJson(path) as { hooks: Record<string, unknown[]> };
  expect(after.hooks.PostToolUse).toHaveLength(1);
  expect(after.hooks.PostToolUseFailure).toBeUndefined();
  expect(removeHook("claude-code", env).removed).toBe(false);
});

test("install creates Codex's hooks.json under CODEX_HOME with only a PostToolUse hook", () => {
  const codexEnv = { ...env, CODEX_HOME: join(tmp, "codex-home") };
  const { path, events } = installHook("codex", codexEnv, "node cli.js hook-event codex");
  expect(path).toBe(join(tmp, "codex-home", "hooks.json"));
  expect(events).toEqual(["PostToolUse"]);
  const file = readJson(path) as { hooks: Record<string, unknown[]> };
  expect(Object.keys(file.hooks)).toEqual(["PostToolUse"]);
  expect(hookStatus(codexEnv).find((s) => s.client === "codex")?.installed).toBe(true);
});

test("tool names: mcp__server__tool parses, anything else is not an MCP call", () => {
  expect(parseToolName("mcp__linear__list_issues")).toEqual({
    server: "linear",
    tool: "list_issues",
  });
  expect(parseToolName("mcp__my-server__get_thing.v2")).toEqual({
    server: "my-server",
    tool: "get_thing.v2",
  });
  expect(parseToolName("Bash")).toBeNull();
  expect(parseToolName("mcp__nope")).toBeNull();
  expect(parseToolName(undefined)).toBeNull();
});

test("a server's launch is its url, or the package a launcher runs; anything else is unknown", () => {
  expect(launchOf({ url: "https://mcp.linear.app/mcp" })).toEqual({
    url: "https://mcp.linear.app/mcp",
  });
  expect(launchOf({ command: "npx", args: ["-y", "@acme/pdf-mcp@1.2.0"] })).toEqual({
    package: "@acme/pdf-mcp@1.2.0",
  });
  expect(launchOf({ command: "/usr/local/bin/uvx", args: ["pdf-mcp"] })).toEqual({
    package: "pdf-mcp",
  });
  expect(launchOf({ command: "node", args: ["server.js"] })).toBeNull();
  expect(launchOf({ command: "npx", args: ["-y"] })).toBeNull();
  expect(launchOf(undefined)).toBeNull();
});

test("Claude Code configs: the project's .mcp.json wins, then the user's per-project and global servers", () => {
  const cwd = join(tmp, "proj");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(cwd, ".mcp.json"),
    JSON.stringify({ mcpServers: { linear: { type: "http", url: "https://project/mcp" } } }),
  );
  writeFileSync(
    join(tmp, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        linear: { url: "https://user/mcp" },
        pdf: { command: "npx", args: ["-y", "pdf-mcp"] },
      },
      projects: { [cwd]: { mcpServers: { sheets: { url: "https://local/mcp" } } } },
    }),
  );
  expect(claudeServerConfig("linear", cwd, env)).toEqual({
    type: "http",
    url: "https://project/mcp",
  });
  expect(claudeServerConfig("sheets", cwd, env)).toEqual({ url: "https://local/mcp" });
  expect(claudeServerConfig("pdf", cwd, env)).toEqual({ command: "npx", args: ["-y", "pdf-mcp"] });
  expect(claudeServerConfig("nope", cwd, env)).toBeUndefined();
});

test("Codex configs: just enough TOML for [mcp_servers.<name>] url, command and args", () => {
  const toml = `
model = "o3"

[mcp_servers.linear]
url = "https://mcp.linear.app/mcp" # remote
bearer_token_env_var = "LINEAR_TOKEN"

[mcp_servers."pdf-tools"]
command = "npx"
args = ["-y", "@acme/pdf-mcp"]

[mcp_servers.other]
command = 'uvx'
args = ['other-mcp']
`;
  expect(tomlServer(toml, "linear")).toEqual({ url: "https://mcp.linear.app/mcp" });
  expect(tomlServer(toml, "pdf-tools")).toEqual({ command: "npx", args: ["-y", "@acme/pdf-mcp"] });
  expect(tomlServer(toml, "other")).toEqual({ command: "uvx", args: ["other-mcp"] });
  expect(tomlServer(toml, "missing")).toBeUndefined();

  const codexEnv = { ...env, CODEX_HOME: join(tmp, "codex") };
  mkdirSync(join(tmp, "codex"), { recursive: true });
  writeFileSync(join(tmp, "codex", "config.toml"), toml);
  expect(codexServerConfig("linear", join(tmp, "elsewhere"), codexEnv)).toEqual({
    url: "https://mcp.linear.app/mcp",
  });
});

test("resolution asks the API once per server and caches hits for a week, misses for a day", async () => {
  const asked: unknown[] = [];
  const api = {
    resolve: async (q: unknown) => {
      asked.push(q);
      return { name: asked.length === 1 ? "io.github.acme/linear-mcp" : null, matches: [] };
    },
  };
  const t0 = 1_700_000_000_000;
  const launch = { url: "https://mcp.linear.app/mcp" };
  expect(await resolveEntry(api, "claude-code", "linear", launch, env, t0)).toBe(
    "io.github.acme/linear-mcp",
  );
  expect(await resolveEntry(api, "claude-code", "linear", launch, env, t0 + 6 * 86_400_000)).toBe(
    "io.github.acme/linear-mcp",
  );
  expect(asked).toHaveLength(1);
  expect(readJson(serverCachePath(env))).toMatchObject({
    "claude-code:linear:https://mcp.linear.app/mcp": { name: "io.github.acme/linear-mcp", at: t0 },
  });
  // A miss is remembered for a day, then asked again.
  expect(await resolveEntry(api, "codex", "x", { package: "nope" }, env, t0)).toBeNull();
  expect(
    await resolveEntry(api, "codex", "x", { package: "nope" }, env, t0 + 3_600_000),
  ).toBeNull();
  expect(asked).toHaveLength(2);
  await resolveEntry(api, "codex", "x", { package: "nope" }, env, t0 + 2 * 86_400_000);
  expect(asked).toHaveLength(3);
});

const on: Config = { telemetry: "unset" };
const off: Config = { telemetry: "off" };

function fakeApi() {
  const sent: unknown[] = [];
  return {
    sent,
    api: {
      resolve: async (q: { url?: string; package?: string }) => ({
        name: q.url === "https://mcp.linear.app/mcp" ? "io.github.acme/linear-mcp" : null,
        matches: [],
      }),
      events: async (batch: unknown[]) => {
        sent.push(...batch);
        return { accepted: batch.length, ignored: 0, principal: "anonymous" };
      },
    },
  };
}

test("a hook run sends one structured call event, and only the names and the verdict", async () => {
  const cwd = join(tmp, "proj");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(cwd, ".mcp.json"),
    JSON.stringify({ mcpServers: { linear: { url: "https://mcp.linear.app/mcp" } } }),
  );
  const { api, sent } = fakeApi();
  const payload = {
    session_id: "3f1c2b6e-aaaa-4bbb-8ccc-123456789abc",
    cwd,
    hook_event_name: "PostToolUse",
    tool_name: "mcp__linear__list_issues",
    tool_input: { query: "secret customer name" },
    tool_response: { content: [{ type: "text", text: "very private output" }] },
  };
  expect(await handleHookEvent({ client: "claude-code", payload, config: on, env, api })).toBe(
    "sent",
  );
  expect(sent).toEqual([
    {
      kind: "call",
      entry: "io.github.acme/linear-mcp",
      tool: "list_issues",
      ok: true,
      runtime: "claude-code",
      session: "3f1c2b6e-aaaa-4bbb-8ccc-123456789abc",
    },
  ]);
  const text = JSON.stringify(sent);
  expect(text).not.toContain("secret");
  expect(text).not.toContain("private");
  expect(text).not.toContain(cwd);

  // A failure event, or an MCP error result, is a failed call.
  await handleHookEvent({
    client: "claude-code",
    payload: { ...payload, hook_event_name: "PostToolUseFailure", error: "boom" },
    config: on,
    env,
    api,
  });
  await handleHookEvent({
    client: "claude-code",
    payload: { ...payload, tool_response: { isError: true, content: [] } },
    config: on,
    env,
    api,
  });
  expect(sent.slice(1).map((e) => (e as { ok: boolean }).ok)).toEqual([false, false]);
});

test("a hook run sends nothing when telemetry is off, for non-MCP tools, or for servers it cannot name", async () => {
  const cwd = join(tmp, "proj");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(cwd, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        linear: { url: "https://mcp.linear.app/mcp" },
        local: { command: "node", args: ["server.js"] },
        unknown: { url: "https://nowhere.example/mcp" },
      },
    }),
  );
  const { api, sent } = fakeApi();
  const base = { session_id: "s", cwd, hook_event_name: "PostToolUse" };
  const run = (
    tool_name: string,
    config: Config = on,
    client: "claude-code" | "codex" = "claude-code",
  ) => handleHookEvent({ client, payload: { ...base, tool_name }, config, env, api });
  expect(await run("mcp__linear__list_issues", off)).toBe("off");
  expect(await run("Bash")).toBe("not_mcp");
  expect(await run("mcp__local__thing")).toBe("unknown_server");
  expect(await run("mcp__unknown__thing")).toBe("unknown_entry");
  expect(await run("mcp__linear__list_issues", on, "codex")).toBe("unknown_server");
  expect(
    await handleHookEvent({ client: "claude-code", payload: "garbage", config: on, env, api }),
  ).toBe("not_mcp");
  expect(sent).toEqual([]);
  // A session id the client made up is sent only when it fits the fixed character set.
  await handleHookEvent({
    client: "claude-code",
    payload: { ...base, session_id: "has spaces in it", tool_name: "mcp__linear__list_issues" },
    config: on,
    env,
    api,
  });
  expect(sent[0]).not.toHaveProperty("session");
});

test("an API that fails or hangs makes a failed run, never an exception", async () => {
  const cwd = join(tmp, "proj");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(
    join(cwd, ".mcp.json"),
    JSON.stringify({ mcpServers: { linear: { url: "https://mcp.linear.app/mcp" } } }),
  );
  const api = {
    resolve: async () => {
      throw new Error("network down");
    },
    events: async () => {
      throw new Error("unreachable");
    },
  };
  expect(
    await handleHookEvent({
      client: "claude-code",
      payload: { cwd, hook_event_name: "PostToolUse", tool_name: "mcp__linear__list_issues" },
      config: on,
      env,
      api,
    }),
  ).toBe("failed");
});
