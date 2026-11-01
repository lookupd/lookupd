import type { FindResponse } from "./types.js";

/** Human-readable listing for `lookupd find`. */
export function formatResults(res: FindResponse): string {
  const lines: string[] = [];
  const label =
    res.ranking === "provisional"
      ? "Provisional ranking (no outcome evidence yet)"
      : `Ranking: ${res.ranking}`;
  lines.push(
    `${label} · ${res.results.length} result${res.results.length === 1 ? "" : "s"} · data: Official MCP Registry (CC0) via lookupd`,
  );
  if (res.note) lines.push(`note: ${res.note}`);
  res.results.forEach((r, i) => {
    lines.push("");
    lines.push(
      `${i + 1}. ${r.name}${r.title ? ` — ${r.title}` : ""}  [${r.lookupd?.verification ?? "unverified"}]`,
    );
    if (r.description) lines.push(`   ${r.description}`);
    if (r.transports?.length) lines.push(`   transports: ${r.transports.join(", ")}`);
    for (const snippet of r.install ?? []) {
      lines.push(`   install (${snippet.label}):`);
      for (const l of snippet.value.split("\n")) lines.push(`     ${l}`);
    }
  });
  return `${lines.join("\n")}\n`;
}
