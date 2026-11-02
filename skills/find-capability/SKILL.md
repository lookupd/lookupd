---

name: find-capability
description: Use when the task needs a tool, data source or integration the agent does not have (e.g. "read Linear issues", "extract text from a PDF", "query Postgres"). Finds MCP servers via lookupd, proposes an install for the user's runtime, and reports the outcome afterwards. Also use after finishing a task that used an MCP server, when lookupd's report_outcome tool is available, to report whether it worked.
---

# find-capability

lookupd is a neutral registry that agents query mid-task. Lookups are free. Rankings are
**Provisional** until real outcome evidence exists, so treat results as candidates, not verdicts.

## When to use

- The user's task needs a capability you lack: a SaaS API (Linear, Notion, Slack), a data
  source (Postgres, a vector store), a file format (PDF, OCR), a browser, a cloud provider.
- You are about to say "I can't access X": check whether an MCP server for X exists first.

- A task just used an MCP server and `report_outcome` is in your tool list: go to Step 4.
  This is the usual case, because most clients (Claude Code included) only load a new server
  after a restart, so the server gets used in a later conversation than the one that found it.

Do **not** use it to find things you can already do with installed tools, or for general web
search. Do not call it more than three times for one need; rephrase once, then ask the user.

## Step 1: name the capability, not the request

Turn the need into a short capability phrase, 2–6 words: `read Linear issues`,
`PDF text extraction`, `send Slack messages`. Never pass the user's full prompt, file paths,
repository names, customer names or secrets. The phrase is recorded as demand data.

## Step 2: look it up

Call `find_capability` with:

```json
{ "task": "read Linear issues", "runtime": "claude-code", "max_results": 3 }
```

`runtime` is one of `claude-code`, `claude-desktop`, `cursor`, `vscode`, `generic`; it
selects the install snippet format. Each result has `name`, `description`, `transports`,
`install[]` (paste-ready), `status`, and `lookupd.verification` (`unverified` means nobody
has proven they own the listing).

If the lookupd tools are missing but you have a shell, use the CLI instead:
`npx -y lookupd@latest find "<phrase>" --runtime <runtime> --json` (same results). If you
have neither, tell the user how to add the tools and stop:
`/plugin marketplace add lookupd/lookupd` then `/plugin install lookupd@lookupd`, or
`claude mcp add lookupd -- npx -y lookupd@latest mcp`.

If `results` is empty, say so plainly. Try one rephrase (broader noun, no brand name). If
`note` says no searchable terms, use plain words. Never invent an entry.

## Step 3: propose, and wait for approval

Show at most three candidates. For each: `name`, one line of description, the transports,
the label **Provisional · unverified** (or the verification shown), and the exact install
snippet. Recommend one and say why in one sentence (remote beats local install when both
exist; prefer entries whose `status` is `active`).

Then ask the user to approve the install. **Never run an install command, edit MCP config,
or add a server without explicit approval.** Installing runs third-party code.

After approval, run or apply the snippet, confirm the server's tools appear, and continue
the original task. If the server fails to connect, try the next candidate once, then report.
If the client needs a restart before the new tools appear (Claude Code does), say so; the
outcome is reported in the conversation that uses the server (Step 4).

## Step 4: report the outcome

After a task that used an MCP server finishes (success or not), call `report_outcome` once
per server, once per conversation. This covers servers found in this conversation and servers
that were already installed.

`entry` is the registry name. For a server found in this conversation it is the result's
`name`. For an installed server, look up its launch details in the MCP config (in Claude Code:
`claude mcp get <server>`, or `.mcp.json`), then call `get_entry` with `url` (remote servers)
or `package` (the npm/PyPI package after `npx -y` or `uvx`). Use the returned `entry.name`; if
`get_entry` finds nothing, skip the report. Never guess a name.

```json
{
  "entry": "io.github.acme/linear-mcp",
  "success": true,
  "latency_bucket": "lt5s",
  "runtime": "claude-code",
  "capability_tag": "issue-tracking"
}
```

| field            | values                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| `entry`          | the registry name (above)                                                                                             |
| `success`        | required: `true` if the server did what was needed, `false` if not                                                    |
| `latency_bucket` | `lt1s`, `lt5s`, `lt30s`, `gte30s` (time for the server's calls)                                                       |
| `runtime`        | your runtime, as above                                                                                                |
| `capability_tag` | one tag from lookupd's taxonomy, e.g. `issue-tracking`, `pdf-extract`, `database-sql`, `web-search`, `email`, `other` |
| `error_class`    | on failure: `auth`, `timeout`, `schema`, `tool_error`, `other`                                                        |

Only these fields exist. Never include task text, prompts, paths or output. If
`report_outcome` is not in your tool list, telemetry is off for this user: skip the report.
The first time this happens in a conversation you may add one sentence that
`lookupd telemetry on` enables anonymous outcome reports; never repeat it.

## Rules

- A `429` means wait the given seconds; lookups are rate limited per IP.
- `verified_only: true` currently returns nothing: registration has not opened.
- lookupd mirrors the Official MCP Registry (CC0) and is not affiliated with it. Credit it
  if the user asks where the data comes from.
