// Static file server for the repo root: index.html, dist/, assets/.
//
//   deno task serve [--port 8000]

import { parseArgs } from "jsr:@std/cli@1/parse-args";
import { fromFileUrl } from "jsr:@std/path@1";
import { serveDir } from "jsr:@std/http@1/file-server";

const args = parseArgs(Deno.args, { string: ["port"], default: { port: "8000" } });
const root = fromFileUrl(new URL("..", import.meta.url));

Deno.serve({ port: Number(args.port), hostname: "127.0.0.1" }, (req) =>
  serveDir(req, {
    fsRoot: root,
    quiet: true,
    // Never cache during development - stale bundles cause confusing results.
    headers: ["Cache-Control: no-store"],
  }));
