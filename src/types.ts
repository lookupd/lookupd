/** Mirrors the server's taxonomy enums (packages/shared in the lookupd API). */
export type Runtime = "claude-code" | "claude-desktop" | "cursor" | "vscode" | "generic";
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
  lookupd: { indexedAt: string; lastSeenAt: string; verification: string };
}

export interface FindResponse {
  results: FindResult[];
  ranking: "provisional" | string;
  note?: string;
}
