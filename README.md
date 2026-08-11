# toolshed

Small self-hosted utilities behind the gatekeeper edge.

| Route | Name | Does |
| --- | --- | --- |
| `<prefix>/pdf` | ShrinkPDF | Compress PDFs — **in the browser**, nothing uploaded |

FastAPI + Jinja2, server-rendered. No JS build step and no bundler: the static
modules load as-is, so the image is one stage and there is nothing to compile.

**ShrinkPDF does its work on the user's machine.** Ghostscript is compiled to
WebAssembly and runs in a Web Worker; the server only ships the page and the
wasm. There is no upload endpoint — the route is GET-only, and `test/prefix.sh`
asserts that a POST to it is a 405.

## The access contract

| | |
| --- | --- |
| Service name | `toolshed`, on the external `edge` network |
| Listens | `:8080`, plain HTTP — TLS terminates at the gateway |
| Published ports | **none**, ever (see below — this one is load-bearing) |
| Path arrives | already stripped: `/toolshed/pdf` → `/pdf` |
| URLs go out | built from `X-Forwarded-Prefix` |
| HTML ends | `</body>`, so the gateway's badge has somewhere to land |

```sh
docker compose up -d --build
```

> **Prefix:** CLAUDE.md says `/tools/`, the access contract says `/toolshed/`.
> Nothing in this app knows either string — it reads whichever
> `X-Forwarded-Prefix` the gateway sends — so the harness exercises both. The
> gatekeeper block still has to pick one.

### Why "no published ports" is a security requirement

`X-Auth-User` can be trusted only because nginx overwrites it on every proxied
hop. Publish a port and anything on the LAN can set that header itself, arriving
past the gate as whoever it likes. The same reasoning holds up
`BodyLimitMiddleware`, which trusts Content-Length because nginx buffers a
proxied body and computes it. Both guarantees end the moment `:8080` is
reachable directly.

## Prove it

```sh
./test/prefix.sh              # both prefixes + headless browser, in docker
SKIP_BROWSER=1 ./test/prefix.sh   # server side only, much quicker
python3 test/test_next.py     # pure unit test, no container needed
./test/vendor.sh              # re-fetch the vendored Ghostscript-WASM
```

`prefix.sh` builds the real image, puts it behind an nginx that mirrors
gatekeeper's block, and asserts the whole contract — 79 checks — then drives the page in a **real
headless Chromium** for 11 more. That second stage is not optional polish: the
vendored Ghostscript is compiled `ENVIRONMENT=web` and refuses to load anywhere
else, so a browser is the only thing that can prove the tool works at all. It
also checks the privacy claim directly, by asserting that every request the page
made was a GET. The stand-in
gateway answers **418** on `location /`: on the real one that namespace is
tv-webui's catch-all, so a leaked unprefixed request would not 404, it would
quietly land somewhere else. Ending with "2 deliberate 418s in the log" is how
the run says nothing leaked.

Nothing publishes a port and nothing is bind-mounted, so it works against a
remote docker context — which is what `rpi` is.

## The gatekeeper side

A change in the **gatekeeper** repo, not this one. `test/nginx.conf` is the
same block, and is what the harness actually runs:

```nginx
location = /toolshed { return 302 /toolshed/; }

location /toolshed/ {
    # sub_filter reads the body, so it must arrive uncompressed.
    proxy_set_header Accept-Encoding "";
    sub_filter_types text/html;
    sub_filter_once on;
    sub_filter "</body>" "$whoami_tag</body>";

    # A variable host forces per-request DNS re-resolution, which disables
    # nginx's automatic prefix replacement — a trailing slash does NOT strip
    # the prefix here. Strip it explicitly, before proxy_pass.
    set $toolshed toolshed;
    rewrite ^/toolshed/(.*)$ /$1 break;
    proxy_pass http://$toolshed:8080;

    proxy_set_header Host               $host;
    proxy_set_header X-Real-IP          $remote_addr;
    proxy_set_header X-Forwarded-For    $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto  $scheme;
    proxy_set_header X-Forwarded-Prefix /toolshed;  # how this app builds URLs
    proxy_set_header X-Auth-User        "";         # ungated for now

    client_max_body_size 120m;   # >= the app's own 100 MB cap, or nginx
                                 # refuses the upload with its own error page
}
```

Unlike `/tvs/`, this app needs **no** catch-all `location /`. Nothing it emits
is unprefixed, and `test/prefix.sh` is what says so.

## How it hangs together

```
app/
  main.py      the shell: middleware order, static mount, one route per tool
  prefix.py    X-Forwarded-Prefix in, url() out — read before adding any URL
  links.py     safe_next(); pure, no framework, so it unit-tests on its own
  csrf.py      fetch-metadata check + double-submit token
  limits.py    refuse an oversized body before anything reads it
  gate.py      the auth gate, deliberately empty; see below
  registry.py  what the shell needs to know about a tool
  render.py    the only way to render a page, so nothing loses url() or the token
  tools/       __init__.py is the registry; pdf.py is ShrinkPDF
  templates/   base.html is the sidebar + header; one file per tool
  static/      style.css, app.js (shell), pdf.js (tool)
  static/vendor/ ghostscript-wasm-esm, committed; see test/vendor.sh
test/
  prefix.sh        the end-to-end proof
  browser-test.mjs the same, in a real Chromium — the only thing that can
                   prove the client-side half
  test_next.py     safe_next() against every bypass it has to survive
  nginx.conf       gatekeeper's block, reproduced
  vendor.sh        fetches the wasm; run only to change version
```

### The vendored Ghostscript

`app/static/vendor/` holds `ghostscript-wasm-esm@1.0.1` — **15.4 MB**, committed
rather than installed at build time. There is no npm in this image and no build
step to add one to, and a CDN at runtime would mean every person compressing a
PDF tells jsdelivr they are doing it, which defeats the point. `test/vendor.sh`
re-fetches it and records checksums in `VENDOR.txt`.

It is **AGPL-3.0**, like Ghostscript itself. Serving it to a browser is
distribution, so the licence ships beside it and is linked from the tool's page.

Adding a tool is: write `app/tools/<id>.py` exposing a `TOOL`, add a template,
list it in `app/tools/__init__.py`. Sidebar, route and `<h1>` all come from that
one entry, so a tool cannot be reachable but unlisted. The cross-cutting rules
live in middleware rather than in handlers, so a new tool gets the body cap and
the cross-site check without doing anything, and fails its own POST loudly if it
forgets the CSRF field.

### URLs

The gateway strips the prefix, so this app routes on the unprefixed path and
puts the prefix back on everything it emits, via `prefix.url()`. The prefix is
deliberately **not** installed as ASGI `root_path` — whether Starlette strips it
from `scope["path"]` before matching has changed across versions, and getting it
wrong 404s everything only when behind the proxy. Starlette's trailing-slash
redirect is off for the same reason: it builds an absolute URL from the stripped
path, which points at the gateway root. `PrefixMiddleware` normalises the path
instead, so there is no redirect to get wrong.

### Why it runs in the browser

| | server-side (was) | in-browser (now) |
| --- | --- | --- |
| Where files go | uploaded to the Pi | nowhere |
| Ghostscript | native binary in the image | 15.4 MB wasm, cached |
| Pi's job per file | one gs process, capped, queued | serve a static file |
| Hostile PDF parsed by | the box running gatekeeper | the tab that opened it |
| Cost | upload time, 100 MB cap | one-time 15.4 MB download |

Output is the same either way — verified against native gs on the same file, to
within a percent.

The honest costs: it needs JavaScript, a browser new enough for module workers,
and that first 15.4 MB. A very large PDF can also exhaust a phone tab where the
Pi would have coped — but that is the user's own tab, not everyone's gateway.

Files are compressed one at a time. A second worker means a second Ghostscript
instance resident at once, which on a phone is the difference between slow and
killed.

### Multiple files

Each file is compressed separately and gets its own row, so the first result
appears while the rest are still going and one bad file does not take the others
down with it.

### Security the app owns

- **Authorisation** comes from a call to `auth`, never from a header.
  `X-Auth-User` is read for the "signed in as …" line and nothing else.
- **`next=` validation** is `links.safe_next()`. It refuses control characters
  outright rather than stripping them, then normalises the way a browser does
  *before* testing — trimming, folding backslashes — because `//evil.com`,
  `/\evil.com`, `/\t/evil.com` and `" //evil.com"` all get past a
  `startswith("/")` test. `test/test_next.py` covers each.
- **CSRF on every POST**, in two layers. `Sec-Fetch-Site`/`Origin` are checked
  in middleware, before the body is read, so a cross-site 100 MB upload is
  refused rather than parsed; a double-submit cookie token is checked in the
  handler, for clients that send no fetch metadata.
- **Uploads** are refused on Content-Length before anything reads them, streamed
  into a temp dir under `/tmp` (a 512 MB tmpfs), rejected on the first chunk if
  they are not a PDF, and removed in a `finally` — the success path hands the
  directory to the response, which removes it once the last byte is sent. A
  caller's filename is never used as a path; it survives only as a scrubbed
  label in `Content-Disposition`.
- **Ghostscript is not installed on the server at all** any more. The largest
  attack surface this app had — a C parser reading files strangers chose, on the
  box that also runs gatekeeper, Grafana and tv-webui — is now a wasm sandbox in
  the user's own tab. No temp files, no rlimits, no queue, no upload cap.
- **No `mem_limit` in compose.** This host's firmware sets
  `cgroup_disable=memory` on the kernel command line, so docker discards it with
  a warning on every `up`, and a control that is not enforced is worse than none
  because it reads like one. `cpus` and `pids_limit` do apply and are kept.
- **CSRF and the body-size guard are still in middleware** even though nothing
  POSTs today. They are the shell's rules, not the tool's, so the next tool
  inherits them instead of having to remember them.
- **The container runs as uid 10001** with `no-new-privileges`.
- **A batch is bounded by count as well as bytes** (`MAX_FILES`, default 20).
  Twenty-one small PDFs pass the body cap easily; what they cost is twenty-one
  Ghostscript runs held open on one connection.

### The gate

Not implemented yet, on purpose — `app/gate.py` is where it goes and says what
it must do: ask `auth:8080` per request, never cache, and refuse in the shape
the caller expects (302 to `login_url()` for a navigation, a bare 401 for a
background fetch). That split already exists as `gate.is_navigation()` and
ShrinkPDF already uses it for its own errors, so the two cannot drift apart.

## Conventions

- Commit messages are **short** — a subject line, body only when it earns its
  place. **No `Co-Authored-By` trailer.**
- Comments explain **why**, not what. The surrounding repos are written that way,
  and the commit messages stay short precisely because the code carries it.
- `TZ` is `Europe/Budapest`. The deployment is in Hungary — do not infer a
  timezone from the language spoken in the issue tracker.

### The visual language is shared, not owned

The `:root` token block at the top of `app/static/style.css`, the `theme`
localStorage key, and the `.theme-toggle` markup are **tv-webui's, verbatim**.
Three pages on this origin share them — `/tvs`, `/login` and here — so a user who
picks light mode in one sees it everywhere, and drift shows up immediately. Do
not tidy them.

Three fixes learned from the login page apply here too: **labels above fields**,
not placeholders (a placeholder vanishes exactly when someone wants to check what
they typed); a **3px focus ring** rather than a border-colour shift; and **no
entry animation** on anything that re-renders after an error, because it replays
on every attempt and turns a correction into a wait.

### Identity, when the gate is wired

Sessions belong entirely to `auth`: web sign-ins last until the coming Saturday
00:00 Europe/Budapest, WiFi identity is re-derived per request. This app stores
no session of its own and **must not cache the answer**. See `app/gate.py`.
