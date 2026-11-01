import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { configPath, detectRuntime, readConfig, writeConfig } from "../src/config.js";

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
  writeConfig({ telemetry: "on", apiKey: "lk_x", noticeShown: true }, e);
  expect(readConfig(e)).toEqual({ telemetry: "on", apiKey: "lk_x", noticeShown: true });
  expect(JSON.parse(readFileSync(configPath(e), "utf8")).telemetry).toBe("on");
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
