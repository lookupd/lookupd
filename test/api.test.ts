import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { LookupdApi, LookupdApiError } from "../src/api.js";

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

let server: Server | undefined;
const seen: Seen[] = [];

async function stub(
  handler: (req: Seen) => { status: number; body: unknown; headers?: Record<string, string> },
) {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => {
      body += d.toString();
    });
    req.on("end", () => {
      const s = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      seen.push(s);
      const out = handler(s);
      res.writeHead(out.status, { "content-type": "application/json", ...(out.headers ?? {}) });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  seen.length = 0;
  if (server) await new Promise<void>((r) => server?.close(() => r()));
  server = undefined;
});

test("find() calls GET /v0.1/find with the query, runtime, limit and a lookupd user agent", async () => {
  const base = await stub(() => ({
    status: 200,
    body: { results: [{ name: "a/b" }], ranking: "provisional" },
  }));
  const api = new LookupdApi({ baseUrl: base, userAgent: "lookupd-cli/test (claude-code)" });
  const res = await api.find({ task: "linear issues", runtime: "claude-code", limit: 3 });
  expect(res.results[0]?.name).toBe("a/b");
  const req = seen[0];
  expect(req?.method).toBe("GET");
  const url = new URL(req?.url ?? "", base);
  expect(url.pathname).toBe("/v0.1/find");
  expect(url.searchParams.get("task")).toBe("linear issues");
  expect(url.searchParams.get("runtime")).toBe("claude-code");
  expect(url.searchParams.get("limit")).toBe("3");
  expect(req?.headers["user-agent"]).toBe("lookupd-cli/test (claude-code)");
  expect(req?.headers.authorization).toBeUndefined();
});

test("a configured API key is sent as a bearer token; events() posts the batch", async () => {
  const base = await stub(() => ({
    status: 202,
    body: { accepted: 1, ignored: 0, principal: "api_key" },
  }));
  const api = new LookupdApi({ baseUrl: base, apiKey: "lk_abc", userAgent: "t" });
  const res = await api.events([{ kind: "install", entry: "a/b", runtime: "cursor" }]);
  expect(res.accepted).toBe(1);
  expect(seen[0]?.method).toBe("POST");
  expect(seen[0]?.url).toBe("/v0.1/events");
  expect(seen[0]?.headers.authorization).toBe("Bearer lk_abc");
  expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({
    events: [{ kind: "install", entry: "a/b", runtime: "cursor" }],
  });
});

test("non-2xx responses become LookupdApiError with status, body and Retry-After", async () => {
  const base = await stub(() => ({
    status: 429,
    body: { title: "Too Many Requests", status: 429 },
    headers: { "retry-after": "17" },
  }));
  const api = new LookupdApi({ baseUrl: base, userAgent: "t" });
  const err = await api.find({ task: "x" }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(LookupdApiError);
  const e = err as LookupdApiError;
  expect(e.status).toBe(429);
  expect(e.retryAfterSeconds).toBe(17);
  expect(e.message).toMatch(/429/);
});

test("entry() and health() address the entry by name", async () => {
  const base = await stub((req) => ({ status: 200, body: { url: req.url } }));
  const api = new LookupdApi({ baseUrl: base, userAgent: "t" });
  expect(((await api.entry("io.github.acme/linear-mcp")) as { url: string }).url).toBe(
    "/v0.1/entries/io.github.acme%2Flinear-mcp",
  );
  expect(((await api.health("io.github.acme/linear-mcp")) as { url: string }).url).toBe(
    "/v0.1/entries/io.github.acme%2Flinear-mcp/health",
  );
});

test("the default base URL is the production API, overridable by LOOKUPD_API_URL", () => {
  expect(new LookupdApi({ userAgent: "t", env: {} }).baseUrl).toBe("https://api.lookupd.com");
  expect(
    new LookupdApi({ userAgent: "t", env: { LOOKUPD_API_URL: "http://localhost:3000/" } }).baseUrl,
  ).toBe("http://localhost:3000");
});
