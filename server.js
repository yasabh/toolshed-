// toolshed — a shell that hosts N small tools behind the gatekeeper edge.
//
// Pure Node, no dependencies, same as tvremotehub: the image stays small and
// there is no supply chain to audit for a service that renders three templates.
//
// It listens on :8080 over plain HTTP and publishes no port. The gateway reaches
// it over the `edge` network and strips the prefix on the way in, so this app
// routes on `/pdf` and emits `/toolshed/pdf` — see lib/prefix.js, which is the
// one hard rule in this repo.
//
// The order below is the order a request meets things, and it matters:
//   prefix        parsed first, because the gate's `next=` is built from it
//   cross-site    refused before a body is read
//   body size     refused before a body is read
//   gate          who the caller is (not implemented yet)
//   routes
import { createServer } from "node:http";

import { isCrossSite, tokenFor, cookieHeader, FIELD } from "./lib/csrf.js";
import { checkBody } from "./lib/limits.js";
import { guard, isNavigation } from "./lib/gate.js";
import { routePath, url } from "./lib/prefix.js";
import { render } from "./lib/render.js";
import { byPath, TOOLS } from "./lib/registry.js";
import { serveStatic } from "./lib/static.js";

const PORT = Number(process.env.PORT || 8080);

// Every page carries a CSRF token and, once the gate is wired, an identity —
// none of that may be stored by a browser or an intermediary. Same set as
// auth's, so the two ends of a sign-in behave alike. Static assets get their own
// caching (lib/static.js); everything else is a page.
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

const send = (res, status, headers, body) => {
  res.writeHead(status, headers);
  res.end(body);
};

function sendPage(res, status, html, extra = {}) {
  send(res, status, {
    ...SECURITY_HEADERS,
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    ...extra,
  }, html);
}

/** Refuse in the shape the caller expects — the same split the gate uses. */
function refuse(req, res, status, message) {
  if (isNavigation(req)) {
    return sendPage(res, status, `<!doctype html><meta charset=utf-8><p>${message}`);
  }
  send(res, status, {
    ...SECURITY_HEADERS,
    "content-type": "application/json",
    "cache-control": "no-store",
  }, JSON.stringify({ error: message }));
}

const server = createServer(async (req, res) => {
  try {
    const path = routePath(req.url);

    // Liveness only; exposes nothing, and must not need the gate.
    if (path === "/healthz") {
      return send(res, 200, { "content-type": "application/json", "cache-control": "no-store" },
                  '{"ok":true}');
    }

    // Both of these run before the body is touched, so a cross-site or oversized
    // request costs nothing to refuse.
    if (isCrossSite(req)) {
      return refuse(req, res, 403, "Cross-site request refused.");
    }
    const tooBig = checkBody(req);
    if (tooBig) return refuse(req, res, tooBig.status, tooBig.message);

    // Who is asking. false means the gate already answered the client.
    if (!(await guard(req, res))) return;

    if (await serveStatic(req, res, path, SECURITY_HEADERS)) return;

    // No landing page: with one tool it would be a page whose only content is a
    // link to the page you actually wanted. When a second tool arrives this is
    // the line to replace.
    //
    // 302, not 307: this is "the shell lives over there", not a method-preserving
    // replay of the request.
    if (path === "/") {
      return send(res, 302, { ...SECURITY_HEADERS, location: url(req, TOOLS[0].path),
                              "cache-control": "no-store" }, "");
    }

    const tool = byPath(path);
    if (tool) {
      // GET-only, on purpose: the claim on ShrinkPDF's page is that nothing is
      // uploaded, and the absence of any other method is the server side of it.
      if (req.method !== "GET" && req.method !== "HEAD") {
        return refuse(req, res, 405, "That address only answers GET.");
      }
      const { token, minted } = tokenFor(req);
      const cookie = cookieHeader(token, minted);
      const html = render(req, tool.fragment, {
        tool,
        values: { ...tool.values, [FIELD]: token, csrf_token: token },
      });
      return sendPage(res, 200, html, cookie ? { "set-cookie": cookie } : {});
    }

    sendPage(res, 404, render(req, "404.html", { heading: "Not found" }));
  } catch (err) {
    // Never the stack: it names paths inside the image. The log is ours, the
    // response is theirs.
    console.error("request failed:", err);
    sendPage(res, 500, "<!doctype html><meta charset=utf-8><p>Something went wrong.");
  }
});

server.listen(PORT, "0.0.0.0", () =>
  console.log(`toolshed on http://0.0.0.0:${PORT}`));
