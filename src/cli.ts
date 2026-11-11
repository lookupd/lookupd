import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pkg from "../package.json" with { type: "json" };
import { LookupdApi, LookupdApiError } from "./api.js";
import { createBridge } from "./bridge.js";
import {
  detectRuntime,
  ensureInstallId,
  NOTICE_VERSION,
  readConfig,
  rotateInstallId,
  telemetryState,
  writeConfig,
} from "./config.js";
import { formatResults } from "./find-cmd.js";
import {
  HOOK_CLIENTS,
  HOOK_NOTICE,
  type HookClient,
  handleHookEvent,
  hookStatus,
  installHook,
  removeHook,
} from "./hooks.js";
import type { Runtime } from "./types.js";

const USAGE = `lookupd ${pkg.version} — find the right MCP server, skill or agent for a task

usage:
  lookupd mcp                                   serve lookupd's tools over stdio (for MCP clients)
  lookupd find <task...> [--runtime R] [--limit N] [--json]
  lookupd telemetry on|off|status|reset         anonymous outcome reports (on by default); reset rotates the install id
  lookupd hooks install|remove|status [--client claude-code|codex]
                                                opt-in: report which servers and tools get called
  lookupd login --key lk_...                    store an API key (optional)
  lookupd --version

Environment: LOOKUPD_API_URL (default https://api.lookupd.com), XDG_CONFIG_HOME,
  DO_NOT_TRACK=1 or LOOKUPD_TELEMETRY=0 (turn outcome reports off)
`;

const NOTICE = `lookupd: anonymous outcome reports are on. After a task uses an MCP server, the agent may
report which server, whether it worked, a latency bucket, your runtime, and structured workflow
fields (a random per-conversation id, step, tool name, domain from a fixed list). Each request
also carries a random install id made up once for this install, so lookupd can count installs
that come back (rotate it: lookupd telemetry reset). Never prompts, task text, paths or output.
Turn off:  lookupd telemetry off   (or DO_NOT_TRACK=1)
Policy: https://lookupd.com/telemetry
`;

const STATUS_REASON = {
  default: "default",
  config: "set by lookupd telemetry",
  DO_NOT_TRACK: "DO_NOT_TRACK is set",
  LOOKUPD_TELEMETRY: "LOOKUPD_TELEMETRY=",
} as const;

const RUNTIMES: Runtime[] = [
  "claude-code",
  "codex",
  "claude-desktop",
  "cursor",
  "vscode",
  "generic",
];

interface Io {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
}

async function readStdin(): Promise<string> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
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
        client: { type: "string" },
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
  let config = readConfig(env);
  const runtime = detectRuntime(env);
  const userAgent = `lookupd-cli/${pkg.version} (${runtime})`;
  // The install id exists only while telemetry is on: off means nothing is sent, so nothing is made.
  let installId: string | undefined;
  if (telemetryState(config, env).on) {
    const ensured = ensureInstallId(config, env);
    config = ensured.config;
    installId = ensured.installId;
  }
  const api = new LookupdApi({ userAgent, env, apiKey: config.apiKey, installId });

  switch (command) {
    case "mcp": {
      const telemetry = telemetryState(config, env);
      // Shown once per notice version, only when the default decides; an explicit choice or an
      // environment opt-out needs no reminder.
      if (telemetry.source === "default" && config.noticeVersion !== NOTICE_VERSION) {
        io.stderr.write(NOTICE);
        writeConfig({ ...config, noticeVersion: NOTICE_VERSION }, env);
      }
      const telemetryOn = telemetry.on;
      const bridge = await createBridge({
        remoteUrl: new URL(`${api.baseUrl}/mcp`),
        headers: {
          "user-agent": userAgent,
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
          ...(installId ? { "x-lookupd-install": installId } : {}),
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
        const t = telemetryState(config, env);
        const reason =
          t.source === "config"
            ? `${STATUS_REASON.config} ${config.telemetry}`
            : t.source === "LOOKUPD_TELEMETRY"
              ? `${STATUS_REASON.LOOKUPD_TELEMETRY}${env.LOOKUPD_TELEMETRY}`
              : STATUS_REASON[t.source];
        io.stdout.write(`${t.on ? "on" : "off"} (${reason})\n`);
        io.stdout.write(
          `install id: ${config.installId ?? "none yet (made on first use while on)"}  (rotate: lookupd telemetry reset)\n`,
        );
        return 0;
      }
      if (mode === "on" || mode === "off") {
        writeConfig({ ...config, telemetry: mode, noticeVersion: NOTICE_VERSION }, env);
        io.stdout.write(
          mode === "on"
            ? "telemetry on: structured outcome reports will be shared (never prompts, task text or paths)\n"
            : "telemetry off: the agent will not be offered report_outcome\n",
        );
        return 0;
      }
      if (mode === "reset") {
        rotateInstallId(config, env);
        io.stdout.write("install id rotated: lookupd now sees this install as a new one\n");
        return 0;
      }
      io.stderr.write("usage: lookupd telemetry on|off|status|reset\n");
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
    case "hooks": {
      const action = rest[0];
      const client = (values.client as string | undefined) ?? "claude-code";
      if (!HOOK_CLIENTS.includes(client as HookClient)) {
        io.stderr.write(`--client must be one of ${HOOK_CLIENTS.join(", ")}\n`);
        return 1;
      }
      if (action === "status") {
        for (const s of hookStatus(env))
          io.stdout.write(
            `${s.client}: ${s.installed ? "installed" : "not installed"} (${s.path})\n`,
          );
        return 0;
      }
      if (action === "install") {
        const { path, events } = installHook(client as HookClient, env);
        io.stdout.write(`hook installed in ${path} (${events.join(", ")})\n${HOOK_NOTICE}\n`);
        if (client === "codex")
          io.stdout.write(
            "Codex runs a new hook only once you trust it: open Codex and run /hooks.\n",
          );
        return 0;
      }
      if (action === "remove") {
        const { path, removed } = removeHook(client as HookClient, env);
        io.stdout.write(removed ? `hook removed from ${path}\n` : `no lookupd hook in ${path}\n`);
        return 0;
      }
      io.stderr.write("usage: lookupd hooks install|remove|status [--client claude-code|codex]\n");
      return 1;
    }
    case "hook-event": {
      // Runs inside the client after every MCP tool call. It never fails and never prints: the
      // tool call it describes must not notice it.
      const client = rest[0];
      if (!HOOK_CLIENTS.includes(client as HookClient)) return 0;
      let payload: unknown = null;
      try {
        payload = JSON.parse(await readStdin());
      } catch {
        return 0;
      }
      await handleHookEvent({
        client: client as HookClient,
        payload,
        config,
        env,
        api: new LookupdApi({
          userAgent: `lookupd-hook/${pkg.version} (${client})`,
          env,
          apiKey: config.apiKey,
          installId,
          timeoutMs: 3_000,
        }),
      });
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
