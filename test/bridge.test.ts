import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, test } from "vitest";
import { createBridge, FALLBACK_TOOL_NAMES, TELEMETRY_OFF_MESSAGE } from "../src/bridge.js";
import { startRemote } from "./helpers/remote-server.js";

type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: string; text?: string }>;
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const stderr = { chunks: [] as string[], write: (s: string) => stderr.chunks.push(s) };

async function bridged(remoteUrl: string, telemetryOn: boolean) {
  const bridge = await createBridge({
    remoteUrl: new URL(remoteUrl),
    headers: { "user-agent": "lookupd-cli/test (generic)" },
    telemetryOn,
    stderr,
    version: "test",
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await bridge.server.connect(serverSide);
  const client = new Client({ name: "agent", version: "0" });
  await client.connect(clientSide);
  cleanups.push(async () => {
    await client.close();
    await bridge.close();
  });
  return client;
}

test("with telemetry off, report_outcome is hidden and rejected locally; nothing reaches the remote", async () => {
  const remote = await startRemote();
  cleanups.push(remote.close);
  const client = await bridged(remote.url, false);
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(["find_capability", "get_entry", "health"]);
  const res = (await client.callTool({
    name: "report_outcome",
    arguments: { entry: "a/b", success: true },
  })) as ToolResult;
  expect(res.isError).toBe(true);
  expect(res.content[0]?.text).toBe(TELEMETRY_OFF_MESSAGE);
  expect(remote.calls.filter((c) => c.name === "report_outcome")).toHaveLength(0);
});

test("with telemetry on, all four tools are listed and calls are forwarded with their results", async () => {
  const remote = await startRemote();
  cleanups.push(remote.close);
  const client = await bridged(remote.url, true);
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual([
    "find_capability",
    "get_entry",
    "health",
    "report_outcome",
  ]);
  const found = (await client.callTool({
    name: "find_capability",
    arguments: { task: "linear issues" },
  })) as ToolResult;
  expect(found.isError).toBeFalsy();
  expect(found.structuredContent).toMatchObject({ results: [{ name: "a/b" }] });
  const reported = (await client.callTool({
    name: "report_outcome",
    arguments: { entry: "a/b", success: true },
  })) as ToolResult;
  expect(reported.isError).toBeFalsy();
  expect(remote.calls.map((c) => c.name)).toEqual(["find_capability", "report_outcome"]);
});

test("when the remote is unreachable the bridge still starts: known tools are listed and calls return errors", async () => {
  const client = await bridged("http://127.0.0.1:1/mcp", true);
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual([...FALLBACK_TOOL_NAMES].sort());
  const res = (await client.callTool({
    name: "find_capability",
    arguments: { task: "x" },
  })) as ToolResult;
  expect(res.isError).toBe(true);
  expect(res.content[0]?.text).toMatch(/unreachable/i);
});
