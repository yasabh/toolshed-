// Ghostscript, in a worker.
//
// Off the main thread because compressing a PDF takes about a second per file
// and blocks whatever thread it runs on — on the main thread that is a page
// that stops scrolling, stops animating, and looks crashed.
//
// The 15.4 MB module is compiled **once** and instantiated per file. Emscripten
// runs `main` once per module instance, so each file needs a fresh instance, but
// recompiling the wasm each time would cost far more than the compression does.
//
// Everything here happens on the user's machine. Nothing is uploaded.
import createModule from "./vendor/gs.mjs";
import { presetById } from "./presets.js";
import { findImages, compareImages } from "./pdf-images.js";

// Resolved against this module's own URL, so it works under any gateway prefix
// without knowing what the prefix is.
const WASM_URL = new URL("./vendor/gs.wasm", import.meta.url);

// The arguments every preset shares. The quality choices live in presets.js so
// that the label a user picks and the flags it runs cannot drift apart.
//
// -dSAFER is absent on purpose: there is no filesystem to protect here, only the
// in-memory one created for this single run and discarded with it.
//
// -dPDFDEBUG used to be here, to count images from Ghostscript's object dump.
// It is gone: pdf-images.js reads the dictionaries out of the file itself, which
// costs one pass instead of a JS callback per line of a full object dump.
const COMMON_ARGS = [
  "-sDEVICE=pdfwrite",
  "-dNOPAUSE",
  "-dQUIET",
  "-dBATCH",
];

// A WebAssembly.Module is structured-cloneable, so the pool compiles the 15.4 MB
// once on the main thread and posts the result to every worker. Compiling it per
// worker would cost that work N times over and is the obvious way to make a pool
// slower than no pool at all. Each worker still gets its own *instance*, and so
// its own linear memory — only the compiled code is shared.
let shared = null;

function compile() {
  if (shared) return Promise.resolve(shared);
  // Fallback for anywhere the Module cannot be posted. compileStreaming needs
  // the response served as application/wasm — it is, and test/prefix.sh asserts
  // it, because the failure otherwise is a silent fall back to buffering 15 MB
  // before compiling any of it.
  return WebAssembly.compileStreaming(fetch(WASM_URL));
}

async function compress(bytes, presetId) {
  const module = await compile();
  const log = [];
  // Only the head is worth keeping: if gs fails, what it said first is the
  // useful part, and an unbounded log on a broken file is its own problem.
  const onLine = (line) => { if (log.length < 40) log.push(line); };

  // Read before the bytes are handed to Ghostscript's in-memory filesystem.
  const imagesBefore = findImages(bytes);

  const gs = await createModule({
    noInitialRun: true,
    print: onLine,
    printErr: onLine,
    // Reuse the compiled module instead of letting Emscripten fetch and compile
    // its own copy for every file.
    instantiateWasm(imports, done) {
      WebAssembly.instantiate(module, imports).then(
        (instance) => done(instance, module),
        (err) => { throw err; },
      );
      return {};
    },
  });

  gs.FS.writeFile("/in.pdf", bytes);
  const preset = presetById(presetId);
  // Order is load-bearing: -sOutputFile must precede -c, and -f must be last.
  // setdistillerparams is how JPEG quality is actually set — -dJPEGQ is ignored
  // by pdfwrite entirely. See the note at the top of presets.js.
  const code = gs.callMain([
    ...COMMON_ARGS, ...preset.args,
    "-sOutputFile=/out.pdf",
    "-c", preset.distiller,
    "-f", "/in.pdf",
  ]);

  let out;
  try {
    out = gs.FS.readFile("/out.pdf");
  } catch {
    out = null;
  }
  if (code || !out || out.length === 0 || out[0] !== 0x25 /* '%' */) {
    // Ghostscript's diagnostics name the file and are pages long; the user gets
    // a sentence, and the detail goes to the console of the machine it happened
    // on — which is theirs.
    if (log.length) console.warn("ghostscript:", log.join("\n"));
    throw new Error("Ghostscript could not read that PDF.");
  }
  return { out, images: compareImages(imagesBefore, findImages(out)) };
}

self.addEventListener("message", async (event) => {
  if (event.data.type === "module") {
    shared = event.data.module;
    return;
  }
  const { id, bytes, preset } = event.data;
  try {
    const { out, images } = await compress(new Uint8Array(bytes), preset);
    // Transferred, not copied: these are whole PDFs.
    self.postMessage({ id, ok: true, bytes: out.buffer, images }, [out.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message || String(err) });
  }
});
