// Rendering a PDF into a scrolling column of canvases, with PDF.js.
//
// The browser's own viewer was tried first and had to go. It is sealed: its
// document is cross-origin to this page, so its scroll position can be neither
// read nor set, and two panes could never be kept together. Every project that
// does this successfully reaches the same conclusion — to control the scrolling
// you have to own the renderer.
//
// PDF.js is still a second opinion, which was the point of using a browser's
// viewer in the first place: it is Mozilla's renderer, the one Firefox ships,
// and it shares no code with the Ghostscript that produced the file. What it is
// not is *this* user's viewer, which is the honest cost of the swap.
//
// Loaded on demand — 1.6 MB that someone who never opens a preview never pays
// for.

let lib = null;

async function pdfjs() {
  if (!lib) {
    lib = await import("./vendor/pdf.min.mjs");
    // The worker keeps parsing and rasterising off the main thread, which is the
    // difference between a page that scrolls and one that locks up mid-render.
    lib.GlobalWorkerOptions.workerSrc =
      new URL("./vendor/pdf.worker.min.mjs", import.meta.url).href;
  }
  return lib;
}

/**
 * One document rendered into `host`, a column of pages.
 *
 * Pages are laid out immediately at their real size but drawn only when they
 * come near the viewport. A brochure can be four hundred pages, and rasterising
 * all of them to compare the first two would be minutes of work nobody asked
 * for. Laying them out up front is what keeps the scrollbar honest while they
 * are still blank.
 */
export async function renderDocument(host, bytes, scale) {
  const { getDocument } = await pdfjs();
  // A copy, because PDF.js takes ownership of the buffer it is handed and the
  // caller still needs these bytes for the download.
  //
  // The loading task is kept, not just its promise: tearing a document down is
  // `task.destroy()`. The resolved document proxy has no destroy of its own, and
  // calling one there throws — which left canvases on screen after the preview
  // had supposedly closed.
  const task = getDocument({ data: bytes.slice() });
  const doc = await task.promise;

  host.replaceChildren();
  const pages = [];

  for (let number = 1; number <= doc.numPages; number++) {
    const page = await doc.getPage(number);
    const holder = document.createElement("div");
    holder.className = "pv-page";
    const canvas = document.createElement("canvas");
    holder.append(canvas);
    host.append(holder);
    pages.push({ page, holder, canvas, drawn: 0 });
  }

  const state = { task, doc, pages, scale, host };
  layout(state);
  watch(state);
  drawVisible(state);
  return state;
}

/** Size every page's box for the current scale, without drawing anything. */
function layout(state) {
  for (const item of state.pages) {
    const viewport = item.page.getViewport({ scale: state.scale });
    item.holder.style.width = `${Math.round(viewport.width)}px`;
    item.holder.style.height = `${Math.round(viewport.height)}px`;
  }
}

/**
 * Draw the pages the pane is currently showing, worked out from geometry.
 *
 * The observer below handles scrolling, but it cannot be relied on to fire again
 * for pages that were *already* on screen when it was re-created — which is
 * exactly the case after a zoom. Left to it, a pane could keep every page at the
 * old scale while the other pane redrew, and the two would silently disagree.
 */
function drawVisible(state) {
  const pane = state.host.parentElement;
  if (!pane) return;
  // A screen of margin either way, matching the observer's rootMargin.
  const from = pane.scrollTop - pane.clientHeight;
  const to = pane.scrollTop + pane.clientHeight * 2;
  for (const item of state.pages) {
    const top = item.holder.offsetTop;
    if (top + item.holder.offsetHeight >= from && top <= to) draw(state, item);
  }
}

/** Draw the pages that are on screen, or nearly. */
function watch(state) {
  state.observer?.disconnect();
  state.observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const item = state.pages.find((p) => p.holder === entry.target);
      if (item) draw(state, item);
    }
    // rootMargin gives a screen of warning either way, so a page is usually
    // drawn before it is scrolled to rather than after.
  }, { root: state.host.parentElement, rootMargin: "100% 0px" });

  for (const item of state.pages) state.observer.observe(item.holder);
}

async function draw(state, item) {
  const scale = state.scale;
  if (item.drawn === scale) return;

  // A redraw asked for while one is already running must not be dropped. It was,
  // and the bug it caused was invisible in one pane and obvious in two: whichever
  // document was still rendering when the zoom was clicked kept its old scale
  // for ever, because the request that would have changed it was thrown away and
  // nothing asked again. Cancel what is running and let it come back for the
  // newer scale on its way out.
  if (item.pending) {
    item.again = true;
    item.task?.cancel();
    return;
  }

  item.pending = true;
  item.again = false;
  try {
    // Rendered at the device's real pixel density and scaled back down in CSS,
    // or the text is soft on every laptop made in the last decade.
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = item.page.getViewport({ scale: scale * ratio });

    // Drawn into a *new* canvas and swapped in when it is finished. Resizing the
    // canvas already on screen clears it, so zooming would blank every visible
    // page and paint it back a moment later — a white flash across both panes at
    // exactly the moment the user is trying to compare them.
    const next = document.createElement("canvas");
    next.width = Math.round(viewport.width);
    next.height = Math.round(viewport.height);
    next.style.width = `${Math.round(viewport.width / ratio)}px`;
    next.style.height = `${Math.round(viewport.height / ratio)}px`;

    item.task = item.page.render({
      canvasContext: next.getContext("2d", { alpha: false }),
      viewport,
    });
    await item.task.promise;

    // Only if the scale has not moved on again while this was drawing.
    if (state.scale === scale) {
      item.canvas.replaceWith(next);
      item.canvas = next;
      item.drawn = scale;
    }
  } catch (err) {
    // A cancelled render is the normal result of zooming while one is in flight.
    if (err?.name !== "RenderingCancelledException") throw err;
  } finally {
    item.pending = false;
    // Something newer was asked for while this was running, or the scale moved
    // under it. Either way this page is not showing what it should be.
    if (item.drawn !== state.scale) draw(state, item);
  }
}

/** Re-scale an already-rendered document in place. */
export function rescale(state, scale) {
  state.scale = scale;
  for (const item of state.pages) item.drawn = 0;
  layout(state);
  watch(state);
  drawVisible(state);
}

export function destroy(state) {
  if (!state) return;
  state.observer?.disconnect();
  for (const item of state.pages) item.task?.cancel();
  state.task.destroy();
  state.host.replaceChildren();
}
