# Ordered most-stable first, so that editing a template rebuilds as little as
# possible: metadata -> user -> dependencies -> vendored wasm -> app code.
FROM python:3.13-slim

LABEL org.opencontainers.image.title="toolshed" \
      org.opencontainers.image.description="Small self-hosted utilities behind the gatekeeper edge" \
      org.opencontainers.image.source="https://github.com/yasabh/toolshed-" \
      org.opencontainers.image.licenses="AGPL-3.0"

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    TZ=Europe/Budapest

# No Ghostscript, and no apt layer at all. It runs in the browser as WebAssembly
# now (app/static/vendor/), so the one large C parser that used to read files
# strangers chose is not installed on this box.

# Before the app is copied, not after: this never changes, and behind a COPY it
# would re-run on every code edit.
RUN useradd --system --uid 10001 --no-create-home toolshed

WORKDIR /srv

# Dependencies ahead of the app, so editing a template does not reinstall them.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# The vendored Ghostscript-WASM is 16 MB and changes only when test/vendor.sh is
# re-run. On its own layer, ahead of the code, so a one-line template edit
# rewrites half a megabyte instead of sixteen.
COPY app/static/vendor/ ./app/static/vendor/

# The app itself, listed rather than copied as one directory — a bare
# `COPY app ./app` here would pull the 16 MB above into this layer as well and
# undo the split. A new subdirectory needs a line of its own; test/prefix.sh
# fails loudly if one is missed, because it fetches every URL the page emits.
COPY app/*.py ./app/
COPY app/tools/ ./app/tools/
COPY app/templates/ ./app/templates/
COPY app/static/*.js app/static/*.css ./app/static/

# Everything above is owned by root and stays that way: this process only ever
# reads its own code, and one that cannot overwrite it is one fewer way for a
# bug to become something permanent.
USER toolshed

EXPOSE 8080

# --proxy-headers is off on purpose. The one forwarded header this app reads is
# X-Forwarded-Prefix, which it reads itself (app/prefix.py); letting uvicorn
# rewrite root_path from the others reintroduces exactly the ambiguity that
# module exists to avoid.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
