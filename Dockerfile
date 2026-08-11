# Ordered most-stable first, so a code change rebuilds one layer and not the
# apt install: env -> packages -> user -> dependencies -> app.
FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    TZ=Europe/Budapest

# No Ghostscript. It runs in the browser as WebAssembly now
# (app/static/vendor/), so the one large C parser that used to read hostile
# input on this box is simply not installed on it.

# Before the app is copied, not after: this never changes, and behind the COPY
# it would re-run on every code edit.
RUN useradd --system --uid 10001 --no-create-home toolshed

WORKDIR /srv

# Dependencies ahead of the app, so editing a template does not reinstall them.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Last, because it changes most often. Left owned by root: the app only ever
# reads its own code, and a process that cannot overwrite it is one fewer way
# for a Ghostscript escape to become persistence.
COPY app ./app

# Uploads are other people's files, and Ghostscript parses hostile input for a
# living. Nothing here needs root.
USER toolshed

EXPOSE 8080

# --proxy-headers is off on purpose. The one forwarded header this app reads is
# X-Forwarded-Prefix, which it reads itself (app/prefix.py); letting uvicorn
# rewrite root_path from the others reintroduces exactly the ambiguity that
# module exists to avoid.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
