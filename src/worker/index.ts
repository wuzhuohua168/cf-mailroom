import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { withMcp } from "../mcp/index.ts";
import { api } from "./api";
import { processDraftRun } from "./agent/draft";
import { receiveEmail } from "./email/receive";
import {
  AUTH_COOKIE,
  isAuthenticated,
  loginPageHTML,
  makeAuthCookieValue,
} from "./auth";

const app = new Hono<{ Bindings: Env }>();

// Password gate — free-tier replacement for Cloudflare Access
// (Zero Trust Free requires billing info, which we don't have).
// This replaces upstream's requireWebAccess, which returns 503 when
// WEB_ACCESS_* is unconfigured. Active only when the UI_PASSWORD secret
// is set; when unset the worker stays open so a fresh deploy never
// locks anyone out.
app.use(async (c, next) => {
  const password = c.env.UI_PASSWORD;
  if (!password) return next();
  const path = c.req.path;
  // Login/logout endpoints and Cloudflare-internal paths stay public.
  if (path === "/login" || path === "/logout" || path.startsWith("/cdn-cgi/")) {
    return next();
  }
  if (await isAuthenticated(c, password)) return next();
  if (path.startsWith("/api/")) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return c.html(loginPageHTML());
});

app.post("/login", async (c) => {
  const password = c.env.UI_PASSWORD;
  let candidate = "";
  try {
    const body = await c.req.parseBody();
    candidate = String(body["password"] ?? "");
  } catch {
    // ignore malformed bodies
  }
  if (password && candidate === password) {
    setCookie(c, AUTH_COOKIE, await makeAuthCookieValue(password), {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return c.redirect("/");
  }
  return c.html(loginPageHTML("密码不正确，请重试。"), 401);
});

app.all("/logout", async (c) => {
  deleteCookie(c, AUTH_COOKIE, { path: "/" });
  return c.redirect("/login");
});

app.route("/api", api);

// Fall through to Workers Static Assets (the SPA) after the auth check.
app.all("*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default {
  fetch: withMcp(app),
  email: receiveEmail,
  async queue(batch: MessageBatch<{ runId: number }>, env: Env): Promise<void> {
    await Promise.all(
      batch.messages.map(async (message) => {
        try {
          await processDraftRun(env, message.body.runId);
          message.ack();
        } catch {
          message.retry({ delaySeconds: Math.min(300, 15 * 2 ** message.attempts) });
        }
      }),
    );
  },
} satisfies ExportedHandler<Env, { runId: number }>;
