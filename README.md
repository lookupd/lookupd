# lookupd

**The registry agents call to find the right MCP server, skill or agent for a task.**
Free to look up. Neutral: lookupd never hosts or proxies tool calls, and rank is never for sale.
Rankings are *provisional* until real outcome evidence exists.

This repository holds everything an agent installs:

- `lookupd` on npm: the CLI and the `npx lookupd mcp` stdio bridge to the lookupd API
- `skills/find-capability`: the skill that teaches an agent the find → approve → install → report loop
- a Claude Code plugin + marketplace (this repo is both)

The API, crawler and ranking live in a private repository. Data: Official MCP Registry (CC0),
mirrored and enriched by lookupd; lookupd is not affiliated with the MCP project.

## Install

**Claude Code** (plugin: skill + MCP tools):

```
/plugin marketplace add lookupd/lookupd
/plugin install lookupd@lookupd
```

**Any agent that reads skills** (skills.sh):

```
npx skills add lookupd/lookupd
```

**MCP only**, any client that launches stdio servers:

```
claude mcp add lookupd -- npx -y lookupd@latest mcp
```

`.vscode/mcp.json`:

```json
{ "servers": { "lookupd": { "command": "npx", "args": ["-y", "lookupd@latest", "mcp"] } } }
```

`.cursor/mcp.json` / Claude Desktop:

```json
{ "mcpServers": { "lookupd": { "command": "npx", "args": ["-y", "lookupd@latest", "mcp"] } } }
```

Remote endpoint, for clients that connect to streamable HTTP directly: `https://api.lookupd.com/mcp`.

## Tools

| tool | what it does |
|---|---|
| `find_capability` | `{ task, runtime?, max_results? }` → ranked candidates with paste-ready install snippets |
| `get_entry` | full details for one entry by registry name |
| `health` | registry status and last-seen time (live probes coming) |
| `report_outcome` | structured outcome report; hidden when telemetry is off |

## CLI

```
npx lookupd find "read Linear issues" --runtime claude-code
npx lookupd find "pdf extraction" --json
npx lookupd telemetry on|off|status   # anonymous outcome reports: on by default
npx lookupd hooks install|remove|status [--client claude-code|codex]   # opt-in call hook
npx lookupd login --key lk_...        # optional API key
npx lookupd mcp                       # stdio bridge (what the plugin runs)
```

Environment: `LOOKUPD_API_URL` (default `https://api.lookupd.com`), `XDG_CONFIG_HOME`,
`DO_NOT_TRACK=1` or `LOOKUPD_TELEMETRY=0` (outcome reports off). Config lives at
`~/.config/lookupd/config.json`.

## Telemetry

On by default from 0.2.0, with a one-time notice on the first `lookupd mcp` run (0.1.x was
opt-in). Turn it off with `lookupd telemetry off` or `DO_NOT_TRACK=1`; `LOOKUPD_TELEMETRY=0|1`
overrides both, and `lookupd telemetry status` shows the setting and where it comes from. When
off, the bridge hides `report_outcome` from the agent and sends nothing.

When on, the agent can call `report_outcome` after a task used an MCP server (found through
lookupd or already installed). A report contains only: the entry name, success,
a latency bucket, your runtime, a capability tag from a fixed list, an error class, and workflow fields: a random per-conversation id the agent makes up, the order of use, the name of the tool used, the conversation's domain from a fixed list, and whether lookupd found the server.
Never prompts, task text, file paths or output. Lookups themselves are free and unauthenticated;
the search phrase is stored truncated to 160 characters as anonymous demand data.
Policy: https://lookupd.com/telemetry

Every find response carries a `lookup_id`; the skill quotes it in the outcome report, so a report
names the exact search that found the server.

From 0.3.0, while telemetry is on, every request also carries a random install id the CLI made up
once (`X-Lookupd-Install`, kept in the config file), so lookupd can count how many installs come
back week to week. It names the install, never you. `lookupd telemetry reset` replaces it, and
`lookupd telemetry status` shows it.

## Call hooks (opt-in)

`lookupd hooks install` (add `--client codex` for Codex) writes one hook into
`~/.claude/settings.json` or `~/.codex/hooks.json` that runs after every MCP tool call. It sends
lookupd one event per call: the server's registry name (resolved once from the URL or package in
your MCP config and cached in `~/.config/lookupd/servers.json`; the config never leaves the
machine), the tool name, whether the call succeeded, your runtime and the client's random session
id. Never arguments, output, prompts, the working directory or any path. It sends nothing while
telemetry is off, never slows or fails the tool call (3 s budget, always exit 0), and
`lookupd hooks remove` takes it out. Codex runs a new hook only once you trust it with `/hooks`.
The hook command uses absolute paths to this install of lookupd, so prefer `npm i -g lookupd`
over `npx` for it.

## Develop

```
pnpm install
pnpm test        # vitest: bridge, CLI, API client, config, manifests
pnpm build       # tsup → dist/cli.js
claude plugin validate .
```

Local end-to-end against a dev API: `LOOKUPD_API_URL=http://localhost:3000 npx lookupd find "linear"`,
and in Claude Code `/plugin marketplace add /path/to/this/repo`.

## License

MIT. See `LICENSE`.
