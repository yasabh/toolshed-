// CSRF, in two layers, because each covers what the other cannot.
//
// 1. **Fetch metadata**, checked before the body is read. Sec-Fetch-Site and
//    Origin say where a request was triggered from, and a browser will not let a
//    page lie about either. Applied centrally in server.js, so a new tool cannot
//    forget it.
//
// 2. **A double-submit token**, in the form. The check above is only as good as
//    the headers a browser sends; a client that sends neither would sail through
//    it. The token is minted here, set as a cookie, and echoed in a hidden field
//    — an attacker's page can cause the POST but cannot read the cookie to fill
//    the field in.
//
// This app stores no session state of its own (auth owns sessions), which is
// exactly what double-submit is for: the cookie *is* the server side.
import { randomBytes, timingSafeEqual } from "node:crypto";

// __Host- is enforced by the browser: same host only, Secure, Path=/, no Domain.
// A cookie records nothing about who set it, so without the prefix a sibling
// subdomain could plant one we would read as our own. Path is / and not
// /toolshed — the prefix requires it, and it is the gateway's namespace anyway.
export const COOKIE = "__Host-toolshed-csrf";
export const FIELD = "csrf";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0) out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return out;
}

/**
 * The caller's token: the one they already have, or a new one.
 *
 * Reused rather than rotated per render — a form left open in a second tab must
 * not be invalidated by a reload in the first.
 */
export function tokenFor(req) {
  const existing = cookies(req)[COOKIE];
  if (existing) return { token: existing, minted: false };
  return { token: randomBytes(24).toString("base64url"), minted: true };
}

/** The Set-Cookie for a freshly minted token, or null when it already had one. */
export function cookieHeader(token, minted) {
  if (!minted) return null;
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

/** Compare a submitted field against the cookie, in constant time. */
export function check(req, submitted) {
  const cookie = cookies(req)[COOKIE];
  if (!cookie || typeof submitted !== "string" || !submitted) return false;
  const a = Buffer.from(cookie);
  const b = Buffer.from(submitted);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** What a browser on this site would send as Origin. */
function ownOrigin(req) {
  // Built from the *forwarded* scheme and the Host the gateway passed through,
  // because the hop from nginx to here is plain HTTP — reading the socket's own
  // scheme would make every real request look cross-origin.
  const scheme = req.headers["x-forwarded-proto"] || "http";
  return `${scheme}://${req.headers.host || ""}`;
}

/**
 * Layer 1. True when an unsafe request looks cross-site and must be refused
 * before its body is read.
 */
export function isCrossSite(req) {
  if (SAFE_METHODS.has(req.method)) return false;

  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") return true;

  const origin = req.headers.origin;
  if (origin !== undefined && origin !== ownOrigin(req)) return true;

  return false;
}
