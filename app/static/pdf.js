// ShrinkPDF's page. Compression happens here, on this machine, in a worker —
// see gs-worker.js. Nothing is uploaded, which is why the page is allowed to say
// so.
//
// Files are compressed one at a time. A second worker would mean a second 15.4
// MB Ghostscript instance resident at once, and on a phone that is the
// difference between slow and killed.
import { notice, humanBytes } from "./app.js";
import { PRESETS, DEFAULT_PRESET, presetById } from "./presets.js";

const form = document.getElementById("shrink");
const input = document.getElementById("file");
const drop = document.getElementById("drop");
const dropText = document.getElementById("dropText");
const picks = document.getElementById("picks");
const pickTemplate = document.getElementById("pickTemplate");
const go = document.getElementById("go");
const results = document.getElementById("results");
const list = document.getElementById("resultList");
const total = document.getElementById("resultsTotal");
const rowTemplate = document.getElementById("rowTemplate");
const choices = document.getElementById("choices");
const maxBytes = Number(form.dataset.maxBytes);
const maxFiles = Number(form.dataset.maxFiles);

let objectUrls = [];

/* ---- The worker -----------------------------------------------------------
   Started on the first compress, not on page load: it pulls 15.4 MB, and
   someone who opened the page to read it should not pay for that. */
let worker = null;
let nextId = 0;
const pending = new Map();

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./gs-worker.js", import.meta.url), { type: "module" });
  worker.addEventListener("message", ({ data }) => {
    const waiting = pending.get(data.id);
    if (!waiting) return;
    pending.delete(data.id);
    data.ok ? waiting.resolve({ out: new Uint8Array(data.bytes), images: data.images })
            : waiting.reject(new Error(data.error));
  });
  worker.addEventListener("error", (event) => {
    // A worker that failed to start fails every request queued behind it —
    // otherwise they hang for ever waiting for a reply that cannot come.
    const err = new Error(event.message || "Could not start the compressor.");
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
    worker.terminate();
    worker = null;
  });
  return worker;
}

function compress(bytes, preset) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // The buffer is transferred, so `bytes` is emptied here. Each file is read
    // fresh from disk, so there is nothing to lose by giving it away.
    ensureWorker().postMessage({ id, bytes: bytes.buffer, preset }, [bytes.buffer]);
  });
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
  // Read once, up front: changing the picker halfway through a batch must not
  // give half the files one quality and half another.
  const preset = chosenPreset();
  const files = [...picked];
  reset(files);

  let before = 0, after = 0, failed = 0;

  for (const [i, file] of files.entries()) {
    const row = list.children[i];
    row.querySelector(".row-status").textContent = "Compressing…";
    go.textContent = files.length > 1
      ? `Compressing ${i + 1} of ${files.length}…` : "Compressing…";
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes[0] !== 0x25 || bytes[1] !== 0x50) { // "%P"
        throw new Error("That does not look like a PDF.");
      }
      const { out, images } = await compress(bytes, preset.id);
      before += file.size;
      after += out.length;
      resolveRow(row, file, out, images, preset);
    } catch (err) {
      failed++;
      failRow(row, err.message);
    }
  }

  go.disabled = false;
  go.textContent = "Compress";
  summarise(files.length - failed, failed, before, after);
});

/* ---- The rows ------------------------------------------------------------- */
function reset(files) {
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls = [];
  list.replaceChildren();
  total.textContent = "";
  for (const file of files) {
    const row = rowTemplate.content.firstElementChild.cloneNode(true);
    row.querySelector(".row-name").textContent = file.name;
    row.querySelector(".row-status").textContent = "Waiting…";
    list.append(row);
  }
  results.hidden = false;
}

function resolveRow(row, file, out, images, preset) {
  const url = URL.createObjectURL(new Blob([out], { type: "application/pdf" }));
  objectUrls.push(url);

  const link = row.querySelector(".row-get");
  link.href = url;
  // The name says which recipe produced it, so two runs of the same source
  // do not land in the downloads folder as "file (1).pdf".
  link.download = file.name.replace(/\.pdf$/i, "") + preset.suffix + ".pdf";
  link.hidden = false;

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
  detail.textContent = (images
    ? `${images} image${images > 1 ? "s" : ""} re-encoded`
    : "No images found") + ` · ${preset.name} · text and vectors intact ✓`;
}

function failRow(row, message) {
  row.classList.add("failed");
  row.querySelector(".row-status").textContent = message;
}

function summarise(ok, failed, before, after) {
  if (!ok) {
    total.textContent = failed === 1 ? "Failed" : `All ${failed} failed`;
    return;
  }
  const saved = before ? Math.round((1 - after / before) * 100) : 0;
  const parts = [`${humanBytes(before)} → ${humanBytes(after)}`];
  if (saved > 0) parts.unshift(`${saved}% smaller overall`);
  if (failed) parts.push(`${failed} failed`);
  total.textContent = parts.join(" · ");
}
