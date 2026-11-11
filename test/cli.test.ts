import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeAll, expect, test } from "vitest";
import { startRemote } from "./helpers/remote-server.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "dist", "cli.js");
const version = (
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }
).version;

beforeAll(() => {
  execFileSync("pnpm", ["exec", "tsup"], { cwd: root, stdio: "pipe" });
}, 60_000);

let tmp: string;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const run = (args: string[], env: Record<string, string> = {}) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    tmp ??= mkdtempSync(join(tmpdir(), "lookupd-cli-"));
    const child = spawn(process.execPath, [cli, ...args], {
      env: { PATH: process.env.PATH ?? "", XDG_CONFIG_HOME: tmp, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });

test("--version prints the package version", async () => {
  const r = await run(["--version"]);
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe(version);
});

test("find prints results from the REST API, as a table or as JSON", async () => {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ranking: "provisional",
        results: [
          {
            name: "io.github.acme/linear-mcp",
            title: "Linear",
            description: "Read Linear issues",
            transports: ["streamable-http"],
            install: [
              {
                runtime: "claude-code",
                kind: "command",
                label: "remote",
                value: "claude mcp add --transport http linear https://x",
              },
            ],
            lookupd: { verification: "unverified" },
          },
        ],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const json = await run(["find", "linear", "issues", "--json"], { LOOKUPD_API_URL: base });
  expect(json.status).toBe(0);
  expect((JSON.parse(json.stdout) as { results: Array<{ name: string }> }).results[0]?.name).toBe(
    "io.github.acme/linear-mcp",
  );
  const table = await run(["find", "linear issues", "--runtime", "claude-code"], {
    LOOKUPD_API_URL: base,
  });
  expect(table.status).toBe(0);
  expect(table.stdout).toContain("io.github.acme/linear-mcp");
  expect(table.stdout).toContain("claude mcp add --transport http linear https://x");
  expect(table.stdout).toMatch(/provisional/i);
});

test("telemetry status is on by default and names the source of the setting", async () => {
  expect((await run(["telemetry", "status"])).stdout.split("\n")[0]).toBe("on (default)");
  expect((await run(["telemetry", "status"], { DO_NOT_TRACK: "1" })).stdout.split("\n")[0]).toBe(
    "off (DO_NOT_TRACK is set)",
  );
  expect((await run(["telemetry", "on"])).status).toBe(0);
  expect((await run(["telemetry", "status"])).stdout.split("\n")[0]).toBe(
    "on (set by lookupd telemetry on)",
  );
  expect(JSON.parse(readFileSync(join(tmp, "lookupd", "config.json"), "utf8")).telemetry).toBe(
    "on",
  );
  expect((await run(["telemetry", "off"])).status).toBe(0);
  expect((await run(["telemetry", "status"])).stdout.split("\n")[0]).toBe(
    "off (set by lookupd telemetry off)",
  );
  // The explicit choice beats DO_NOT_TRACK; LOOKUPD_TELEMETRY beats the explicit choice.
  expect((await run(["telemetry", "status"], { DO_NOT_TRACK: "1" })).stdout.split("\n")[0]).toBe(
    "off (set by lookupd telemetry off)",
  );
  expect(
    (await run(["telemetry", "status"], { LOOKUPD_TELEMETRY: "1" })).stdout.split("\n")[0],
  ).toBe("on (LOOKUPD_TELEMETRY=1)");
  expect((await run(["telemetry", "maybe"])).status).toBe(1);
});

test("login stores an API key", async () => {
  expect((await run(["login", "--key", "lk_abc"])).status).toBe(0);
  expect(JSON.parse(readFileSync(join(tmp, "lookupd", "config.json"), "utf8")).apiKey).toBe(
    "lk_abc",
  );
  expect((await run(["login"])).status).toBe(1);
});

async function mcpSession(env: Record<string, string>) {
  const remote = await startRemote();
  cleanups.push(remote.close);
  tmp ??= mkdtempSync(join(tmpdir(), "lookupd-cli-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp"],
    env: {
      PATH: process.env.PATH ?? "",
      XDG_CONFIG_HOME: tmp,
      LOOKUPD_API_URL: remote.url.replace(/\/mcp$/, ""),
      ...env,
    },
    stderr: "pipe",
  });
  const stderr = { text: "" };
  transport.stderr?.on("data", (d: Buffer) => {
    stderr.text += d.toString();
  });
  const client = new Client({ name: "agent", version: "0" });
  await client.connect(transport);
  cleanups.push(() => client.close());
  const { tools } = await client.listTools();
  return { client, tools: tools.map((t) => t.name).sort(), stderr };
}

test("mcp serves the remote tools over stdio, with report_outcome on by default, and prints the one-time notice", async () => {
  const { client, tools, stderr } = await mcpSession({});
  expect(tools).toEqual(["find_capability", "get_entry", "health", "report_outcome"]);
  const res = (await client.callTool({
    name: "find_capability",
    arguments: { task: "linear" },
  })) as {
    structuredContent?: { results: Array<{ name: string }> };
  };
  expect(res.structuredContent?.results[0]?.name).toBe("a/b");
  await new Promise((r) => setTimeout(r, 100));
  expect(stderr.text).toMatch(/outcome reports are on/);
  expect(stderr.text).toMatch(/lookupd telemetry off/);
  expect(stderr.text).toMatch(/DO_NOT_TRACK=1/);
  expect(stderr.text).toMatch(/lookupd\.com\/telemetry/);
  expect(JSON.parse(readFileSync(join(tmp, "lookupd", "config.json"), "utf8")).noticeVersion).toBe(
    3,
  );
});

test("mcp with DO_NOT_TRACK hides report_outcome and prints no notice", async () => {
  const { tools, stderr } = await mcpSession({ DO_NOT_TRACK: "1" });
  expect(tools).toEqual(["find_capability", "get_entry", "health"]);
  await new Promise((r) => setTimeout(r, 100));
  expect(stderr.text).toBe("");
});

test("mcp after lookupd telemetry off hides report_outcome", async () => {
  expect((await run(["telemetry", "off"])).status).toBe(0);
  const { tools, stderr } = await mcpSession({});
  expect(tools).toEqual(["find_capability", "get_entry", "health"]);
  await new Promise((r) => setTimeout(r, 100));
  expect(stderr.text).toBe("");
});

test("telemetry status shows the install id once one exists, and reset rotates it", async () => {
  // Any command while telemetry is on makes the id, status included.
  const before = await run(["telemetry", "status"]);
  expect(before.stdout).toMatch(/install id: [0-9a-f-]{36}/);
  const config = () =>
    JSON.parse(readFileSync(join(tmp, "lookupd", "config.json"), "utf8")) as { installId?: string };
  const first = config().installId;
  expect(first).toMatch(/^[0-9a-f-]{36}$/);
  expect((await run(["telemetry", "status"])).stdout).toContain(`install id: ${first}`);
  const reset = await run(["telemetry", "reset"]);
  expect(reset.status).toBe(0);
  expect(reset.stdout).toContain("install id rotated");
  expect(config().installId).not.toBe(first);
  // Off: no id is made for a fresh config.
  expect(
    (await run(["telemetry", "status"], { DO_NOT_TRACK: "1", XDG_CONFIG_HOME: join(tmp, "other") }))
      .stdout,
  ).toContain("none yet");
});
