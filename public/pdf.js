// ShrinkPDF's page. Compression happens here, on this machine, in a worker —
// see gs-worker.js. Nothing is uploaded, which is why the page is allowed to say
// so.
//
// Files are compressed in parallel across a small pool of workers, capped at
// 70% of the machine's cores — see runPool below for why it is capped rather
// than maximised.
import { notice, humanBytes } from "./app.js";
import { PRESETS, DEFAULT_PRESET, presetById } from "./presets.js";
import { makeZip } from "./zip.js";

const form = document.getElementById("shrink");
const input = document.getElementById("file");
const drop = document.getElementById("drop");
const dropText = document.getElementById("dropText");
const picks = document.getElementById("picks");
const queue = document.getElementById("queue");
const clearPicks = document.getElementById("clearPicks");
const pickTemplate = document.getElementById("pickTemplate");
const go = document.getElementById("go");
const results = document.getElementById("results");
const list = document.getElementById("resultList");
const total = document.getElementById("resultsTotal");
const rowTemplate = document.getElementById("rowTemplate");
const selectAll = document.getElementById("selectAll");
const resultsCount = document.getElementById("resultsCount");
const downloadSelected = document.getElementById("downloadSelected");
const emailSelected = document.getElementById("emailSelected");
const notDownloaded = document.getElementById("notDownloaded");
const choices = document.getElementById("choices");
const maxBytes = Number(form.dataset.maxBytes);
const maxFiles = Number(form.dataset.maxFiles);

let objectUrls = [];
// Every finished file, in row order: { name, bytes, row }. The row keeps the
// checkbox, so this is the only place that has to know what "selected" means.
let finished = [];

/* ---- The worker pool -----------------------------------------------------
   One worker is one core, which on an eight-core machine is twelve percent of
   the CPU while the user waits. The pool runs several files at once instead,
   sized to the machine it is actually running on.

   Two ceilings, and the lower one wins. Cores decide how much work can happen at
   once; **memory decides how much may be resident**, because every worker holds
   its own Ghostscript instance and a PDF, and that is what kills a tab. A phone
   with eight cores and 4 GB is bounded by the second, not the first. */
const CORES = navigator.hardwareConcurrency || 4;
const CPU_SHARE = 0.8;

// What one worker costs while it runs: a Ghostscript instance plus the file in
// and the file out. A ceiling rather than a measurement — an instance grows to
// fit the PDF it was given, and this has to hold for the worst one in a batch.
const WORKER_MB = 512;
// How much of the machine's memory this page may plan around. The rest belongs
// to the browser itself and to everything else the user has open.
const MEMORY_SHARE = 0.4;

function poolSize(fileCount) {
  const byCpu = Math.floor(CORES * CPU_SHARE);

  // deviceMemory is coarse (0.25 / 0.5 / 1 / 2 / 4 / 8) and browsers clamp it at
  // 8 whatever the machine really has, to make it useless for fingerprinting —
  // so a 64 GB workstation and a 16 GB laptop both say 8, and this stays
  // conservative on both. Absent on Firefox and Safari, where assuming a modest
  // laptop is the safe reading.
  const gb = navigator.deviceMemory || 4;
  const byMemory = Math.floor((gb * 1024 * MEMORY_SHARE) / WORKER_MB);

  // Never more workers than there is work: a fourth worker for a third file only
  // pays the startup cost.
  return Math.max(1, Math.min(byCpu, byMemory, fileCount));
}

// The compiled module, fetched and compiled once for the life of the page and
// handed to every worker after that. Workers themselves are per batch: keeping
// four Ghostscript instances resident between uploads would cost far more
// memory than re-spawning costs time.
let compiledModule = null;

async function getModule() {
  if (!compiledModule) {
    const url = new URL("./vendor/gs.wasm", import.meta.url);
    compiledModule = await WebAssembly.compileStreaming(fetch(url));
  }
  return compiledModule;
}

/** One worker, doing one file at a time. */
function spawn(module) {
  const worker = new Worker(new URL("./gs-worker.js", import.meta.url),
                            { type: "module" });
  let pending = null;
  let nextId = 0;

  try {
    worker.postMessage({ type: "module", module });
  } catch {
    // Structured-cloning a WebAssembly.Module is not universal; the worker
    // compiles its own copy when it never arrives.
  }

  worker.addEventListener("message", ({ data }) => {
    if (!pending || data.id !== pending.id) return;
    const { resolve, reject } = pending;
    pending = null;
    data.ok ? resolve({ out: new Uint8Array(data.bytes), images: data.images })
            : reject(new Error(data.error));
  });
  worker.addEventListener("error", (event) => {
    // A worker that dies must fail the job it was holding, or that file waits
    // for a reply that can never come.
    if (pending) pending.reject(new Error(event.message || "The compressor stopped."));
    pending = null;
  });

  return {
    run(bytes, preset) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending = { id, resolve, reject };
        // Transferred, not copied: each file is read fresh from disk, so there
        // is nothing to lose by giving the buffer away.
        worker.postMessage({ id, bytes: bytes.buffer, preset }, [bytes.buffer]);
      });
    },
    stop: () => worker.terminate(),
  };
}

/**
 * Run every file through a pool, calling `onDone` as each finishes.
 *
 * Files are handed out on demand rather than dealt evenly up front: PDFs differ
 * wildly in how long they take, and a worker that drew three quick ones should
 * pick up a fourth rather than idle beside one still grinding.
 */
async function runPool(files, preset, onDone) {
  const module = await getModule();
  const workers = Array.from({ length: poolSize(files.length) },
                             () => spawn(module));
  let next = 0;
  try {
    await Promise.all(workers.map(async (worker) => {
      while (true) {
        const index = next++;
        if (index >= files.length) return;
        const file = files[index];
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (bytes[0] !== 0x25 || bytes[1] !== 0x50) { // "%P"
            throw new Error("That does not look like a PDF.");
          }
          onDone(index, await worker.run(bytes, preset.id), null);
        } catch (err) {
          onDone(index, null, err);
        }
      }
    }));
  } finally {
    for (const worker of workers) worker.stop();
  }
}

/* ---- The target-quality picker --------------------------------------------
   Built from presets.js rather than written into the template, so adding a
   preset is one entry in one file. */
function drawChoices() {
  for (const preset of PRESETS) {
    const label = document.createElement("label");
    label.className = "choice";
    label.innerHTML =
      `<input type="radio" name="quality" value="${preset.id}"` +
      `${preset.id === DEFAULT_PRESET ? " checked" : ""}>` +
      `<span class="choice-body"><span class="choice-name"></span>` +
      `<span class="choice-desc"></span>` +
      `<span class="choice-detail"></span></span>`;
    // textContent, not innerHTML: these strings come from a file today, but a
    // preset is exactly the kind of thing someone pastes into later.
    label.querySelector(".choice-name").textContent = preset.name;
    label.querySelector(".choice-desc").textContent = preset.blurb;
    label.querySelector(".choice-detail").textContent = preset.detail;
    choices.append(label);
  }
}
drawChoices();

function chosenPreset() {
  const picked = choices.querySelector("input[name=quality]:checked");
  return presetById(picked ? picked.value : DEFAULT_PRESET);
}

/* ---- The picked files -----------------------------------------------------
   `picked` is the source of truth, not input.files: a FileList is read-only, so
   removing one file means rebuilding the list and assigning it back. Keeping our
   own array is what makes each chip's × possible at all. */
let picked = [];

function syncInput() {
  // A DataTransfer is the only way to construct a FileList.
  const data = new DataTransfer();
  for (const file of picked) data.items.add(file);
  input.files = data.files;
}

function renderPicks() {
  drop.classList.toggle("has-file", picked.length > 0);
  // The pane only exists once there is something in it; an empty box beside the
  // form is furniture.
  queue.hidden = picked.length === 0;
  dropText.textContent = picked.length
    ? `${picked.length} file${picked.length > 1 ? "s" : ""} — ${humanBytes(
        picked.reduce((sum, f) => sum + f.size, 0))} in total`
    : "Choose files, or drop them here";

  picks.replaceChildren();
  for (const [i, file] of picked.entries()) {
    const chip = pickTemplate.content.firstElementChild.cloneNode(true);
    const name = chip.querySelector(".pick-name");
    name.textContent = file.name;
    name.title = file.name; // the full name when it is ellipsised
    chip.querySelector(".pick-size").textContent = humanBytes(file.size);
    if (file.size > maxBytes) chip.classList.add("too-big");
    chip.querySelector(".pick-drop").addEventListener("click", () => {
      picked.splice(i, 1);
      syncInput();
      renderPicks();
    });
    picks.append(chip);
  }
  go.disabled = picked.length === 0;
}

function addFiles(files) {
  for (const file of files) {
    // Dropping the same file twice is a slip, not a request to compress it
    // twice. Name and size alone collide across folders; lastModified does not.
    const already = picked.some(
      (p) => p.name === file.name && p.size === file.size &&
             p.lastModified === file.lastModified);
    if (!already) picked.push(file);
  }
  syncInput();
  renderPicks();
}

// The picker replaces the selection and a drop adds to it — which is how both
// already behave everywhere else, so neither needs explaining.
input.addEventListener("change", () => { picked = [...input.files]; renderPicks(); });
picked = [...input.files]; // a back/forward navigation can restore a selection
renderPicks();

for (const type of ["dragenter", "dragover"]) {
  drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add("drag"); });
}
for (const type of ["dragleave", "drop"]) {
  drop.addEventListener(type, () => drop.classList.remove("drag"));
}
clearPicks.addEventListener("click", () => {
  picked = [];
  syncInput();
  renderPicks();
});

drop.addEventListener("drop", (e) => {
  e.preventDefault();
  if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});

/* ---- Compress ------------------------------------------------------------- */
form.addEventListener("submit", async (e) => {
  // Always: there is no server endpoint behind this form to fall back to.
  e.preventDefault();
  if (!picked.length) return;

  if (picked.length > maxFiles) {
    notice(`That is more than ${maxFiles} files at once.`, "error");
    return;
  }
  const tooBig = picked.find((f) => f.size > maxBytes);
  if (tooBig) {
    notice(`${tooBig.name} is larger than the ${humanBytes(maxBytes)} limit.`, "error");
    return;
  }

  go.disabled = true;
  compressing = true;
  syncUnloadWarning();
  // Read once, up front: changing the picker halfway through a batch must not
  // give half the files one quality and half another.
  const preset = chosenPreset();
  const files = [...picked];
  reset(files);

  let before = 0, after = 0, failed = 0, finished = 0;
  const progress = () => {
    go.textContent = files.length > 1
      ? `Compressing… ${finished}/${files.length}` : "Compressing…";
  };
  progress();

  await runPool(files, preset, (index, result, err) => {
    finished++;
    const row = list.children[index];
    if (err) {
      failed++;
      failRow(row, err.message);
    } else {
      before += files[index].size;
      after += result.out.length;
      resolveRow(row, files[index], result.out, result.images, preset);
    }
    progress();
  });

  compressing = false;
  go.disabled = false;
  go.textContent = "Compress";
  summarise(files.length - failed, failed, before, after);
});

/* ---- Losing work ----------------------------------------------------------
   Results live in this page and nowhere else — that is the whole design — so
   closing the tab throws them away. The browser will ask first, but only about
   work that is actually at risk.

   The listener is added and removed rather than left in place: a page that
   always asks is a page people learn to click through, and browsers ignore the
   prompt anyway unless the user has interacted with the page. */
let compressing = false;

const unsaved = () => finished.filter((item) => !item.saved).length;

function warnBeforeUnload(event) {
  // preventDefault is the modern spelling; returnValue is what older browsers
  // still read. Neither lets us choose the wording — that text is the browser's.
  event.preventDefault();
  event.returnValue = "";
}

function syncUnloadWarning() {
  const atRisk = compressing || unsaved() > 0;
  window.removeEventListener("beforeunload", warnBeforeUnload);
  if (atRisk) window.addEventListener("beforeunload", warnBeforeUnload);
}

/** Marks results the user has actually taken a copy of. */
function markSaved(items) {
  for (const item of items) item.saved = true;
  syncSelection();
}

/* ---- Selection ------------------------------------------------------------
   Everything that finishes starts ticked: the common case is "all of them", and
   unticking two is less work than ticking eighteen. */
const selected = () => finished.filter((item) => item.row.querySelector(".row-sel").checked);

// Sharing a file needs a File, not a Blob — the name is what the mail client
// attaches it as.
const asFile = (item) =>
  new File([item.bytes], item.name, { type: "application/pdf" });

function syncSelection() {
  const picked = selected();
  const bytes = picked.reduce((sum, item) => sum + item.bytes.length, 0);

  for (const item of finished) {
    item.row.classList.toggle("selected", item.row.querySelector(".row-sel").checked);
  }

  // Indeterminate at "some", so the header never claims more than is true.
  selectAll.checked = picked.length > 0 && picked.length === finished.length;
  selectAll.indeterminate = picked.length > 0 && picked.length < finished.length;
  selectAll.disabled = finished.length === 0;

  resultsCount.textContent = finished.length
    ? `${picked.length} of ${finished.length} selected` +
      (picked.length ? ` · ${humanBytes(bytes)}` : "")
    : "";

  // Only what has not been taken a copy of is worth warning about.
  const left = unsaved();
  notDownloaded.textContent = left ? `${left} not downloaded yet` : "";
  syncUnloadWarning();

  for (const button of [downloadSelected, emailSelected]) {
    button.disabled = picked.length === 0;
    // The count goes in the label so the action names its own scope.
    button.querySelector("span").textContent =
      `${button === emailSelected ? "Email" : "Download"}` +
      (picked.length ? ` ${picked.length}` : "") +
      (button === downloadSelected && picked.length > 1 ? " (zip)" : "");
  }
}

selectAll.addEventListener("change", () => {
  for (const item of finished) {
    item.row.querySelector(".row-sel").checked = selectAll.checked;
  }
  syncSelection();
});

downloadSelected.addEventListener("click", () => {
  const picked = selected();
  if (!picked.length) return;
  // One file is not an archive. Zipping it would make the user unzip something
  // to get back exactly what they already had.
  const blob = picked.length === 1
    ? new Blob([picked[0].bytes], { type: "application/pdf" })
    : makeZip(picked.map(({ name, bytes }) => ({ name, bytes })));

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = picked.length === 1 ? picked[0].name : "compressed-pdfs.zip";
  link.click();
  markSaved(picked);
  // Revoked on the next frame, not immediately: the click has to be dispatched
  // before the URL stops resolving.
  requestAnimationFrame(() => URL.revokeObjectURL(url));
});

emailSelected.addEventListener("click", async () => {
  const picked = selected();
  if (!picked.length) return;
  const files = picked.map(asFile);
  // Re-checked with the real files: canShare can refuse a specific set (too
  // large, wrong type) even when it accepted the capability probe.
  if (!navigator.canShare?.({ files })) {
    notice("This browser will not attach files to an email. Download instead.", "error");
    return;
  }
  try {
    await navigator.share({ files, title: "Compressed PDFs" });
    // Only after it resolves: a share sheet the user closed took no copy.
    markSaved(picked);
  } catch (err) {
    // A user closing the share sheet is not a failure worth a toast.
    if (err?.name !== "AbortError") notice("Could not open the share sheet.", "error");
  }
});

// mailto: cannot carry an attachment — there is no parameter for it, in any
// browser — so there is nothing to fall back to. Where the OS share sheet is
// missing the button is not shown at all, rather than shown and then failing.
// Probed with a real File because Firefox implements canShare but refuses files.
if (navigator.canShare?.({ files: [new File([new Uint8Array(1)], "a.pdf", { type: "application/pdf" })] })) {
  emailSelected.hidden = false;
}

/* ---- The rows ------------------------------------------------------------- */
function reset(files) {
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls = [];
  list.replaceChildren();
  total.textContent = "";
  finished = [];
  for (const file of files) {
    const row = rowTemplate.content.firstElementChild.cloneNode(true);
    row.querySelector(".row-name").textContent = file.name;
    row.querySelector(".row-status").textContent = "Queued…";
    list.append(row);
  }
  results.hidden = false;
  syncSelection();
}

function resolveRow(row, file, out, images, preset) {
  const url = URL.createObjectURL(new Blob([out], { type: "application/pdf" }));
  objectUrls.push(url);

  const name = file.name.replace(/\.pdf$/i, "") + preset.suffix + ".pdf";
  const checkbox = row.querySelector(".row-sel");
  checkbox.disabled = false;
  checkbox.checked = true;
  checkbox.addEventListener("change", syncSelection);
  row.classList.remove("pending");
  finished.push({ name, bytes: out, row, saved: false });

  const link = row.querySelector(".row-get");
  link.href = url;
  // The name says which recipe produced it, so two runs of the same source do
  // not land in the downloads folder as "file (1).pdf".
  link.download = name;
  link.hidden = false;
  link.addEventListener("click", () => {
    const item = finished.find((f) => f.row === row);
    if (item) markSaved([item]);
  });

  row.classList.add("done");

  // Ghostscript can make a file bigger — a PDF that is already one big JPEG
  // gets re-encoded for nothing. Say so instead of showing a negative saving.
  row.querySelector(".row-status").textContent =
    out.length < file.size
      ? `${humanBytes(file.size)} → ${humanBytes(out.length)}  (−${Math.round((1 - out.length / file.size) * 100)}%)`
      : `${humanBytes(file.size)} → ${humanBytes(out.length)}  (no smaller)`;

  // What was actually done to the file. The image count is real — it comes from
  // Ghostscript's own object dump. How many of those were *downsampled* is not
  // reported by Ghostscript and is not claimed here.
  const detail = row.querySelector(".row-detail");
  detail.textContent =
    `${describeImages(images)} · ${preset.name} · text and vectors intact ✓`;
}

/** "12 images · 9 resized, 3 left as they were" — or less, when there is less
    to say. The reason an image was left alone is deliberately not claimed: it
    depends on the image's placement on the page, which is not read here. */
function describeImages({ total, resized, kept }) {
  if (!total) return "No images";
  const plural = total > 1 ? "s" : "";
  if (!resized) return `${total} image${plural} · none needed resizing`;
  if (!kept) return `${total} image${plural} · all resized`;
  return `${total} images · ${resized} resized, ${kept} left as they were`;
}

function failRow(row, message) {
  row.classList.add("failed");
  row.classList.remove("pending");
  row.querySelector(".row-status").textContent = message;
}

function summarise(ok, failed, before, after) {
  syncSelection();
  if (!ok) {
    total.textContent = "";
    notice(failed === 1 ? "That file could not be compressed."
                        : `All ${failed} files failed.`, "error");
    return;
  }
  // Written into the bar, not raised as a toast. Two reasons, and the first one
  // is a bug this replaced: the toast is fixed to the bottom centre, which is
  // where the Compress button sits on a normal window, so for its whole life it
  // swallowed clicks meant for the button underneath it. The second is that a
  // batch's saving is a fact about the results, not an event — it should still
  // be readable a minute later. Toasts are kept for failures.
  const saved = before ? Math.round((1 - after / before) * 100) : 0;
  total.textContent = saved > 0
    ? `${saved}% smaller overall · ${humanBytes(before)} → ${humanBytes(after)}`
    : "";
  if (failed) notice(`${failed} of ${failed + ok} files failed.`, "error");
}
