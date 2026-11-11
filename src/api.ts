import type { CallEvent, FindResponse, OutcomeEvent, Runtime } from "./types.js";

export const DEFAULT_BASE_URL = "https://api.lookupd.com";

export class LookupdApiError extends Error {
  readonly status: number;
  readonly body: string;
  readonly retryAfterSeconds: number | undefined;
  constructor(status: number, body: string, retryAfterSeconds?: number) {
    super(`lookupd API responded ${status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    this.name = "LookupdApiError";
    this.status = status;
    this.body = body;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface FindQuery {
  task: string;
  kind?: string;
  runtime?: Runtime;
  verifiedOnly?: boolean;
  limit?: number;
}

export interface LookupdApiOptions {
  /** Defaults to $LOOKUPD_API_URL, then https://api.lookupd.com. */
  baseUrl?: string;
  apiKey?: string;
  userAgent: string;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** Per-request deadline; the hook uses a short one so it never holds up a tool call. Default 15 s. */
  timeoutMs?: number;
}

/** Thin typed client for the lookupd REST API. */
export class LookupdApi {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: LookupdApiOptions) {
    const env = opts.env ?? process.env;
    this.baseUrl = (opts.baseUrl ?? env.LOOKUPD_API_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.userAgent = opts.userAgent;
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  find(q: FindQuery): Promise<FindResponse> {
    const params = new URLSearchParams({ task: q.task });
    if (q.kind) params.set("kind", q.kind);
    if (q.runtime) params.set("runtime", q.runtime);
    if (q.verifiedOnly) params.set("verified_only", "true");
    if (q.limit !== undefined) params.set("limit", String(q.limit));
    return this.request<FindResponse>("GET", `/v0.1/find?${params}`);
  }

  entry(name: string): Promise<unknown> {
    return this.request("GET", `/v0.1/entries/${encodeURIComponent(name)}`);
  }

  health(name: string): Promise<unknown> {
    return this.request("GET", `/v0.1/entries/${encodeURIComponent(name)}/health`);
  }

  events(
    batch: Array<OutcomeEvent | CallEvent>,
  ): Promise<{ accepted: number; ignored: number; principal: string }> {
    return this.request("POST", "/v0.1/events", { events: batch });
  }

  /** The registry name behind a server already in an MCP config: by its remote url or its package. */
  resolve(q: {
    url?: string;
    package?: string;
  }): Promise<{ name: string | null; matches: string[] }> {
    const params = new URLSearchParams();
    if (q.url) params.set("url", q.url);
    if (q.package) params.set("package", q.package);
    return this.request("GET", `/v0.1/resolve?${params}`);
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": this.userAgent,
    };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const retry = Number(res.headers.get("retry-after"));
      throw new LookupdApiError(
        res.status,
        await res.text().catch(() => ""),
        Number.isFinite(retry) && retry > 0 ? retry : undefined,
      );
    }
    return (await res.json()) as T;
  }
}
