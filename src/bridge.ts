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
  "Telemetry is off for this user, so no report was sent. Leave the setting alone; the user can run `lookupd telemetry on` (policy: https://lookupd.com/telemetry).";

export const FALLBACK_TOOL_NAMES = [
  "find_capability",
  "get_entry",
  "health",
  "report_outcome",
] as const;

const str = (description: string) => ({ type: "string", description });

const DOMAINS = [
  "software-engineering",
  "devops-cloud",
  "data-analytics",
  "finance",
  "legal-compliance",
  "sales-crm",
  "marketing",
  "customer-support",
  "hr-recruiting",
  "operations",
  "research",
  "education",
  "healthcare",
  "ecommerce",
  "design-media",
  "personal",
  "other",
];

/** The workflow fields every tool takes, so lookups and outcomes join up in one conversation. */
const WORKFLOW_PROPERTIES = {
  session: {
    type: "string",
    pattern: "^[A-Za-z0-9_-]{8,64}$",
    description:
      "A random id you make up once per conversation and repeat on every lookupd call in it, report_outcome included; never derived from the user, project or machine",
  },
  domain: { type: "string", enum: DOMAINS, description: "What the conversation is about" },
};

/** What the agent sees when the API cannot be reached: the tools exist, calls will explain why they fail. */
export const FALLBACK_TOOLS: Tool[] = [
  {
    name: "find_capability",
    description:
      "Find MCP servers for a task (lookupd). Currently unreachable; calls return an error.",
    inputSchema: {
      type: "object",
      properties: { task: str("Short capability phrase"), ...WORKFLOW_PROPERTIES },
      required: ["task"],
    },
  },
  {
    name: "get_entry",
    description:
      "Details for one entry (lookupd): by registry name, or by the remote url or package of a server in your MCP config.",
    inputSchema: {
      type: "object",
      properties: {
        name: str("Registry name, e.g. io.github.acme/linear-mcp"),
        url: str("Remote URL from the MCP config"),
        package: str("npm or PyPI package from the MCP config"),
        ...WORKFLOW_PROPERTIES,
      },
    },
  },
  {
    name: "health",
    description: "Registry status for one entry (lookupd).",
    inputSchema: {
      type: "object",
      properties: { name: str("Registry name"), ...WORKFLOW_PROPERTIES },
      required: ["name"],
    },
  },
  {
    name: "report_outcome",
    description:
      "After a task used an MCP server, report whether it worked (lookupd; structured fields only).",
    inputSchema: {
      type: "object",
      properties: {
        entry: str("Registry name"),
        success: { type: "boolean" },
        capability_tag: str("One tag from lookupd's taxonomy"),
        latency_bucket: { type: "string", enum: ["lt1s", "lt5s", "lt30s", "gte30s"] },
        runtime: {
          type: "string",
          enum: ["claude-code", "claude-desktop", "cursor", "vscode", "generic"],
        },
        error_class: { type: "string", enum: ["auth", "timeout", "schema", "tool_error", "other"] },
        ...WORKFLOW_PROPERTIES,
        step: {
          type: "integer",
          minimum: 1,
          description: "Order in which this server was first used in the conversation",
        },
        tool: {
          type: "string",
          pattern: "^[A-Za-z0-9_.-]{1,120}$",
          description: "The tool used most on the server, by name",
        },
        found_via: { type: "string", enum: ["lookupd", "installed"] },
      },
      required: ["entry", "success"],
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
 * startup on the network, and it hides report_outcome when the user turned telemetry off.
 */
export async function createBridge(opts: BridgeOptions): Promise<Bridge> {
  const server = new Server(
    { name: "lookupd", version: opts.version },
    {
      capabilities: { tools: {} },
      instructions:
        "lookupd finds MCP servers, skills and agents for a task. Call find_capability with a short capability phrase. Results are provisional. Lookups are free. After a task uses any MCP server, call report_outcome once per server (when listed); for a server already installed, get its registry name from get_entry with the server's url or package. Reports hold structured fields only, never prompts, task text, paths or output; the user controls them with `lookupd telemetry on|off`, never you.",
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
