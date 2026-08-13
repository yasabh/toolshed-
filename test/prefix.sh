#!/usr/bin/env bash
# Prove the app meets the access contract — that it serves correctly under a
# stripped prefix, and that the things the app is responsible for hold.
#
# Runs the real image behind an nginx that mirrors gatekeeper's block, including
# the catch-all on / that stands in for tv-webui's. The interesting assertion is
# not "the pages load": it is that every URL the app emits carries the prefix,
# so nothing ever arrives at the gateway root in the first place.
#
# Everything runs on a throwaway docker network and nothing publishes a port —
# the same shape as the deployment, and it means the script works against a
# remote docker context (which is what `rpi` is).
#
#   ./test/prefix.sh                 # both prefixes
#   ./test/prefix.sh /tools          # prove it is not hardcoded
#   SKIP_BROWSER=1 ./test/prefix.sh  # skip the headless-browser stage
set -euo pipefail

cd "$(dirname "$0")/.."

NET=toolshed-prefix-test
APP=toolshed-prefix-app
PROXY=toolshed-prefix-proxy
CLIENT=toolshed-prefix-client
WORK=$(mktemp -d)

# /toolshed is the one gatekeeper serves. The app never sees the string — it
# reads whatever X-Forwarded-Prefix says — and `./test/prefix.sh /tools` still
# passes, which is how that stays true rather than merely intended.
PREFIXES=("${@:-/toolshed}")
read -r -a PREFIXES <<< "${PREFIXES[*]}"

pass=0; fail=0
ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail+1)); }
check(){ [ "$2" = "$3" ] && ok "$1 ($3)" || bad "$1 — expected $3, got $2"; }
head2(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

cleanup() {
  docker rm -f "$APP" "$PROXY" "$CLIENT" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# safeNext is pure string logic, so it is checked before anything is built —
# a failure there is a security bug and there is no point proving the rest.
head2 "=== safeNext ==="
printf 'FROM node:22-alpine\nWORKDIR /srv\nCOPY . .\nCMD ["node","test/test-next.mjs"]\n' > "$WORK/unit.Dockerfile"
if tar cf - lib/links.js test/test-next.mjs -C "$WORK" unit.Dockerfile |
     docker build -q -t toolshed-unit:test -f unit.Dockerfile - >/dev/null &&
   docker run --rm toolshed-unit:test >/dev/null; then
  ok "test-next.mjs"
else
  bad "test-next.mjs — run it directly to see which case"
fi

echo "building…"
docker build -q -t toolshed:prefix-test . >/dev/null
docker build -q -t toolshed-proxy:prefix-test -f test/proxy.Dockerfile test >/dev/null

docker network create "$NET" >/dev/null
docker run -d --name "$APP"   --network "$NET" --network-alias toolshed \
  toolshed:prefix-test >/dev/null
docker run -d --name "$PROXY" --network "$NET" \
  toolshed-proxy:prefix-test >/dev/null
# The browser stand-in, inside the network. curl runs here, not on this machine.
docker run -d --name "$CLIENT" --network "$NET" --entrypoint sleep \
  curlimages/curl:latest infinity >/dev/null

# The cookie the app sets its CSRF token in; replayed by hand, see below.
COOKIE=__Host-toolshed-csrf
BASE="http://$PROXY"
c()    { docker exec "$CLIENT" curl -s "$@"; }
code() { docker exec "$CLIENT" curl -s -o /dev/null -w '%{http_code}' "$@"; }
sh_c() { docker exec "$CLIENT" sh -c "$1"; }

for _ in $(seq 40); do
  [ "$(code "$BASE/toolshed/pdf" || true)" = 200 ] && break
  sleep 0.5
done


head2 "the trap works (an unprefixed request is visibly wrong, not a silent 404)"
check "GET /pdf hits the catch-all"        "$(code "$BASE/pdf")"               418
check "GET /static/style.css hits it too"  "$(code "$BASE/static/style.css")"  418

# ---------------------------------------------------------------------------
# Everything below runs once per prefix. The app is told which one it is under
# by a header only — nothing in the image knows the string.
# ---------------------------------------------------------------------------
for P in "${PREFIXES[@]}"; do

head2 "=== under $P/ ==="

echo "routing"
check "GET $P          -> redirect"        "$(code "$BASE$P")"                302
check "GET $P/         -> redirect"        "$(code "$BASE$P/")"               302
check "GET $P/pdf"                         "$(code "$BASE$P/pdf")"            200
check "GET $P/pdf/ (trailing slash)"       "$(code "$BASE$P/pdf/")"           200
check "GET $P/nope     -> 404"             "$(code "$BASE$P/nope")"           404

# The redirect off the shell root must aim back inside the prefix, not at the
# gateway's root. This is the failure that would be invisible without the trap.
loc=$(c -i "$BASE$P/" | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}')
check "…and its Location is prefixed"      "$loc"                       "$P/pdf"

echo "every URL the page emits carries the prefix"
c "$BASE$P/pdf" > "$WORK/page.html"
urls=$(grep -oE '(href|src|action)="[^"]+"' "$WORK/page.html" | cut -d'"' -f2 |
       grep -v '^/_whoami' | sort -u)
[ -n "$urls" ] && ok "found URLs to check" || bad "no URLs in the page"
for u in $urls; do
  case "$u" in
    "$P"/*) ok "emitted $u" ;;
    /*)     bad "emitted $u — absolute, would land at the gateway root" ;;
    *)      ok "emitted $u (relative)" ;;
  esac
done
for u in $urls; do
  case "$u" in "$P"/*) check "  GET $u" "$(code "$BASE$u")" 200 ;; esac
done
# app.js is reached only through pdf.js's relative import, so no href/src names
# it — resolve it the way the browser would and check it lands inside.
check "GET $P/static/app.js (module import)" "$(code "$BASE$P/static/app.js")" 200

echo "the gateway can inject its badge"
# The contract's "HTML must close with </body>": the badge is substituted there,
# so a page that ends any other way silently loses it.
grep -q '</body>' "$WORK/page.html" \
  && ok "the page closes with </body>" || bad "no </body> to substitute into"
c "$BASE$P/pdf" | grep -q '_whoami.js' \
  && ok "sub_filter injected the badge at </body>" || bad "badge was not injected"

echo "the pane says where you are without the sidebar being read"
grep -q '<h1 class="page-title">ShrinkPDF</h1>' "$WORK/page.html" \
  && ok "<h1> is the tool's name" || bad "<h1> is not the tool's name"
h1s=$(grep -c '<h1' "$WORK/page.html")
check "  …and there is only one"           "$h1s"                             1
grep -q 'aria-current="page"' "$WORK/page.html" \
  && ok "the current tool is marked in the nav" || bad "nav does not mark it"
grep -q 'ShrinkPDF' "$WORK/page.html" \
  && ok "the nav label says what it does" || bad "nav label is just the name"
grep -q 'localStorage.getItem("theme")' "$WORK/page.html" \
  && ok "theme is applied before first paint" || bad "no pre-paint theme script"

echo "the browser gets what it needs to compress locally"
check "  GET $P/static/gs-worker.js"       "$(code "$BASE$P/static/gs-worker.js")" 200
check "  GET $P/static/vendor/gs.mjs"      "$(code "$BASE$P/static/vendor/gs.mjs")" 200
check "  GET $P/static/vendor/gs.wasm"     "$(code "$BASE$P/static/vendor/gs.wasm")" 200
check "  GET $P/static/vendor/pdf.min.mjs"  "$(code "$BASE$P/static/vendor/pdf.min.mjs")" 200
check "  GET $P/static/vendor/pdf.worker.min.mjs" \
      "$(code "$BASE$P/static/vendor/pdf.worker.min.mjs")" 200

# Both licences are served to browsers along with the code they cover, so both
# have to be reachable *and readable*. Without an explicit type they fall to
# application/octet-stream, and the one link whose job is to show a licence
# downloads it instead. Checked for each, because the first fix matched
# "LICENSE" exactly and silently missed LICENSE-pdfjs.
for lic in LICENSE LICENSE-pdfjs; do
  check "  GET $P/static/vendor/$lic"      "$(code "$BASE$P/static/vendor/$lic")" 200
  sh_c "curl -s -D /tmp/lic.txt -o /dev/null '$BASE$P/static/vendor/$lic'"
  sh_c 'grep -qi "^content-type: text/plain" /tmp/lic.txt' \
    && ok "  …$lic is served as text, not a download" \
    || bad "  $lic type: $(sh_c "grep -i content-type /tmp/lic.txt")"
done

done
# ---------------------------------------------------------------------------
# Prefix-independent. Run once.
# ---------------------------------------------------------------------------
P=/toolshed

head2 "=== the app's own security responsibilities ==="

echo "there is no upload endpoint to find"
# --data-binary '' sends an explicit Content-Length: 0. Without it these get 411
# from BodyLimitMiddleware, which refuses any body-bearing method that does not
# declare its size — correct, but it fires before routing and would mask what
# this section is actually checking.
# The page claims nothing is uploaded. This is the server side of that claim:
# the route is GET-only, so there is nowhere to upload to even deliberately.
check "POST $P/pdf" \
  "$(code -X POST --data-binary '' -H 'Sec-Fetch-Site: same-origin' "$BASE$P/pdf")" 405
check "PUT  $P/pdf" \
  "$(code -X PUT  --data-binary '' -H 'Sec-Fetch-Site: same-origin' "$BASE$P/pdf")" 405
# …and a body-bearing request that will not say how big it is never gets that far.
check "POST with no Content-Length" \
  "$(code -X POST -H 'Sec-Fetch-Site: same-origin' "$BASE$P/pdf")"            411

echo "a cross-site unsafe request still dies before its body is read"
check "Sec-Fetch-Site: cross-site" \
  "$(code -X POST --data-binary '' -H 'Sec-Fetch-Site: cross-site' "$BASE$P/pdf")" 403
check "a foreign Origin" \
  "$(code -X POST --data-binary '' -H 'Origin: https://evil.example' "$BASE$P/pdf")" 403

echo "the wasm is served in a form the browser can stream-compile and cache"
sh_c "curl -s -D /tmp/w.txt -o /dev/null '$BASE$P/static/vendor/gs.wasm'"
sh_c 'grep -qi "^content-type: application/wasm" /tmp/w.txt' \
  && ok "content-type is application/wasm" \
  || bad "wrong content-type: $(sh_c "grep -i content-type /tmp/w.txt")"
# no-store here would mean re-downloading 15.4 MB on every single page load.
sh_c 'grep -qi "^cache-control: public, max-age=" /tmp/w.txt' \
  && ok "cacheable, not no-store" \
  || bad "not cacheable: $(sh_c "grep -i cache-control /tmp/w.txt")"
sh_c 'grep -qi "^etag:" /tmp/w.txt' && ok "has an ETag to revalidate against" \
  || bad "no ETag"
size=$(sh_c "grep -i '^content-length' /tmp/w.txt" | tr -dc '0-9')
check "  and it is the whole 15.4 MB"      "$size"                     16177271

echo "our own scripts stay revalidated so an edit shows up at once"
sh_c "curl -s -D /tmp/a.txt -o /dev/null '$BASE$P/static/pdf.js'"
sh_c 'grep -qi "^cache-control: no-cache" /tmp/a.txt' \
  && ok "app JS is no-cache" || bad "app JS caching wrong"

echo "responses are not storable"
sh_c "curl -s -D /tmp/h.txt -o /dev/null '$BASE$P/pdf'"
sh_c 'grep -qi "^cache-control: no-store" /tmp/h.txt' \
  && ok "the page itself is no-store" || bad "the page is cacheable"
for h in "cache-control: no-store" "x-content-type-options: nosniff" \
         "referrer-policy: no-referrer" "x-frame-options: DENY"; do
  sh_c "grep -qi '^${h%%:*}:' /tmp/h.txt" && ok "$h" || bad "missing $h"
done


echo "the container runs as nobody in particular"
# The exact uid is the base image's business (node:alpine ships `node` as 1000).
# What matters, and all that is asserted, is that it is not root.
uid=$(docker exec "$APP" id -u | tr -d '\r')
[ "$uid" != "0" ] && ok "runs as uid $uid, not root" || bad "running as root"

echo "nothing reached the gateway root during any of the above"
leaks=$(docker logs "$PROXY" 2>&1 | grep -c ' 418 ' || true)
check "418s in the proxy log (2 deliberate)" "$leaks"                         2

# The client-side half. Everything above proves the app *serves* the right
# things; only a real browser can prove Ghostscript actually runs in one, and the
# vendored build refuses to load anywhere else.
if [ "${SKIP_BROWSER:-}" != "1" ]; then
  head2 "=== in a real browser ==="
  docker build -q -t toolshed-browser:test -f test/browser.Dockerfile test >/dev/null
  if docker run --rm --network "$NET" toolshed-browser:test \
       node browser-test.mjs "http://$PROXY/toolshed"; then
    ok "browser-test.mjs"
  else
    bad "browser-test.mjs — see its output above"
  fi
fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
