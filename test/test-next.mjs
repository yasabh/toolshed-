// Where a caller is sent after sign-in. `next` is attacker-controlled.
//
// Plain asserts, no test framework — this has to be runnable anywhere, including
// inside the image, where the only thing installed is node itself.
//
//   node test/test-next.mjs
import { DEFAULT_NEXT, safeNext } from "../lib/links.js";

const HOSTILE = [
  "//evil.com",            // protocol-relative: the browser reads a host
  "///evil.com",
  "/\\evil.com",           // backslashes are normalised to slashes first
  "/\\/evil.com",
  "/\t/evil.com",          // tabs are deleted first, leaving "//evil.com"
  "/\n/evil.com",          // …and so are newlines
  "/\r/evil.com",
  " //evil.com",           // leading whitespace is trimmed, exposing the "//"
  "\t//evil.com",
  "/\0/evil.com",
  "https://evil.com",
  "evil.com",
  "",
  "javascript:alert(1)",
  "/legit\r\nSet-Cookie: x=1",   // header injection through a redirect
];

const LOCAL = [
  "/toolshed/pdf",
  "/tools/pdf",
  "/toolshed/pdf?quality=print",
  "/toolshed/static/app.js",
  // A space mid-path is not an escape: the browser percent-encodes it rather
  // than deleting it, so this stays a local path and the guard must not cost
  // someone the page they were heading to.
  "/toolshed/a b",
];

let failures = 0;
for (const next of HOSTILE) {
  const got = safeNext(next);
  if (got !== DEFAULT_NEXT) {
    console.log(`  FAIL ${JSON.stringify(next)} -> ${JSON.stringify(got)}`);
    failures++;
  } else {
    console.log(`  ok   ${JSON.stringify(next)} refused`);
  }
}
for (const next of LOCAL) {
  const got = safeNext(next);
  if (got !== next) {
    console.log(`  FAIL ${JSON.stringify(next)} -> ${JSON.stringify(got)}, should have been kept`);
    failures++;
  } else {
    console.log(`  ok   ${JSON.stringify(next)} kept`);
  }
}

console.log(`\n${HOSTILE.length + LOCAL.length - failures} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
