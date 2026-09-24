// Password gate in front of the static site (Cloudflare Worker).
//
// Every request - index.html, the bundle, every asset - passes through here
// first: wrangler.jsonc sets assets.run_worker_first, without which Cloudflare
// serves matching static files directly and this check would be skipped.
//
// A password-only login page (no username) sets an HttpOnly session cookie.
// The cookie holds HMAC(password, "lma2-session"), so it cannot be forged
// without the password, and changing the password signs everyone out.
//
// The password is the Worker secret SITE_PASSWORD. It is never in the repo.
// Fails closed: with no password configured, nothing is served.

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  SITE_PASSWORD?: string;
}

const COOKIE = "lma2_session";
const LOGIN_PATH = "/__login";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

const enc = new TextEncoder();

async function sessionToken(password: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode("lma2-session")));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compare in constant time: hash both, then XOR every byte. */
async function same(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const p = new Uint8Array(x), q = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < p.length; i++) diff |= p[i] ^ q[i];
  return diff === 0;
}

function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Only same-site paths, so the login form can't be used as an open redirect. */
function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function loginPage(next: string, wrong: boolean): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Living Marine Aquarium 2</title>
<style>
  html, body { height: 100%; margin: 0; }
  body { display: grid; place-items: center; background: linear-gradient(#0a8cff, #03346e); font: 16px system-ui, sans-serif; color: #fff; }
  form { display: grid; gap: 12px; width: min(320px, 100% - 32px); padding: 28px; border-radius: 14px; background: rgba(0, 20, 50, .55); }
  h1 { margin: 0 0 4px; font-size: 18px; font-weight: 600; }
  input, button { font: inherit; padding: 10px 12px; border-radius: 8px; border: 0; }
  button { background: #fff; color: #03346e; font-weight: 600; cursor: pointer; }
  .err { margin: 0; color: #ffd2d2; font-size: 14px; }
</style></head>
<body><form method="post" action="${LOGIN_PATH}">
  <h1>Living Marine Aquarium 2</h1>
  ${wrong ? '<p class="err">Wrong password.</p>' : ""}
  <input type="hidden" name="next" value="${escapeHtml(next)}">
  <input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
  <button type="submit">Enter</button>
</form></body></html>`;
  return new Response(html, {
    status: 401,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.SITE_PASSWORD) {
      return new Response("Not configured.", { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    const url = new URL(request.url);
    const token = await sessionToken(env.SITE_PASSWORD);

    if (url.pathname === LOGIN_PATH && request.method === "POST") {
      const form = await request.formData().catch(() => null);
      const next = safeNext(form?.get("next")?.toString() ?? null);
      if (!(await same(form?.get("password")?.toString() ?? "", env.SITE_PASSWORD))) return loginPage(next, true);
      return new Response(null, {
        status: 303,
        headers: {
          Location: next,
          "Set-Cookie": `${COOKIE}=${token}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
          "Cache-Control": "no-store",
        },
      });
    }

    if (!(await same(cookieValue(request, COOKIE) ?? "", token))) {
      return loginPage(safeNext(url.pathname + url.search), false);
    }

    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    // Private content: browsers may keep it but must revalidate (cheap 304s via
    // the asset ETags); shared caches must not store it at all.
    out.headers.set("Cache-Control", "private, no-cache");
    return out;
  },
};
