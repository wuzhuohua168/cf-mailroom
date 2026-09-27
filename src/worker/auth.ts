import { getCookie } from "hono/cookie";
import type { Context } from "hono";

/**
 * Simple password gate for free-tier instances that cannot use
 * Cloudflare Access (Zero Trust Free requires billing info).
 *
 * Two ways in:
 * - Browser: POST /login with the password sets an HttpOnly cookie.
 * - Automation (cron): HTTP Basic Auth header, password as the password
 *   (username is ignored).
 *
 * The gate is only active when the UI_PASSWORD secret is set. When unset,
 * the worker stays open so a fresh deploy never locks you out.
 */
export const AUTH_COOKIE = "mailroom_auth";

async function sha256hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function isAuthenticated(
  c: Context<{ Bindings: Env }>,
  password: string,
): Promise<boolean> {
  const header = c.req.header("Authorization");
  if (header?.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice("Basic ".length).trim());
      const sep = decoded.indexOf(":");
      const candidate = sep >= 0 ? decoded.slice(sep + 1) : decoded;
      if (candidate === password) return true;
    } catch {
      // malformed Authorization header — fall through to cookie check
    }
  }
  const cookie = getCookie(c, AUTH_COOKIE);
  if (cookie) {
    const expected = await sha256hex(`mailroom:${password}`);
    if (cookie === expected) return true;
  }
  return false;
}

export async function makeAuthCookieValue(password: string): Promise<string> {
  return sha256hex(`mailroom:${password}`);
}

export function loginPageHTML(error?: string): string {
  const err = error
    ? `<p class="err">${escapeHtml(error)}</p>`
    : `<p class="hint">输入密码以查看你的邮件。</p>`;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Mailroom 登录</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #0f1117; color: #e5e7eb; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  .card { width: min(92vw, 360px); background: #171a23; border: 1px solid #262b38; border-radius: 14px; padding: 28px 24px; }
  h1 { margin: 0 0 6px; font-size: 20px; }
  .hint { color: #9ca3af; font-size: 14px; margin: 0 0 18px; }
  .err { color: #f87171; font-size: 14px; margin: 0 0 18px; }
  input { width: 100%; padding: 12px; border-radius: 8px; border: 1px solid #374151; background: #0f1117;
          color: #e5e7eb; font-size: 16px; margin-bottom: 14px; }
  button { width: 100%; padding: 12px; border: 0; border-radius: 8px; background: #6366f1; color: #fff;
           font-size: 16px; cursor: pointer; }
  button:active { background: #4f46e5; }
</style>
</head>
<body>
  <form class="card" method="post" action="/login">
    <h1>📬 Mailroom</h1>
    ${err}
    <input type="password" name="password" placeholder="密码" autocomplete="current-password" autofocus />
    <button type="submit">进入</button>
  </form>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    (
      {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      } as Record<string, string>
    )[ch],
  );
}
