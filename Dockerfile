# Pure Node, no dependencies, alpine — same shape as tvremotehub's webapp.
# Alpine is safe here precisely because there are no dependencies: nothing native
# to compile, so musl never comes into it.
#
# Ordered most-stable first, so that editing a template rebuilds as little as
# possible: metadata -> vendored wasm -> server code.
FROM node:22-alpine

LABEL org.opencontainers.image.title="toolshed" \
      org.opencontainers.image.description="Small self-hosted utilities behind the gatekeeper edge" \
      org.opencontainers.image.source="https://github.com/yasabh/toolshed-" \
      org.opencontainers.image.licenses="AGPL-3.0"

ENV NODE_ENV=production \
    TZ=Europe/Budapest

WORKDIR /srv

# The vendored Ghostscript-WASM is 16 MB and changes only when test/vendor.sh is
# re-run. On its own layer, ahead of everything that changes often, so a one-line
# template edit rewrites kilobytes instead of sixteen megabytes.
COPY public/vendor/ ./public/vendor/

# The app, listed rather than copied as one directory — a bare `COPY . .` here
# would pull the 16 MB above into this layer as well and undo the split. A new
# directory needs a line of its own; test/prefix.sh fails loudly if one is
# missed, because it fetches every URL the page emits.
COPY package.json server.js ./
COPY lib/ ./lib/
COPY templates/ ./templates/
COPY public/*.js public/*.css ./public/

# `node` ships with the image and owns nothing here: everything above stays
# root-owned, so the process can read its own code but never overwrite it.
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
