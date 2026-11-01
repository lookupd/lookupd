import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export interface RemoteCall {
  name: string;
  args: Record<string, unknown>;
}

/** A stateless remote lookupd-like MCP server: fresh McpServer per POST, like the real API. */
export async function startRemote(): Promise<{
  url: string;
  calls: RemoteCall[];
  close(): Promise<void>;
}> {
  const calls: RemoteCall[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d: Buffer) => {
      raw += d.toString();
    });
    req.on("end", async () => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      const mcp = new McpServer({ name: "remote-stub", version: "0" });
      const record = (name: string) => (args: Record<string, unknown>) => {
        calls.push({ name, args });
        const result = { echoed: name, args };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result,
        };
      };
      mcp.registerTool(
        "find_capability",
        { description: "stub", inputSchema: { task: z.string(), runtime: z.string().optional() } },
        (args) => {
          calls.push({ name: "find_capability", args });
          const result = { results: [{ name: "a/b", install: [] }], ranking: "provisional" };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            structuredContent: result,
          };
        },
      );
      mcp.registerTool(
        "get_entry",
        { description: "stub", inputSchema: { name: z.string() } },
        record("get_entry"),
      );
      mcp.registerTool(
        "health",
        { description: "stub", inputSchema: { name: z.string() } },
        record("health"),
      );
      mcp.registerTool(
        "report_outcome",
        {
          description: "stub",
          inputSchema: { entry: z.string(), success: z.boolean().optional() },
        },
        record("report_outcome"),
      );
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
