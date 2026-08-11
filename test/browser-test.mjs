// Drive ShrinkPDF in a real browser and check it actually compresses.
//
// This is the only test that can say the client-side path works: the vendored
// Ghostscript is compiled ENVIRONMENT=web, so node refuses to load it, and the
// whole point of the tool is that the work happens in the browser.
//
//   node browser-test.mjs <base-url>
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";

const BASE = process.argv[2] || "http://toolshed-prefix-proxy/toolshed";

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  \x1b[32mok\x1b[0m   ${m}`); pass++; };
const bad = (m) => { console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); fail++; };

/* A PDF Ghostscript can actually shrink: one oversized image on one page. Same
   shape as test/make_sample.py, rewritten here so this container needs no
   python. */
function samplePdf() {
  const W = 1224, H = 1584;
  const raw = Buffer.alloc(W * H * 3);
  for (let y = 0, i = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      raw[i++] = (x * 7 + y * 3) & 255;
      raw[i++] = (x * 13) & 255;
      raw[i++] = (y * 11 + x) & 255;
    }
  }
  const img = deflateSync(raw, { level: 6 });
  const objs = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>"),
    Buffer.from("<< /Length 44 >>\nstream\nq 612 0 0 792 0 0 cm /Im0 Do Q\nendstream"),
    Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode ` +
        `/Length ${img.length} >>\nstream\n`),
      img, Buffer.from("\nendstream"),
    ]),
  ];
  let out = Buffer.from("%PDF-1.7\n");
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out = Buffer.concat([out, Buffer.from(`${i + 1} 0 obj\n`), body,
                         Buffer.from("\nendobj\n")]);
  });
  const xref = out.length;
  let tail = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) tail += `${String(off).padStart(10, "0")} 00000 n \n`;
  tail += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.concat([out, Buffer.from(tail)]);
}

const pdf = samplePdf();
writeFileSync("/tmp/sample.pdf", pdf);

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME,
  // Required in a container; this browser only ever loads our own page.
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const page = await browser.newPage();

  // Anything the page fetches, so we can prove the wasm was actually served and
  // that nothing was uploaded.
  const requests = [];
  page.on("request", (r) => requests.push({ method: r.method(), url: r.url() }));
  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(e.message));

  await page.goto(`${BASE}/pdf`, { waitUntil: "networkidle0", timeout: 60000 });
  ok("the page loads");

  // Hand the file to the real <input type=file>, exactly as a user would.
  const input = await page.$("#file");
  await input.uploadFile("/tmp/sample.pdf");
  await page.waitForSelector(".pick", { timeout: 10000 });
  const chip = await page.$eval(".pick .pick-name", (el) => el.textContent);
  chip === "sample.pdf" ? ok(`the chip names the file (${chip})`)
                        : bad(`chip says "${chip}"`);

  const presets = await page.$$eval(".choice input[name=quality]",
    (els) => els.map((e) => ({ id: e.value, checked: e.checked })));
  presets.length === 2 ? ok(`the picker offers ${presets.length} presets`)
                       : bad(`expected 2 presets, got ${presets.length}`);
  presets[0]?.checked && presets[0].id === "email"
    ? ok("Email is the default")
    : bad(`default is ${JSON.stringify(presets)}`);

  await page.click("#go");

  // 15.4 MB of wasm has to arrive and compile before anything happens, so this
  // is generous on purpose.
  await page.waitForSelector(".row.done, .row.failed", { timeout: 180000 });

  const failed = await page.$(".row.failed");
  if (failed) {
    bad(`the row failed: ${await page.$eval(".row.failed .row-status", (e) => e.textContent)}`);
  } else {
    ok("the row completed");
    const status = await page.$eval(".row.done .row-status", (e) => e.textContent);
    ok(`status: ${status}`);

    // Pull the produced bytes back out of the blob: URL the download points at.
    const result = await page.evaluate(async () => {
      const href = document.querySelector(".row-get").href;
      const buf = new Uint8Array(await (await fetch(href)).arrayBuffer());
      return { length: buf.length, head: String.fromCharCode(...buf.slice(0, 5)) };
    });
    result.head === "%PDF-" ? ok("the result is a valid PDF")
                            : bad(`result starts "${result.head}"`);
    result.length < pdf.length
      ? ok(`smaller in-browser: ${pdf.length} -> ${result.length} bytes ` +
           `(${Math.round(result.length / pdf.length * 100)}%)`)
      : bad(`not smaller: ${pdf.length} -> ${result.length}`);

    const name = await page.$eval(".row-get", (e) => e.getAttribute("download"));
    name === "sample_compressed_email_quality.pdf"
      ? ok(`download named ${name}`) : bad(`download named ${name}`);
  }

  // The other preset, on the same file, so both recipes are known to run and
  // Print is known to keep more than Email does.
  const emailBytes = await page.evaluate(async () =>
    (await (await fetch(document.querySelector(".row-get").href)).arrayBuffer()).byteLength);
  await page.click('.choice input[value="print"]');
  await page.click("#go");
  await page.waitForSelector(".row.done, .row.failed", { timeout: 180000 });
  const printFailed = await page.$(".row.failed");
  if (printFailed) {
    bad(`Print preset failed: ${await page.$eval(".row.failed .row-status", (e) => e.textContent)}`);
  } else {
    const printBytes = await page.evaluate(async () =>
      (await (await fetch(document.querySelector(".row-get").href)).arrayBuffer()).byteLength);
    ok(`Print (Brochure) ran: ${printBytes} bytes`);
    printBytes > emailBytes
      ? ok(`Print keeps more than Email (${printBytes} > ${emailBytes})`)
      : bad(`Print (${printBytes}) is not larger than Email (${emailBytes})`);
    const detail = await page.$eval(".row.done .row-detail", (e) => e.textContent);
    detail.includes("Print (Brochure)")
      ? ok(`the row names the preset used`)
      : bad(`row detail does not name the preset: ${detail}`);
    const pname = await page.$eval(".row-get", (e) => e.getAttribute("download"));
    pname === "sample_compressed_print_quality.pdf"
      ? ok(`download named ${pname}`) : bad(`download named ${pname}`);
  }

  // The claim on the page is that nothing is uploaded. This is what checks it.
  const uploads = requests.filter((r) => r.method !== "GET");
  uploads.length === 0 ? ok("nothing was uploaded — every request was a GET")
                       : bad(`uploaded: ${JSON.stringify(uploads)}`);

  // Requests made *inside* a worker are not reported on the page's request
  // event — they belong to a separate target. So the worker's own existence is
  // what gets asserted here, and the successful compression above is the proof
  // that it fetched and compiled the wasm. That the wasm is served correctly
  // (application/wasm, cacheable) is a server concern and lives in prefix.sh.
  const workers = page.workers();
  workers.length === 1 ? ok(`compression ran in a worker (${workers.length})`)
                       : bad(`expected 1 worker, found ${workers.length}`);
  const offsite = requests.filter((r) => !r.url.startsWith(BASE.replace(/\/[^/]*$/, "")) &&
                                         !r.url.startsWith("blob:") &&
                                         !r.url.startsWith("data:"));
  offsite.length === 0 ? ok("no third-party requests")
                       : bad(`off-site: ${offsite.map((r) => r.url).join(", ")}`);

  consoleErrors.length === 0 ? ok("no uncaught page errors")
                             : bad(`page errors: ${consoleErrors.join(" | ")}`);
} finally {
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
