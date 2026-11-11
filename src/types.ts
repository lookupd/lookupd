/** Mirrors the server's taxonomy enums (packages/shared in the lookupd API). */
export type Runtime = "claude-code" | "codex" | "claude-desktop" | "cursor" | "vscode" | "generic";
export type LatencyBucket = "lt1s" | "lt5s" | "lt30s" | "gte30s";
export type ErrorClass = "auth" | "timeout" | "schema" | "tool_error" | "other";

/** Structured telemetry only: never task text, prompts or paths. */
export interface OutcomeEvent {
  kind: "outcome" | "install";
  entry: string;
  capability_tag?: string;
  success?: boolean;
  latency_bucket?: LatencyBucket;
  runtime?: Runtime;
  error_class?: ErrorClass;
  /** A random per-conversation id, the server's order of first use, the tool used most, the domain. */
  session?: string;
  step?: number;
  tool?: string;
  domain?: string;
  found_via?: "lookupd" | "installed";
  /** The lookup_id from the find response that found this server. */
  lookup_id?: string;
}

/** One tool call on a server, as the opt-in hook observes it: names and a verdict, never content. */
export interface CallEvent {
  kind: "call";
  entry: string;
  tool: string;
  ok: boolean;
  latency_ms?: number;
  runtime?: Runtime;
  session?: string;
  lookup_id?: string;
}

export interface InstallSnippet {
  runtime: Runtime;
  kind: "command" | "config";
  label: string;
  value: string;
}

export interface FindResult {
  name: string;
  title: string | null;
  description: string;
  kind: string;
  status: string;
  version: string;
  repositoryUrl: string | null;
  websiteUrl: string | null;
  transports: string[];
  install: InstallSnippet[];
  score: number;
  lookupd: {
    indexedAt: string;
    lastSeenAt: string;
    verification: string;
    publisher?: string | null;
  };
}

export interface FindResponse {
  results: FindResult[];
  /** Reserved for labeled placement; empty while placement is not offered. */
  featured?: FindResult[];
  ranking: "provisional" | string;
  note?: string;
  /** The id of this search on lookupd: quote it on report_outcome so the outcome ties to it. */
  lookup_id?: string | null;
}
