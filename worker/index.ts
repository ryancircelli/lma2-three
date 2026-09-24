// Password gate in front of the static site (Cloudflare Worker).
//
// Every request - index.html, the bundle, every asset - passes through here
// first: wrangler.jsonc sets assets.run_worker_first, without which Cloudflare
// serves matching static files directly and this check would be skipped.
//
// The password is the Worker secret SITE_PASSWORD. It is never in the repo.
// Fails closed: with no password configured, nothing is served.

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  SITE_PASSWORD?: string;
}

const REALM = "Living Marine Aquarium 2";

function unauthorized(): Response {
  return new Response("Password required.", {
    status: 401,
    headers: {
      "WWW-Authenticate": `Basic realm="${REALM}", charset="UTF-8"`,
      "Cache-Control": "no-store",
    },
  });
}

/** Compare in constant time: hash both, then XOR every byte. */
async function samePassword(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const p = new Uint8Array(x), q = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < p.length; i++) diff |= p[i] ^ q[i];
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.SITE_PASSWORD) {
      return new Response("Not configured.", { status: 503, headers: { "Cache-Control": "no-store" } });
    }

    const header = request.headers.get("Authorization") ?? "";
    const basic = header.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
    if (!basic) return unauthorized();

    let credentials: string;
    try {
      credentials = atob(basic[1]);
    } catch {
      return unauthorized();
    }
    // Any username; only the password matters.
    const password = credentials.slice(credentials.indexOf(":") + 1);
    if (!(await samePassword(password, env.SITE_PASSWORD))) return unauthorized();

    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    // Private content: browsers may keep it but must revalidate (cheap 304s via
    // the asset ETags); shared caches must not store it at all.
    out.headers.set("Cache-Control", "private, no-cache");
    return out;
  },
};
