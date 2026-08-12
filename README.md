# toolshed

Small self-hosted utilities behind the gatekeeper edge.

| Route | Name | Does |
| --- | --- | --- |
| `<prefix>/pdf` | ShrinkPDF | Compress PDFs — **in the browser**, nothing uploaded |

**Pure Node, no dependencies** — the same shape as tvremotehub's webapp, so the
two services read alike and there is no supply chain to audit for something that
renders three templates. `node:22-alpine`, no build step, no bundler.

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

> **Prefix:** `/toolshed/`. Nothing in this app knows that string — it reads
> whichever `X-Forwarded-Prefix` the gateway sends, and `./test/prefix.sh /tools`
> still passes, which is how that stays true rather than merely intended.

### Why "no published ports" is a security requirement

`X-Auth-User` can be trusted only because nginx overwrites it on every proxied
hop. Publish a port and anything on the LAN can set that header itself, arriving
past the gate as whoever it likes. The same reasoning holds up `lib/limits.js`,
which trusts Content-Length because nginx buffers a proxied body and computes
it. Both guarantees end the moment `:8080` is
reachable directly.

## Prove it

```sh
./test/prefix.sh              # both prefixes + headless browser, in docker
SKIP_BROWSER=1 ./test/prefix.sh   # server side only, much quicker
node test/test-next.mjs       # pure unit test, needs only node
./test/vendor.sh              # re-fetch the vendored Ghostscript-WASM
```

`prefix.sh` runs the `safeNext` unit test, builds the real image, puts it behind
an nginx that mirrors gatekeeper's block, and asserts the whole contract — 51
checks — then drives the page in a **real headless Chromium** for 20 more. That second stage is not optional polish: the
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

    # Nothing is uploaded any more, so this only has to be large enough that
    # nginx never becomes the reason a request is refused.
}
```

Unlike `/tvs/`, this app needs **no** catch-all `location /`. Nothing it emits
is unprefixed, and `test/prefix.sh` is what says so.

## How it hangs together

```
server.js      the router, in the order a request meets things
lib/
  prefix.js    X-Forwarded-Prefix in, url() out — read before adding any URL
  links.js     safeNext(); pure, no imports, so it unit-tests on its own
  csrf.js      fetch-metadata check + double-submit token
  limits.js    refuse an oversized body before anything reads it
  static.js    public/ with ETag, 304 and Range; caching decided per path
  gate.js      the auth gate, deliberately empty; see below
  registry.js  the tool list the sidebar and routes are built from
  render.js    the only way to render a page, so nothing loses the prefix
  tools/pdf.js ShrinkPDF — a description of a page, and nothing else
templates/     base.html is the sidebar + header; one fragment per tool
public/
  style.css      the shell
  app.js         theme toggle, sidebar, notices
  pdf.js         ShrinkPDF's page: the worker pool and the UI
  presets.js     the target-quality presets — labels, filename suffixes and gs
                 flags in one place, imported by the page and the worker so
                 they cannot drift
  pdf-images.js  finds image XObjects by reading the PDF bytes
  gs-worker.js   Ghostscript, off the main thread
  vendor/        ghostscript-wasm-esm, committed; see test/vendor.sh
test/
  prefix.sh        the end-to-end proof
  browser-test.mjs the same, in a real Chromium — the only thing that can
                   prove the client-side half
  test-next.mjs    safeNext() against every bypass it has to survive
  nginx.conf       gatekeeper's block, reproduced
  vendor.sh        fetches the wasm; run only to change version
```

### Two things Ghostscript will not tell you

Both were measured here, not taken from documentation, and both are easy to get
wrong silently:

**`-dJPEGQ` does nothing.** pdfwrite ignores it — `-dJPEGQ=10` and `-dJPEGQ=95`
produce byte-identical output. JPEG quality is set through distiller parameters
as a **QFactor**, where lower is better: 0.1 maximum, 0.4 high, 0.76 medium,
1.3 low. Any recipe that sets `-dJPEGQ` is not doing what it says.

**`-dColorImageResolution` is not a cutoff.** `DownsampleThreshold` defaults to
1.5, so "200 dpi" silently means "anything above 300 dpi becomes 200" and a 250
dpi scan sails through untouched. Email sets it to 1.0 so the number means what
the label says; Print deliberately leaves the default, because resampling a 350
dpi photo to 300 costs real quality and saves very little.

### Counting images without asking Ghostscript

`public/pdf-images.js` reads image dictionaries straight out of the PDF, before
and after, so the result row can say *"12 images · 9 resized, 3 left as they
were"*. It works because of one rule: an object with a stream may not live inside
an object stream, and every image XObject has one — so image dictionaries are
always top-level and in plain text, even in an otherwise compressed PDF 1.6.

The obvious alternative, `-dPDFDEBUG`, does contain the same information but
costs a JS callback per line of a dump of every object in the file. On a
thousand-image brochure that is more expensive than the compression itself.

The *reason* an image was left alone is deliberately not claimed. That depends on
its effective dpi, which is pixel size divided by how large it is drawn — and the
second half of that lives in the page's content stream as a transformation
matrix. Reading it means interpreting the drawing program, which is a different
project.

### The vendored Ghostscript

`app/static/vendor/` holds `ghostscript-wasm-esm@1.0.1` — **15.4 MB**, committed
rather than installed at build time. There is no npm in this image and no build
step to add one to, and a CDN at runtime would mean every person compressing a
PDF tells jsdelivr they are doing it, which defeats the point. `test/vendor.sh`
re-fetches it and records checksums in `VENDOR.txt`.

It is **AGPL-3.0**, like Ghostscript itself. Serving it to a browser is
distribution, so the licence ships beside it and is linked from the tool's page.

Adding a tool is: write `lib/tools/<id>.js` exporting a `TOOL`, add a template
fragment, list it in `lib/registry.js`. Sidebar, route and `<h1>` all come from
that one entry, so a tool cannot be reachable but unlisted. The cross-cutting
rules live in `server.js` ahead of the routes, so a new tool gets the body cap
and the cross-site check without doing anything.

### Why no Express

Express would earn its place for one thing here — `express.static`, which is
battle-tested where `lib/static.js` is hand-written. The rest it would not:
there are six routes, no request bodies at all, and a template engine would
still have to be chosen separately. Against that, it is ~30 transitive packages
in a service that serves nine files from behind a gate. `lib/static.js` covers
what actually matters for these assets — correct MIME (`application/wasm` or the
browser cannot stream-compile), ETag/304, and Range so an interrupted 15.4 MB
download resumes rather than restarting.

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

Files run in parallel across a small worker pool, sized at **70% of
`navigator.hardwareConcurrency`** (and at most 2 where `deviceMemory` reports
4 GB or less). One worker is one core, so a single one leaves an eight-core
machine idling at 12% while the user waits.

Capped rather than maximised, for two reasons: every worker holds its own
Ghostscript instance, so memory bounds the pool as much as cores do; and a
background tab that takes the whole CPU is a machine that feels broken. Work is
handed out on demand rather than dealt evenly up front — PDFs differ wildly in
how long they take, and a worker that drew three quick ones should pick up a
fourth rather than idle beside one still grinding.

The 15.4 MB module is compiled **once** on the main thread and the resulting
`WebAssembly.Module` is posted to every worker. Compiling it per worker is the
obvious way to make a pool slower than no pool. Workers are terminated after each
batch; the compiled module is kept.

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
  `startswith("/")` test. `test/test-next.mjs` covers each.
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
