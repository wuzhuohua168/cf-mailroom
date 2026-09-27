interface OutboundEmailBinding {
  send(message: {
    from: string | { email: string; name?: string };
    to: string | Array<string | { email: string; name?: string }>;
    subject: string;
    text?: string;
    html?: string;
    attachments?: Array<{
      content: string | ArrayBuffer | ArrayBufferView;
      filename: string;
      type: string;
      disposition: "attachment" | "inline";
      contentId?: string;
    }>;
    headers?: Record<string, string>;
  }): Promise<{ messageId: string }>;
}

interface Env {
  WEB_ACCESS_TEAM_DOMAIN?: string;
  WEB_ACCESS_AUD?: string;
  DB: D1Database;
  // Optional: without the RAW binding the worker skips retaining original
  // MIME and attachments (free-tier instances without R2).
  RAW?: R2Bucket;
  EMAIL: OutboundEmailBinding;
  AI: Ai;
  DRAFT_QUEUE: Queue<{ runId: number }>;
  // Workers Static Assets binding (implicit when `assets` is configured).
  ASSETS: Fetcher;
  // Password gate secret (free-tier replacement for Cloudflare Access).
  // When unset, the worker stays open so a fresh deploy never locks you out.
  UI_PASSWORD?: string;
  OAUTH_KV: KVNamespace;
  MCP_SEND_ENABLED?: string;
  MCP_DAILY_SEND_LIMIT?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_JWK?: string;
  VAPID_SUBJECT?: string;
}
