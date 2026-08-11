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

// Resolved against this module's own URL, so it works under any gateway prefix
// without knowing what the prefix is.
const WASM_URL = new URL("./vendor/gs.wasm", import.meta.url);

// The arguments every preset shares. The quality choices live in presets.js so
// that the label a user picks and the flags it runs cannot drift apart.
//
// -dPDFDEBUG makes the interpreter dump every object it reads, which is the only
// way to find out how many images a PDF holds — gs reports nothing about its own
// image handling otherwise. The lines are filtered as they arrive (see below)
// rather than collected, so a 1000-image PDF does not accumulate megabytes of
// dictionary text just to be counted.
//
// -dSAFER is absent on purpose: there is no filesystem to protect here, only the
// in-memory one created for this single run and discarded with it.
const COMMON_ARGS = [
  "-sDEVICE=pdfwrite",
  "-dPDFDEBUG",
  "-dNOPAUSE",
  "-dQUIET",
  "-dBATCH",
];

let compiled = null;

function compile() {
  // compileStreaming needs the response served as application/wasm — it is, and
  // test/prefix.sh asserts it, because the failure mode otherwise is a silent
  // fall back to buffering 15 MB before compiling any of it.
  if (!compiled) {
    compiled = WebAssembly.compileStreaming(fetch(WASM_URL)).catch((err) => {
      compiled = null; // a failed fetch must not poison every later attempt
      throw err;
    });
  }
  return compiled;
}

// An image XObject as -dPDFDEBUG prints it. Width and Height are read
// separately from the /Subtype match because dictionary key order is the
// producer's choice, not something to rely on.
const IMAGE_LINE = /\/Subtype\s*\/Image\b/;
const WIDTH = /\/Width\s+(\d+)/;
const HEIGHT = /\/Height\s+(\d+)/;

async function compress(bytes, presetId) {
  const module = await compile();
  const log = [];
  const images = [];

  const onLine = (line) => {
    if (IMAGE_LINE.test(line)) {
      const w = WIDTH.exec(line);
      const h = HEIGHT.exec(line);
      if (w && h) images.push({ w: +w[1], h: +h[1] });
      return; // never kept as text
    }
    // Only the tail is worth keeping: if gs fails, the last thing it said is
    // the useful part, and this stops -dPDFDEBUG filling memory on success.
    if (log.length < 40) log.push(line);
  };

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
  return { out, images: images.length, preset: preset.id };
}

self.addEventListener("message", async (event) => {
  const { id, bytes, preset } = event.data;
  try {
    const { out, images } = await compress(new Uint8Array(bytes), preset);
    // Transferred, not copied: these are whole PDFs.
    self.postMessage({ id, ok: true, bytes: out.buffer, images }, [out.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message || String(err) });
  }
});
