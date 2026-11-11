import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LookupdApi } from "./api.js";
import { type Config, configPath, telemetryState } from "./config.js";
import type { CallEvent } from "./types.js";

/**
 * The opt-in call hook. `lookupd hooks install` adds one PostToolUse hook (and, in Claude Code,
 * one PostToolUseFailure hook) that runs `lookupd hook-event <client>` after every MCP tool call.
 * The handler reads the client's hook JSON on stdin, keeps the server and tool names and whether
 * the call succeeded, resolves the server's registry name through the client's MCP config (sent:
 * the name; never the config, arguments, output, prompt, cwd or any path), and posts one call
 * event. It never fails the tool call it describes and sends nothing while telemetry is off.
 */
export type HookClient = "claude-code" | "codex";
export const HOOK_CLIENTS: HookClient[] = ["claude-code", "codex"];

/** Every MCP tool: the clients name them mcp__<server>__<tool>. */
const MATCHER = "mcp__.*";
/** Our subcommand, which is how we recognise our own hook entries whatever path they carry. */
const SUBCOMMAND = "hook-event";
/** The events each client fires after a tool call; Codex has no failure event. */
const EVENTS: Record<HookClient, string[]> = {
  "claude-code": ["PostToolUse", "PostToolUseFailure"],
  codex: ["PostToolUse"],
};
const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,120}$/;
const HIT_TTL_MS = 7 * 86_400_000;
const MISS_TTL_MS = 86_400_000;

const home = (env: NodeJS.ProcessEnv) => env.HOME || homedir();
const codexHome = (env: NodeJS.ProcessEnv) => env.CODEX_HOME || join(home(env), ".codex");

/** Where each client keeps its hooks: Claude Code's user settings, Codex's hooks file. */
export function hookFilePath(client: HookClient, env: NodeJS.ProcessEnv = process.env): string {
  return client === "claude-code"
    ? join(home(env), ".claude", "settings.json")
    : join(codexHome(env), "hooks.json");
}

const quote = (s: string) => JSON.stringify(s);

/** `"<node>" "<this cli>" hook-event <client>`: absolute paths, so the hook needs no PATH or npx. */
export function hookCommand(
  client: HookClient,
  cliPath: string = fileURLToPath(import.meta.url),
  node: string = process.execPath,
): string {
  return `${quote(node)} ${quote(cliPath)} ${SUBCOMMAND} ${client}`;
}

type HookHandler = { type?: unknown; command?: unknown; timeout?: unknown };
type HookGroup = { matcher?: unknown; hooks?: unknown };
type HookFile = { hooks?: Record<string, unknown>; [key: string]: unknown };

function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

const isOurs = (g: HookGroup): boolean =>
  Array.isArray(g.hooks) &&
  g.hooks.some(
    (h: HookHandler) => typeof h.command === "string" && h.command.includes(` ${SUBCOMMAND} `),
  );

/** Adds (or replaces) our hook in the client's file. Other hooks and settings are left alone. */
export function installHook(
  client: HookClient,
  env: NodeJS.ProcessEnv = process.env,
  command: string = hookCommand(client),
): { path: string; events: string[] } {
  const path = hookFilePath(client, env);
  const file = readJsonFile<HookFile>(path) ?? {};
  const hooks: Record<string, unknown> =
    file.hooks && typeof file.hooks === "object" ? file.hooks : {};
  for (const event of EVENTS[client]) {
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as HookGroup[]) : [];
    hooks[event] = [
      ...existing.filter((g) => !isOurs(g)),
      { matcher: MATCHER, hooks: [{ type: "command", command, timeout: 10 }] },
    ];
  }
  file.hooks = hooks;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  return { path, events: EVENTS[client] };
}

/** Removes only our hook entries; an untouched file is not rewritten. */
export function removeHook(
  client: HookClient,
  env: NodeJS.ProcessEnv = process.env,
): { path: string; removed: boolean } {
  const path = hookFilePath(client, env);
  const file = existsSync(path) ? readJsonFile<HookFile>(path) : null;
  const hooks = file?.hooks;
  if (!file || !hooks || typeof hooks !== "object") return { path, removed: false };
  let removed = false;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = (groups as HookGroup[]).filter((g) => !isOurs(g));
    if (kept.length === groups.length) continue;
    removed = true;
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  if (!removed) return { path, removed };
  if (Object.keys(hooks).length === 0) delete file.hooks;
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  return { path, removed };
}

export function hookStatus(
  env: NodeJS.ProcessEnv = process.env,
): Array<{ client: HookClient; path: string; installed: boolean }> {
  return HOOK_CLIENTS.map((client) => {
    const path = hookFilePath(client, env);
    const file = existsSync(path) ? readJsonFile<HookFile>(path) : null;
    const installed = Object.values(file?.hooks ?? {}).some(
      (groups) => Array.isArray(groups) && (groups as HookGroup[]).some(isOurs),
    );
    return { client, path, installed };
  });
}

/** `mcp__<server>__<tool>` as both clients name MCP tools; anything else is not an MCP call. */
export function parseToolName(name: unknown): { server: string; tool: string } | null {
  if (typeof name !== "string") return null;
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m?.[1] && m[2] ? { server: m[1], tool: m[2] } : null;
}

export type Launch = { url: string } | { package: string };
export interface ServerConfig {
  url?: unknown;
  command?: unknown;
  args?: unknown;
}

const LAUNCHERS = new Set(["npx", "bunx", "pnpx", "uvx", "pipx"]);

/** What identifies a configured server to the registry: its remote url, or the package a launcher runs. */
export function launchOf(config: ServerConfig | undefined | null): Launch | null {
  if (!config) return null;
  if (typeof config.url === "string" && config.url.trim()) return { url: config.url.trim() };
  const command =
    typeof config.command === "string" ? (config.command.split(/[\\/]/).pop() ?? "") : "";
  if (!LAUNCHERS.has(command)) return null;
  const args = Array.isArray(config.args) ? config.args : [];
  const pkg = args.find(
    (a): a is string => typeof a === "string" && a !== "" && !a.startsWith("-"),
  );
  return pkg ? { package: pkg } : null;
}

type McpServers = Record<string, ServerConfig>;

/** Claude Code: the project's .mcp.json, then ~/.claude.json (the project's entry, then the user's). */
export function claudeServerConfig(
  server: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig | undefined {
  const project = readJsonFile<{ mcpServers?: McpServers }>(join(cwd, ".mcp.json"));
  const user = readJsonFile<{
    mcpServers?: McpServers;
    projects?: Record<string, { mcpServers?: McpServers }>;
  }>(join(home(env), ".claude.json"));
  return (
    project?.mcpServers?.[server] ??
    user?.projects?.[cwd]?.mcpServers?.[server] ??
    user?.mcpServers?.[server]
  );
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const tomlString = (v: string): string | null => {
  const m = /^"((?:[^"\\]|\\.)*)"/.exec(v) ?? /^'([^']*)'/.exec(v);
  return m ? (m[1] ?? "").replace(/\\"/g, '"') : null;
};
const tomlArray = (v: string): string[] =>
  [...v.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) =>
    (m[1] ?? m[2] ?? "").replace(/\\"/g, '"'),
  );

/** Just enough TOML: the `[mcp_servers.<name>]` table's url, command and args. */
export function tomlServer(text: string, server: string): ServerConfig | undefined {
  const header = new RegExp(
    `^\\[mcp_servers\\.(?:"${escapeRe(server)}"|${escapeRe(server)})\\]\\s*(?:#.*)?$`,
  );
  let inside = false;
  let found = false;
  const out: ServerConfig = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inside = header.test(line);
      if (inside) found = true;
      continue;
    }
    if (!inside || !line || line.startsWith("#")) continue;
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2] ?? "";
    if (key === "url" || key === "command") {
      const s = tomlString(value);
      if (s !== null) out[key] = s;
    } else if (key === "args") out.args = tomlArray(value);
  }
  return found ? out : undefined;
}

/** Codex: the project's .codex/config.toml, then $CODEX_HOME/config.toml (default ~/.codex). */
export function codexServerConfig(
  server: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig | undefined {
  for (const path of [join(cwd, ".codex", "config.toml"), join(codexHome(env), "config.toml")]) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const found = tomlServer(text, server);
    if (found) return found;
  }
  return undefined;
}

interface CacheEntry {
  name: string | null;
  at: number;
}

/** `~/.config/lookupd/servers.json`: resolved registry names per client server, so one hook run costs no API call. */
export const serverCachePath = (env: NodeJS.ProcessEnv = process.env) =>
  join(dirname(configPath(env)), "servers.json");

export async function resolveEntry(
  api: Pick<LookupdApi, "resolve">,
  client: HookClient,
  server: string,
  launch: Launch,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): Promise<string | null> {
  const key = `${client}:${server}:${"url" in launch ? launch.url : launch.package}`;
  const path = serverCachePath(env);
  const cache = readJsonFile<Record<string, CacheEntry>>(path) ?? {};
  const hit = cache[key];
  if (hit && now - hit.at < (hit.name ? HIT_TTL_MS : MISS_TTL_MS)) return hit.name;
  const res = await api.resolve(launch);
  cache[key] = { name: res.name, at: now };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // A cache that cannot be written only costs the next run an API call.
  }
  return res.name;
}

export interface HookPayload {
  hook_event_name?: unknown;
  tool_name?: unknown;
  session_id?: unknown;
  cwd?: unknown;
  tool_response?: unknown;
}

export type HookResult = "sent" | "off" | "not_mcp" | "unknown_server" | "unknown_entry" | "failed";

/** One hook run. Never throws: the tool call it describes must never fail because of it. */
export async function handleHookEvent(input: {
  client: HookClient;
  payload: unknown;
  config: Config;
  env: NodeJS.ProcessEnv;
  api: Pick<LookupdApi, "resolve" | "events">;
  now?: number;
}): Promise<HookResult> {
  try {
    if (!telemetryState(input.config, input.env).on) return "off";
    const p = (
      input.payload && typeof input.payload === "object" ? input.payload : {}
    ) as HookPayload;
    const parsed = parseToolName(p.tool_name);
    if (!parsed || !TOOL_NAME.test(parsed.tool)) return "not_mcp";
    const cwd = typeof p.cwd === "string" && p.cwd ? p.cwd : process.cwd();
    const config =
      input.client === "claude-code"
        ? claudeServerConfig(parsed.server, cwd, input.env)
        : codexServerConfig(parsed.server, cwd, input.env);
    const launch = launchOf(config);
    if (!launch) return "unknown_server";
    const entry = await resolveEntry(
      input.api,
      input.client,
      parsed.server,
      launch,
      input.env,
      input.now,
    );
    if (!entry) return "unknown_entry";
    const response = p.tool_response as { isError?: unknown } | null | undefined;
    const failed =
      p.hook_event_name === "PostToolUseFailure" ||
      (!!response && typeof response === "object" && response.isError === true);
    const session =
      typeof p.session_id === "string" && SESSION_ID.test(p.session_id) ? p.session_id : undefined;
    const event: CallEvent = {
      kind: "call",
      entry,
      tool: parsed.tool,
      ok: !failed,
      runtime: input.client,
      ...(session ? { session } : {}),
    };
    await input.api.events([event]);
    return "sent";
  } catch {
    return "failed";
  }
}

/** What `hooks install` prints: the consent text, in the same words as the telemetry policy. */
export const HOOK_NOTICE = `The hook runs after each MCP tool call and sends lookupd one event: the server's registry name
(resolved from the URL or package in your MCP config; the config itself never leaves this machine),
the tool name, whether the call succeeded, your runtime and the client's random session id.
Never arguments, output, prompts, the working directory or any path. It sends nothing while
telemetry is off (lookupd telemetry off, or DO_NOT_TRACK=1).  Remove:  lookupd hooks remove
Policy: https://lookupd.com/telemetry`;
