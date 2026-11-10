import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  configPath,
  detectRuntime,
  NOTICE_VERSION,
  readConfig,
  telemetryState,
  writeConfig,
} from "../src/config.js";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const env = () => {
  dir = mkdtempSync(join(tmpdir(), "lookupd-cfg-"));
  return { XDG_CONFIG_HOME: dir };
};

test("missing config reads as telemetry unset", () => {
  const e = env();
  expect(configPath(e)).toBe(join(dir, "lookupd", "config.json"));
  expect(readConfig(e)).toEqual({ telemetry: "unset" });
});

test("write then read round-trips and creates the directory", () => {
  const e = env();
  writeConfig({ telemetry: "on", apiKey: "lk_x", noticeVersion: NOTICE_VERSION }, e);
  expect(readConfig(e)).toEqual({ telemetry: "on", apiKey: "lk_x", noticeVersion: NOTICE_VERSION });
  expect(JSON.parse(readFileSync(configPath(e), "utf8")).telemetry).toBe("on");
});

test("a 0.1.x config (noticeShown) reads without a notice version, so the new notice shows once", () => {
  const e = env();
  writeConfig({ telemetry: "unset" }, e);
  writeFileSync(configPath(e), JSON.stringify({ telemetry: "unset", noticeShown: true }));
  expect(readConfig(e)).toEqual({ telemetry: "unset" });
});

test("telemetryState: on by default; config beats DO_NOT_TRACK; LOOKUPD_TELEMETRY beats both", () => {
  const unset = { telemetry: "unset" } as const;
  expect(telemetryState(unset, {})).toEqual({ on: true, source: "default" });
  expect(telemetryState(unset, { DO_NOT_TRACK: "1" })).toEqual({
    on: false,
    source: "DO_NOT_TRACK",
  });
  expect(telemetryState(unset, { DO_NOT_TRACK: "true" })).toEqual({
    on: false,
    source: "DO_NOT_TRACK",
  });
  expect(telemetryState(unset, { DO_NOT_TRACK: "0" })).toEqual({ on: true, source: "default" });
  expect(telemetryState(unset, { DO_NOT_TRACK: "" })).toEqual({ on: true, source: "default" });
  expect(telemetryState({ telemetry: "off" }, {})).toEqual({ on: false, source: "config" });
  expect(telemetryState({ telemetry: "on" }, { DO_NOT_TRACK: "1" })).toEqual({
    on: true,
    source: "config",
  });
  expect(telemetryState({ telemetry: "on" }, { LOOKUPD_TELEMETRY: "0" })).toEqual({
    on: false,
    source: "LOOKUPD_TELEMETRY",
  });
  expect(telemetryState({ telemetry: "off" }, { LOOKUPD_TELEMETRY: "on" })).toEqual({
    on: true,
    source: "LOOKUPD_TELEMETRY",
  });
  // An unrecognised LOOKUPD_TELEMETRY value is ignored, not treated as on.
  expect(telemetryState(unset, { LOOKUPD_TELEMETRY: "maybe", DO_NOT_TRACK: "1" })).toEqual({
    on: false,
    source: "DO_NOT_TRACK",
  });
});

test("a corrupt config file reads as unset instead of crashing", () => {
  const e = env();
  writeConfig({ telemetry: "off" }, e);
  const path = configPath(e);
  writeFileSync(path, "{not json");
  expect(readConfig(e)).toEqual({ telemetry: "unset" });
});

test("detectRuntime recognises Claude Code, Cursor and VS Code, else generic", () => {
  expect(detectRuntime({ CLAUDECODE: "1" })).toBe("claude-code");
  expect(detectRuntime({ CLAUDE_CODE_ENTRYPOINT: "cli" })).toBe("claude-code");
  expect(detectRuntime({ CURSOR_TRACE_ID: "abc" })).toBe("cursor");
  expect(detectRuntime({ TERM_PROGRAM: "vscode" })).toBe("vscode");
  expect(detectRuntime({ VSCODE_PID: "123" })).toBe("vscode");
  expect(detectRuntime({})).toBe("generic");
});
