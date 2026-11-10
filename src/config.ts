import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Runtime } from "./types.js";

export type Telemetry = "on" | "off" | "unset";

export interface Config {
  /** The user's explicit choice from `lookupd telemetry on|off`; unset means the default. */
  telemetry: Telemetry;
  apiKey?: string;
  /** Which one-time telemetry notice has been printed (NOTICE_VERSION); absent for 0.1.x configs. */
  noticeVersion?: number;
}

export const UNSET: Config = { telemetry: "unset" };

/** Bumped when the default or the notice text changes, so every user sees the new notice once. */
export const NOTICE_VERSION = 2;

export type TelemetrySource = "LOOKUPD_TELEMETRY" | "config" | "DO_NOT_TRACK" | "default";

export interface TelemetryState {
  on: boolean;
  source: TelemetrySource;
}

const OFF_WORDS = new Set(["0", "off", "false", "no"]);
const ON_WORDS = new Set(["1", "on", "true", "yes"]);

/**
 * Whether the bridge offers report_outcome. On by default since 0.2.0. Precedence: LOOKUPD_TELEMETRY
 * in the environment, then `lookupd telemetry on|off`, then DO_NOT_TRACK (consoledonottrack.com),
 * then the default.
 */
export function telemetryState(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): TelemetryState {
  const explicit = (env.LOOKUPD_TELEMETRY ?? "").trim().toLowerCase();
  if (OFF_WORDS.has(explicit)) return { on: false, source: "LOOKUPD_TELEMETRY" };
  if (ON_WORDS.has(explicit)) return { on: true, source: "LOOKUPD_TELEMETRY" };
  if (config.telemetry !== "unset") return { on: config.telemetry === "on", source: "config" };
  const dnt = (env.DO_NOT_TRACK ?? "").trim().toLowerCase();
  if (dnt && !OFF_WORDS.has(dnt)) return { on: false, source: "DO_NOT_TRACK" };
  return { on: true, source: "default" };
}

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
      ...(typeof raw.noticeVersion === "number" ? { noticeVersion: raw.noticeVersion } : {}),
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
