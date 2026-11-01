import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Runtime } from "./types.js";

export type Telemetry = "on" | "off" | "unset";

export interface Config {
  /** Opt-in sharing of structured outcome events. Off/unset hides the report_outcome tool. */
  telemetry: Telemetry;
  apiKey?: string;
  /** The one-time telemetry notice has been printed. */
  noticeShown?: boolean;
}

export const UNSET: Config = { telemetry: "unset" };

/** `$XDG_CONFIG_HOME/lookupd/config.json`, else `~/.config/lookupd/config.json`. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(env.HOME ?? homedir(), ".config");
  return join(base, "lookupd", "config.json");
}

/** Never throws: a missing or corrupt file reads as unset. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  try {
    const raw = JSON.parse(readFileSync(configPath(env), "utf8")) as Record<string, unknown>;
    const telemetry: Telemetry =
      raw.telemetry === "on" || raw.telemetry === "off" ? raw.telemetry : "unset";
    return {
      telemetry,
      ...(typeof raw.apiKey === "string" && raw.apiKey ? { apiKey: raw.apiKey } : {}),
      ...(raw.noticeShown === true ? { noticeShown: true } : {}),
    };
  } catch {
    return { ...UNSET };
  }
}

export function writeConfig(config: Config, env: NodeJS.ProcessEnv = process.env): void {
  const path = configPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/** Best-effort guess of the host agent from its environment, for install snippets and UA. */
export function detectRuntime(env: NodeJS.ProcessEnv = process.env): Runtime {
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return "claude-code";
  if (env.CURSOR_TRACE_ID) return "cursor";
  if (env.TERM_PROGRAM === "vscode" || env.VSCODE_PID) return "vscode";
  return "generic";
}
