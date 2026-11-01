import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

export const TELEMETRY_OFF_MESSAGE =
  "Telemetry is off. Run `lookupd telemetry on` to share anonymous outcome data (see https://lookupd.com/telemetry).";

export const FALLBACK_TOOL_NAMES = [
  "find_capability",
  "get_entry",
  "health",
  "report_outcome",
] as const;

const str = (description: string) => ({ type: "string", description });

/** What the agent sees when the API cannot be reached: the tools exist, calls will explain why they fail. */
export const FALLBACK_TOOLS: Tool[] = [
  {
    name: "find_capability",
    description:
      "Find MCP servers for a task (lookupd). Currently unreachable; calls return an error.",
    inputSchema: {
      type: "object",
      properties: { task: str("Short capability phrase") },
      required: ["task"],
    },
  },
  {
    name: "get_entry",
    description: "Details for one entry by registry name (lookupd).",
    inputSchema: {
      type: "object",
      properties: { name: str("Registry name, e.g. io.github.acme/linear-mcp") },
      required: ["name"],
    },
  },
  {
    name: "health",
    description: "Registry status for one entry (lookupd).",
    inputSchema: { type: "object", properties: { name: str("Registry name") }, required: ["name"] },
  },
  {
    name: "report_outcome",
    description: "Report whether an entry found via lookupd worked (structured fields only).",
    inputSchema: {
      type: "object",
      properties: { entry: str("Registry name"), success: { type: "boolean" } },
      required: ["entry"],
    },
  },
];

export interface BridgeOptions {
  remoteUrl: URL;
  headers: Record<string, string>;
  telemetryOn: boolean;
  stderr: { write(chunk: string): unknown };
  version: string;
}

export interface Bridge {
  server: Server;
  /** Start connecting to the remote now (errors are swallowed; calls retry lazily). */
  connectRemote(): Promise<void>;
  close(): Promise<void>;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const errorResult = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

/**
 * A stdio MCP server that forwards tool calls to the remote lookupd endpoint. It never blocks
 * startup on the network, and it exposes report_outcome only once the user opted in.
 */
export async function createBridge(opts: BridgeOptions): Promise<Bridge> {
  const server = new Server(
    { name: "lookupd", version: opts.version },
    {
      capabilities: { tools: {} },
      instructions:
        "lookupd finds MCP servers, skills and agents for a task. Call find_capability with a short capability phrase. Results are provisional. Lookups are free.",
    },
  );
  let client: Client | null = null;
  let connecting: Promise<Client> | null = null;

  const connect = (): Promise<Client> => {
    if (client) return Promise.resolve(client);
    if (!connecting) {
      connecting = (async () => {
        const c = new Client({ name: "lookupd-cli", version: opts.version });
        await c.connect(
          new StreamableHTTPClientTransport(opts.remoteUrl, {
            requestInit: { headers: opts.headers },
          }),
        );
        client = c;
        return c;
      })().finally(() => {
        connecting = null;
      });
    }
    return connecting;
  };

  const visible = (tools: Tool[]) =>
    opts.telemetryOn ? tools : tools.filter((t) => t.name !== "report_outcome");

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const { tools } = await (await connect()).listTools();
      return { tools: visible(tools) };
    } catch (err) {
      opts.stderr.write(`lookupd: API unreachable (${message(err)}); listing known tools\n`);
      return { tools: visible(FALLBACK_TOOLS) };
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (name === "report_outcome" && !opts.telemetryOn) return errorResult(TELEMETRY_OFF_MESSAGE);
    let c: Client;
    try {
      c = await connect();
    } catch (err) {
      return errorResult(`lookupd API unreachable: ${message(err)}`);
    }
    try {
      return (await c.callTool({ name, arguments: args ?? {} })) as CallToolResult;
    } catch (err) {
      client = null; // reconnect on the next call
      return errorResult(`lookupd call failed: ${message(err)}`);
    }
  });

  return {
    server,
    connectRemote: () =>
      connect().then(
        () => undefined,
        () => undefined,
      ),
    close: async () => {
      await client?.close().catch(() => undefined);
      await server.close();
    },
  };
}
