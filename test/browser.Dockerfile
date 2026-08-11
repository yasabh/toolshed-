# A real browser, because the vendored Ghostscript build is compiled
# ENVIRONMENT=web and refuses to run anywhere else. Node cannot verify it, so
# nothing short of an actual browser proves the page works — and this is the one
# part of the app there is no other way to check.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /w
# Installed here rather than globally: ESM resolution ignores NODE_PATH, so a
# global install is invisible to `import`.
# puppeteer-core, not puppeteer: the distro's chromium is already above, and the
# full package would download a second copy of it.
RUN echo '{"type":"module"}' > package.json \
 && npm install --no-fund --no-audit puppeteer-core@23

ENV CHROME=/usr/bin/chromium
COPY browser-test.mjs .
CMD ["node", "browser-test.mjs"]
