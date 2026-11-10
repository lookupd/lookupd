import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const json = (rel: string) =>
  JSON.parse(readFileSync(join(root, rel), "utf8")) as Record<string, unknown>;
const pkg = json("package.json") as { version: string };

test("plugin.json names the plugin and carries the listing metadata", () => {
  const plugin = json(".claude-plugin/plugin.json") as Record<string, unknown> & {
    author?: { name?: string };
  };
  expect(plugin.name).toBe("lookupd");
  expect(plugin.version).toBe(pkg.version);
  expect(typeof plugin.description).toBe("string");
  expect(plugin.author?.name).toBe("lookupd");
  expect(plugin.license).toBe("MIT");
  expect(plugin.homepage).toBe("https://lookupd.com");
  expect(plugin.repository).toBe("https://github.com/lookupd/lookupd");
  // Reserved-name rules: must not read as one of Anthropic's own.
  expect(String(plugin.name)).not.toMatch(/claude|anthropic/i);
});

test("marketplace.json lists this repository root as the single plugin", () => {
  const market = json(".claude-plugin/marketplace.json") as {
    name: string;
    owner: { name: string };
    description?: string;
    plugins: Array<{ name: string; source: string; description?: string; version?: string }>;
  };
  expect(market.name).toBe("lookupd");
  expect(market.owner.name).toBe("lookupd");
  expect(typeof market.description).toBe("string");
  expect(market.plugins).toHaveLength(1);
  expect(market.plugins[0]?.name).toBe("lookupd");
  expect(market.plugins[0]?.source).toBe("./");
  // plugin.json owns the version; a differing entry version would only produce a validator warning.
  expect(market.plugins[0]?.version).toBeUndefined();
});

test(".mcp.json launches the stdio bridge through npx", () => {
  const mcp = json(".mcp.json") as {
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  const server = mcp.mcpServers.lookupd;
  expect(server?.command).toBe("npx");
  expect(server?.args).toEqual(["-y", "lookupd@latest", "mcp"]);
});

test("the find-capability skill has valid frontmatter and teaches the full loop", () => {
  const skill = readFileSync(join(root, "skills", "find-capability", "SKILL.md"), "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(skill);
  expect(match).not.toBeNull();
  const frontmatter = match?.[1] ?? "";
  const body = match?.[2] ?? "";
  expect(frontmatter).toMatch(/^name: find-capability$/m);
  const description = /^description: (.+)$/m.exec(frontmatter)?.[1] ?? "";
  expect(description.length).toBeGreaterThan(40);
  expect(description.length).toBeLessThanOrEqual(1024);
  expect(body).toMatch(/find_capability/);
  expect(body).toMatch(/report_outcome/);
  expect(body).toMatch(/approv/i); // never install without the user's approval
  expect(body).toMatch(/Provisional/);
  expect(body).toMatch(/lookupd telemetry off/); // the agent is told how the user opts out, never to opt in
  expect(body).toMatch(/never change that setting yourself/);
  expect(body.split("\n").length).toBeLessThanOrEqual(150);
});

test("README documents install for Claude Code, skills.sh, VS Code and Cursor", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  for (const needle of [
    "/plugin marketplace add lookupd/lookupd",
    "npx skills add lookupd/lookupd",
    "npx lookupd mcp",
    "On by default",
    "lookupd telemetry off",
    "DO_NOT_TRACK=1",
    "api.lookupd.com",
  ]) {
    expect(readme).toContain(needle);
  }
});
