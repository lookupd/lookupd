import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pkg from "../package.json" with { type: "json" };
import { LookupdApi, LookupdApiError } from "./api.js";
import { createBridge } from "./bridge.js";
import { detectRuntime, readConfig, writeConfig } from "./config.js";
import { formatResults } from "./find-cmd.js";
import type { Runtime } from "./types.js";

const USAGE = `lookupd ${pkg.version} — find the right MCP server, skill or agent for a task

usage:
  lookupd mcp                                   serve lookupd's tools over stdio (for MCP clients)
  lookupd find <task...> [--runtime R] [--limit N] [--json]
  lookupd telemetry on|off|status               opt in/out of anonymous outcome reports
  lookupd login --key lk_...                    store an API key (optional)
  lookupd --version

Environment: LOOKUPD_API_URL (default https://api.lookupd.com), XDG_CONFIG_HOME
`;

const NOTICE = `lookupd: telemetry is off. Outcome reports (did the tool work? how long? which runtime?)
improve rankings for everyone and contain structured fields only: never prompts, task text or
paths. Enable with:  lookupd telemetry on     Policy: https://lookupd.com/telemetry
`;

const RUNTIMES: Runtime[] = ["claude-code", "claude-desktop", "cursor", "vscode", "generic"];

interface Io {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        runtime: { type: "string" },
        limit: { type: "string" },
        json: { type: "boolean" },
        key: { type: "string" },
        version: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    });
  } catch (err) {
    io.stderr.write(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    return 1;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    io.stdout.write(`${pkg.version}\n`);
    return 0;
  }
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    io.stdout.write(USAGE);
    return command ? 0 : 1;
  }
  const config = readConfig(env);
  const runtime = detectRuntime(env);
  const userAgent = `lookupd-cli/${pkg.version} (${runtime})`;
  const api = new LookupdApi({ userAgent, env, apiKey: config.apiKey });

  switch (command) {
    case "mcp": {
      const telemetryOn = config.telemetry === "on";
      if (config.telemetry === "unset" && !config.noticeShown) {
        io.stderr.write(NOTICE);
        writeConfig({ ...config, noticeShown: true }, env);
      }
      const bridge = await createBridge({
        remoteUrl: new URL(`${api.baseUrl}/mcp`),
        headers: {
          "user-agent": userAgent,
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        telemetryOn,
        stderr: io.stderr,
        version: pkg.version,
      });
      const closed = new Promise<void>((resolve) => {
        bridge.server.onclose = () => resolve();
      });
      await bridge.server.connect(new StdioServerTransport());
      void bridge.connectRemote();
      await closed;
      await bridge.close();
      return 0;
    }
    case "find": {
      const task = rest.join(" ").trim();
      if (!task) {
        io.stderr.write(`usage: lookupd find <task...>\n`);
        return 1;
      }
      const chosen = (values.runtime as string | undefined) ?? runtime;
      if (!RUNTIMES.includes(chosen as Runtime)) {
        io.stderr.write(`--runtime must be one of ${RUNTIMES.join(", ")}\n`);
        return 1;
      }
      const limit = values.limit === undefined ? undefined : Number(values.limit);
      try {
        const res = await api.find({ task, runtime: chosen as Runtime, limit });
        io.stdout.write(values.json ? `${JSON.stringify(res, null, 2)}\n` : formatResults(res));
        return 0;
      } catch (err) {
        if (err instanceof LookupdApiError && err.status === 429) {
          io.stderr.write(`lookupd: rate limited; retry in ${err.retryAfterSeconds ?? 60}s\n`);
        } else {
          io.stderr.write(`lookupd: ${err instanceof Error ? err.message : String(err)}\n`);
        }
        return 1;
      }
    }
    case "telemetry": {
      const mode = rest[0];
      if (mode === "status") {
        io.stdout.write(`${config.telemetry}\n`);
        return 0;
      }
      if (mode === "on" || mode === "off") {
        writeConfig({ ...config, telemetry: mode, noticeShown: true }, env);
        io.stdout.write(
          mode === "on"
            ? "telemetry on: structured outcome reports will be shared (never prompts, task text or paths)\n"
            : "telemetry off\n",
        );
        return 0;
      }
      io.stderr.write("usage: lookupd telemetry on|off|status\n");
      return 1;
    }
    case "login": {
      const key = values.key as string | undefined;
      if (!key || !/^lk_[A-Za-z0-9]+$/.test(key)) {
        io.stderr.write("usage: lookupd login --key lk_<key>\n");
        return 1;
      }
      writeConfig({ ...config, apiKey: key }, env);
      io.stdout.write("API key stored\n");
      return 0;
    }
    default:
      io.stderr.write(`unknown command: ${command}\n${USAGE}`);
      return 1;
  }
}

process.exitCode = await main(process.argv.slice(2), process.env, {
  stdout: process.stdout,
  stderr: process.stderr,
});
