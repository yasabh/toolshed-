// The templating, such as it is.
//
// Forty lines instead of a dependency. The pages here are a shell plus one
// fragment per tool, and the only things that vary are the gateway prefix, the
// nav, a heading and a CSRF token — a template *language* would be more machinery
// than the problem has.
//
// Templates are read once at startup: they ship inside the image and cannot
// change under a running process, so re-reading them per request would buy
// nothing but syscalls.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { currentUser } from "./gate.js";
import { prefixOf, url } from "./prefix.js";
import { TOOLS } from "./registry.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "templates");

// Comments in a template explain the markup to whoever edits it next, which is
// nobody's business in a browser — Jinja stripped them, and shipping them to
// every visitor on every page load would be a quiet regression from that. Done
// once at startup, so it costs nothing per request.
const stripComments = (html) => html.replace(/<!--[\s\S]*?-->/g, "").replace(/\n{3,}/g, "\n\n");
const read = (name) => stripComments(readFileSync(join(DIR, name), "utf8"));

const BASE = read("base.html");
const FRAGMENTS = new Map([
  ["pdf.html", read("pdf.html")],
  ["404.html", read("404.html")],
]);

// Everything substituted into a page goes through this unless it is markup we
// generated ourselves. A tool name is author-controlled today, but a template
// that escapes by default is one that cannot be made unsafe by a later edit.
export const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const fill = (template, values) =>
  template.replace(/\{\{(\w+)\}\}/g, (whole, key) =>
    Object.hasOwn(values, key) ? values[key] : whole);

/** The sidebar, built from the registry so a tool cannot be routable but unlisted. */
function navHtml(req, current) {
  // Grouped in the order the registry lists them: a heading appears the first
  // time a group is seen, so adding a tool to an existing group never means
  // touching this.
  const groups = new Map();
  for (const tool of TOOLS) {
    const key = tool.group || "Tools";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tool);
  }

  return [...groups].map(([label, tools]) => {
    const items = tools.map((tool) => {
      const on = current && tool.id === current.id;
      // aria-current, not just a class: collapsed there is no label to read, and
      // the marked item is the only thing saying where you are.
      return `<a class="nav-item${on ? " on" : ""}" href="${escapeHtml(url(req, tool.path))}"` +
        ` title="${escapeHtml(tool.nav)}"${on ? ' aria-current="page"' : ""}>` +
        `<span class="nav-icon" aria-hidden="true">` +
        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
        `stroke-linecap="round" stroke-linejoin="round">${tool.icon}</svg></span>` +
        `<span class="nav-label">${escapeHtml(tool.nav)}</span></a>`;
    }).join("");

    // The rule is what the heading becomes once the labels are gone: collapsed,
    // a group still has to read as a group.
    return `<div class="nav-group">` +
      `<span class="nav-group-label">${escapeHtml(label)}</span>` +
      `<span class="nav-group-rule" aria-hidden="true"></span>` +
      items + `</div>`;
  }).join("");
}

/**
 * The foot of the sidebar: who is signed in, when anyone is.
 *
 * Nothing at all when the header is empty. X-Auth-User arrives blank until the
 * gate is wired, and a permanent "Not signed in" is a row that never changes,
 * answers a question nobody asked, and takes up the space the real thing will
 * need. It appears when there is something to say.
 *
 * Display only: gatekeeper overwrites this header on every proxied hop so a
 * client cannot forge it, but the authorisation decision is the auth call and
 * never this.
 */
function accountHtml(user) {
  if (!user) return "";
  const initials = user
    .split(/[\s._-]+/).filter(Boolean).slice(0, 2)
    .map((part) => part[0]).join("").toUpperCase();
  return `<div class="account">` +
    `<span class="avatar" aria-hidden="true">${escapeHtml(initials)}</span>` +
    `<span class="account-who">` +
      `<span class="account-name">${escapeHtml(user)}</span>` +
      `<span class="account-sub">Signed in</span>` +
    `</span></div>`;
}

/**
 * Render a page. `tool` is null for the shell's own pages (404).
 *
 * The one way to render, so no page can forget the prefix helper or the token.
 */
export function render(req, fragment, { tool = null, heading = "Toolshed", values = {} } = {}) {
  const user = currentUser(req);
  const title = tool ? tool.name : heading;

  const content = fill(FRAGMENTS.get(fragment), {
    prefix: escapeHtml(prefixOf(req)),
    ...values,
  });

  return fill(BASE, {
    title: escapeHtml(title),
    heading: escapeHtml(title),
    prefix: escapeHtml(prefixOf(req)),
    nav: navHtml(req, tool),
    account: accountHtml(user),
    content,
  });
}
