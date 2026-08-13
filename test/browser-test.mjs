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

/* A PDF with two images at deliberately different resolutions, on a small page
   so the test stays quick. With a 200 dpi target and threshold 1.0:
     - the 400 dpi image is above target -> resampled
     - the 150 dpi image is below it     -> left exactly as it was
   which is the mixed case the "N resized, M left as they were" line exists to
   report, and the only one that can catch it counting wrongly. */
const PAGE_W = 306, PAGE_H = 396;            // 4.25 x 5.5 inches
const PAGE_DPIS = [400, 150];

function imageStream(dpi) {
  const w = Math.round((PAGE_W / 72) * dpi), h = Math.round((PAGE_H / 72) * dpi);
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      raw[i++] = (x * 7 + y * 3) & 255;
      raw[i++] = (x * 13) & 255;
      raw[i++] = (y * 11 + x) & 255;
    }
  }
  return { w, h, data: deflateSync(raw, { level: 6 }) };
}

function samplePdf() {
  const images = PAGE_DPIS.map(imageStream);
  const n = images.length;
  const kids = images.map((_, i) => `${3 + i * 3} 0 R`).join(" ");
  const objs = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`),
  ];
  images.forEach((img, i) => {
    const content = Buffer.from(
      `q ${PAGE_W} 0 0 ${PAGE_H} 0 0 cm /Im0 Do Q\n`);
    objs.push(
      Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
        `/Resources << /XObject << /Im0 ${5 + i * 3} 0 R >> >> /Contents ${4 + i * 3} 0 R >>`),
      Buffer.concat([
        Buffer.from(`<< /Length ${content.length} >>\nstream\n`),
        content, Buffer.from("endstream")]),
      Buffer.concat([
        Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${img.w} ` +
          `/Height ${img.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
          `/Filter /FlateDecode /Length ${img.data.length} >>\nstream\n`),
        img.data, Buffer.from("\nendstream")]));
  });

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
  // Puppeteer defaults to 800x600, below the 900px breakpoint — the workbench's
  // second column would never be exercised at that width.
  await page.setViewport({ width: 1400, height: 900 });

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
  for (let i = 0; i < 4; i++) writeFileSync(`/tmp/sample${i}.pdf`, pdf);
  await input.uploadFile("/tmp/sample.pdf", "/tmp/sample1.pdf",
                         "/tmp/sample2.pdf", "/tmp/sample3.pdf");
  await page.waitForSelector(".pick", { timeout: 10000 });
  const chips = await page.$$eval(".pick .pick-name", (els) => els.map((e) => e.textContent));
  chips.length === 4 && chips[0] === "sample.pdf"
    ? ok(`${chips.length} chips, first is ${chips[0]}`)
    : bad(`chips: ${JSON.stringify(chips)}`);

  // ---- The sidebar --------------------------------------------------------
  const sidebar = () => page.evaluate(() => {
    const vis = (sel) => {
      const el = document.querySelector(sel);
      return !!el && getComputedStyle(el).display !== "none";
    };
    return {
      width: Math.round(document.querySelector(".sidebar").getBoundingClientRect().width),
      collapsed: document.documentElement.getAttribute("data-sidebar") === "collapsed",
      labels: vis(".nav-label"), heading: vis(".nav-group-label"), icons: vis(".nav-icon"),
      account: !!document.querySelector(".account"),
      expanded: document.getElementById("sidebarToggle").getAttribute("aria-expanded"),
    };
  });

  let bar = await sidebar();
  bar.labels && bar.heading && bar.expanded === "true"
    ? ok(`sidebar starts open at ${bar.width}px, grouped under a heading`)
    : bad(`sidebar open: ${JSON.stringify(bar)}`);

  await page.click("#sidebarToggle");
  // The width is animated, so it has to settle before it is measured — reading
  // it straight after the click catches the old value and fails a passing app.
  await page.waitForFunction(
    () => document.querySelector(".sidebar").getBoundingClientRect().width < 80,
    { timeout: 5000 }).catch(() => {});
  bar = await sidebar();
  // Collapsed keeps the icons and the avatar and drops the words. It must not
  // become a hamburger that hides the app's structure.
  bar.collapsed && !bar.labels && !bar.heading && bar.icons && bar.width < 80 &&
    bar.expanded === "false"
    ? ok(`collapses to ${bar.width}px keeping the icons`)
    : bad(`sidebar collapsed: ${JSON.stringify(bar)}`);
  // Ungated, the gateway sends an empty X-Auth-User — so there is no account
  // row at all, rather than one permanently reading "Not signed in".
  !bar.account
    ? ok("no account row while nobody is signed in")
    : bad("an account row was rendered without a user");

  await page.reload({ waitUntil: "networkidle0" });
  bar = await sidebar();
  bar.collapsed
    ? ok("the collapsed choice survives a reload")
    : bad(`after reload: ${JSON.stringify(bar)}`);
  await page.click("#sidebarToggle");
  (await sidebar()).collapsed === false
    ? ok("and it opens again")
    : bad("could not re-open the sidebar");

  // Re-pick the files the reload cleared, for everything that follows.
  await (await page.$("#file")).uploadFile("/tmp/sample.pdf", "/tmp/sample1.pdf",
                                           "/tmp/sample2.pdf", "/tmp/sample3.pdf");
  await page.waitForSelector(".pick");

  // The workbench is two columns only once there is something to put in the
  // second one. Declared unconditionally it left an empty column on an untouched
  // page, and a narrowed form beside dead space reads as a broken width.
  const layout = await page.evaluate(() => {
    const bench = document.querySelector(".workbench");
    const panes = [...bench.children].filter((e) => getComputedStyle(e).display !== "none");
    const height = (e) => Math.round(e.getBoundingClientRect().height);
    return {
      panes: panes.length,
      // Every panel takes the row's full height — that is the only way the rule
      // between them reaches the bottom of the tallest one.
      sameHeight: new Set(panes.map(height)).size === 1,
      // A rule on each panel after the first, and none on the first.
      rules: panes.map((e) => getComputedStyle(e).borderLeftWidth),
    };
  });
  layout.panes === 3 && layout.sameHeight &&
    layout.rules[0] === "0px" && layout.rules.slice(1).every((r) => r === "1px")
    ? ok(`${layout.panes} panels of equal height, divided by full-height rules`)
    : bad(`workbench: ${JSON.stringify(layout)}`);

  // Dropping outside the dashed box must still land. The browser's default for
  // an unhandled drop is to navigate to the file, which would throw the page and
  // every picked file away — so this checks the page survived as much as that
  // the file arrived.
  const dropped = await page.evaluate(async () => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])],
                            "dropped-far-away.pdf", { type: "application/pdf" }));
    // The header: about as far from the drop zone as the page allows.
    const target = document.querySelector("header");
    for (const type of ["dragenter", "dragover", "drop"]) {
      target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
    }
    await new Promise((r) => setTimeout(r, 50));
    return { chips: document.querySelectorAll(".pick").length,
             stillHere: !!document.getElementById("shrink") };
  });
  dropped.stillHere && dropped.chips === 5
    ? ok(`a drop outside the box is caught (${dropped.chips} chips)`)
    : bad(`drop outside the box: ${JSON.stringify(dropped)}`);
  // Put the queue back to the four real files for everything below.
  await page.evaluate(() => {
    const chip = [...document.querySelectorAll(".pick")]
      .find((c) => c.querySelector(".pick-name").textContent === "dropped-far-away.pdf");
    chip.querySelector(".pick-drop").click();
  });

  // The engine is fetched when a file is picked, not when Compress is clicked —
  // otherwise the first run is seconds of waiting on the network with an idle
  // CPU, which is what "slow but nothing is happening" actually is.
  const prefetched = await page.evaluate(() =>
    performance.getEntriesByType("resource").some((e) => e.name.endsWith("gs.wasm")));
  prefetched ? ok("the engine was already fetched before Compress was clicked")
             : bad("gs.wasm was not prefetched on pick");

  const presets = await page.$$eval(".choice input[name=quality]",
    (els) => els.map((e) => ({ id: e.value, checked: e.checked })));
  presets.length === 2 ? ok(`the picker offers ${presets.length} presets`)
                       : bad(`expected 2 presets, got ${presets.length}`);
  presets[0]?.checked && presets[0].id === "email"
    ? ok("Email is the default")
    : bad(`default is ${JSON.stringify(presets)}`);

  // Watch how many workers exist at the busiest moment: with four files and
  // more than one core, a pool that silently ran one at a time would never
  // show more than one.
  let peakWorkers = 0;
  const watch = setInterval(() => {
    peakWorkers = Math.max(peakWorkers, page.workers().length);
  }, 50);

  await page.click("#go");

  // With a pool, several files are being worked on at once — those rows must say
  // so rather than all reading "Queued" while the machine is at full tilt.
  await page.waitForSelector(".row.working", { timeout: 180000 });
  const working = await page.evaluate(() => ({
    n: document.querySelectorAll(".row.working").length,
    status: document.querySelector(".row.working .row-status")?.textContent,
  }));
  working.status === "Compressing…"
    ? ok(`${working.n} row(s) report Compressing while the rest queue`)
    : bad(`working row says "${working.status}"`);

  // The inputs are frozen mid-run: editing the queue would move rows the batch
  // addresses by index, and changing the quality would leave the picker saying
  // one thing while another was being produced.
  const before = await page.evaluate(() =>
    document.querySelector('.choice input[value="print"]').checked);
  // A real pointer click, not element.click(): `inert` blocks user interaction —
  // pointer events, focus, tab order — and never claimed to block a synthetic
  // call from script. Testing it with radio.click() would test nothing and pass
  // for the wrong reason.
  await page.click('.choice input[value="print"]', { timeout: 2000 }).catch(() => {});
  const locked = await page.evaluate((was) => ({
    fields: [...document.querySelectorAll("#shrink .field")].every((f) => f.inert),
    queue: document.getElementById("queue").inert,
    busy: document.getElementById("shrink").classList.contains("busy"),
    presetMoved: document.querySelector('.choice input[value="print"]').checked !== was,
    focusable: document.querySelector("#file").matches(":disabled, [inert] *, [inert]"),
  }), before);
  locked.fields && locked.queue && locked.busy && !locked.presetMoved && locked.focusable
    ? ok("the form is inert while compressing — a real click will not move the picker")
    : bad(`form during a run: ${JSON.stringify(locked)}`);

  // A drop mid-run must still be swallowed: the browser's default is to navigate
  // to the file, which would take the running batch with it.
  const survived = await page.evaluate(async () => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([0x25, 0x50])], "mid-run.pdf",
                            { type: "application/pdf" }));
    const before = document.querySelectorAll(".pick").length;
    const event = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data });
    window.dispatchEvent(event);
    await new Promise((r) => setTimeout(r, 50));
    return { prevented: event.defaultPrevented,
             added: document.querySelectorAll(".pick").length - before,
             stillHere: !!document.getElementById("shrink") };
  });
  survived.prevented && survived.added === 0 && survived.stillHere
    ? ok("a drop mid-run is swallowed, not taken and not navigated to")
    : bad(`drop during a run: ${JSON.stringify(survived)}`);

  // 15.4 MB of wasm has to arrive and compile before anything happens, so this
  // is generous on purpose.
  await page.waitForSelector(".row.done, .row.failed", { timeout: 180000 });
  await page.waitForFunction(
    () => !document.getElementById("go").textContent.startsWith("Compressing"),
    { timeout: 180000 });
  clearInterval(watch);

  // Nothing left to do at this quality, so the button goes flat and says so.
  const idle = await page.evaluate(() => ({
    text: document.getElementById("go").textContent,
    disabled: document.getElementById("go").disabled,
  }));
  idle.text === "Compressed" && idle.disabled
    ? ok('the button settles on a disabled "Compressed"')
    : bad(`button after the run: ${JSON.stringify(idle)}`);

  const cores = await page.evaluate(() => navigator.hardwareConcurrency || 4);
  const expected = Math.max(1, Math.floor(cores * 0.8));
  peakWorkers > 1 || cores < 3
    ? ok(`ran ${peakWorkers} workers in parallel on ${cores} cores`)
    : bad(`only ${peakWorkers} worker on ${cores} cores (expected ~${expected})`);
  peakWorkers <= expected
    ? ok(`and no more than the ${expected}-worker cap`)
    : bad(`${peakWorkers} workers exceeds the ${expected} cap`);

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
      ? ok(`download named ${name}`)
      : bad(`download named ${JSON.stringify(name)}, expected "sample_compressed_email_quality.pdf"`);

    // The mixed case: one image above the 200 dpi target, one below it.
    const detail = await page.$eval(".row.done .row-detail", (e) => e.textContent);
    detail.includes("1/2 images resized") && detail.includes("Email quality")
      ? ok(`image breakdown: ${detail}`)
      : bad(`unexpected breakdown: ${detail}`);
  }

  // The other preset, on the same file, so both recipes are known to run and
  // Print is known to keep more than Email does.
  const emailBytes = await page.evaluate(async () =>
    (await (await fetch(document.querySelector(".row-get").href)).arrayBuffer()).byteLength);
  // Clicked through the element rather than by coordinates: the radio is
  // appearance:none, so a synthesized click is the reliable way to move it, and
  // the return value proves it moved rather than assuming.
  const switched = await page.evaluate(() => {
    const radio = document.querySelector('.choice input[value="print"]');
    radio.click();
    return radio.checked;
  });
  switched ? ok("switched to Print (Brochure)") : bad("the Print radio did not take");
  // Different quality, different output — so the cache must not claim these are
  // already done, and the button has to offer the work again.
  const afterSwitch = await page.evaluate(() => ({
    text: document.getElementById("go").textContent,
    disabled: document.getElementById("go").disabled,
  }));
  !afterSwitch.disabled && afterSwitch.text === "Compress 4 files"
    ? ok(`changing quality re-arms the button ("${afterSwitch.text}")`)
    : bad(`after switching quality: ${JSON.stringify(afterSwitch)}`);

  // Mark the current rows first. Waiting on #go alone is not enough: it already
  // reads "Compress" at the moment of clicking, so the wait returns instantly and
  // the assertions below read the *previous* run's results. The marker only
  // clears when reset() has replaced every row, which is the real start signal.
  await page.evaluate(() =>
    document.querySelectorAll(".row").forEach((r) => r.classList.add("stale")));
  await page.click("#go");
  await page.waitForFunction(
    () => document.querySelectorAll(".row.stale").length === 0, { timeout: 60000 });
  await page.waitForFunction(
    () => !document.getElementById("go").textContent.startsWith("Compressing") &&
          document.querySelectorAll(".row.done, .row.failed").length === 4,
    { timeout: 180000 });
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
    detail.includes("Print (Brochure) quality")
      ? ok(`the row names the preset used`)
      : bad(`row detail does not name the preset: ${detail}`);
    const pname = await page.$eval(".row-get", (e) => e.getAttribute("download"));
    pname === "sample_compressed_print_quality.pdf"
      ? ok(`download named ${pname}`)
      : bad(`download named ${JSON.stringify(pname)}, expected "sample_compressed_print_quality.pdf"`);
  }

  // ---- Selection drives the actions ----------------------------------------
  const sel = () => page.evaluate(() => ({
    all: document.getElementById("selectAll").checked,
    some: document.getElementById("selectAll").indeterminate,
    count: document.getElementById("resultsCount").textContent,
    download: document.getElementById("downloadSelected").querySelector("span").textContent,
    disabled: document.getElementById("downloadSelected").disabled,
    rows: [...document.querySelectorAll(".row.selected")].length,
  }));

  let state = await sel();
  state.all && state.count.startsWith("4 of 4 selected")
    ? ok(`everything finished starts selected (${state.count})`)
    : bad(`initial selection: ${JSON.stringify(state)}`);
  state.download === "Download (zip)"
    ? ok(`download button reads "${state.download}"`)
    : bad(`button says "${state.download}"`);

  // Untick one: the header must go indeterminate, not stay "all".
  await page.click(".row:nth-child(2) .row-sel");
  state = await sel();
  !state.all && state.some && state.count.startsWith("3 of 4 selected")
    ? ok(`unticking one gives "${state.count}", header indeterminate`)
    : bad(`after untick: ${JSON.stringify(state)}`);
  state.rows === 3 ? ok("three rows are tinted") : bad(`${state.rows} rows tinted`);
  state.download === "Download (zip)"
    ? ok(`button stays uncluttered: "${state.download}"`)
    : bad(`button says "${state.download}"`);

  // Down to one: no zip, because unzipping to get back what you had is a chore.
  await page.evaluate(() => {
    document.querySelectorAll(".row .row-sel").forEach((c, i) => {
      if (i > 0 && c.checked) c.click();
    });
  });
  state = await sel();
  state.download === "Download"
    ? ok(`one file is not an archive: "${state.download}"`)
    : bad(`button says "${state.download}"`);

  // None: both actions must go inert rather than producing an empty zip.
  await page.click("#selectAll");
  await page.click("#selectAll");
  state = await sel();
  if (state.count.startsWith("0 of 4 selected")) {
    state.disabled ? ok("nothing selected disables the actions")
                   : bad("actions still enabled with nothing selected");
  } else {
    // Clicking an indeterminate box checks it, so one click may select all.
    await page.evaluate(() => document.querySelectorAll(".row .row-sel")
      .forEach((c) => { if (c.checked) c.click(); }));
    state = await sel();
    state.disabled ? ok("nothing selected disables the actions")
                   : bad(`with ${state.count}: ${JSON.stringify(state)}`);
  }

  // Sharing is feature-detected. Headless Chromium has no share sheet, so the
  // button must be absent — shown-and-failing is the outcome being avoided.
  const share = await page.evaluate(() => ({
    hidden: document.getElementById("shareSelected").hidden,
    label: document.getElementById("shareSelected").querySelector("span").textContent,
    canShare: typeof navigator.canShare === "function",
  }));
  share.hidden || share.canShare
    ? ok(`Share button hidden where sharing is unavailable (hidden=${share.hidden})`)
    : bad("Share button shown without share support");
  // Named for what it opens — a chooser — not for one of the things in it.
  /^Share( \d+)? to…$/.test(share.label)
    ? ok(`share button reads "${share.label}"`)
    : bad(`share button reads "${share.label}"`);

  // The zip is written by hand, so its bytes are worth checking rather than
  // assuming: PK signature, and the central directory claims the right count.
  const zip = await page.evaluate(async () => {
    const { makeZip } = await import("./static/zip.js");
    const enc = new TextEncoder();
    const blob = makeZip([
      { name: "a.pdf", bytes: enc.encode("%PDF-1.7 one") },
      { name: "b.pdf", bytes: enc.encode("%PDF-1.7 two") },
    ]);
    const b = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(b.buffer);
    return {
      sig: String.fromCharCode(b[0], b[1]),
      size: b.length,
      // End-of-central-directory is the last 22 bytes when there is no comment.
      endSig: view.getUint32(b.length - 22, true) === 0x06054b50,
      entries: view.getUint16(b.length - 22 + 10, true),
    };
  });
  zip.sig === "PK" && zip.endSig && zip.entries === 2
    ? ok(`zip is well-formed: PK, ${zip.entries} entries, ${zip.size} bytes`)
    : bad(`zip malformed: ${JSON.stringify(zip)}`);

  // ---- Preview -------------------------------------------------------------
  await page.evaluate(() => document.querySelector(".row-preview").click());
  // Rendering is real work in a worker, so it is waited for rather than assumed
  // — and waited for in *both* panes. A count across the two was satisfied by
  // the first pane alone, so the second was measured while still empty.
  const painted = (sel) => {
    const c = document.querySelector(sel);
    if (!c || !c.width) return false;
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] < 250 || d[i + 1] < 250 || d[i + 2] < 250) return true;
    }
    return false;
  };
  await page.waitForFunction(
    `(${painted})("#viewerA canvas") && (${painted})("#viewerB canvas")`,
    { timeout: 60000 });

  const preview = await page.evaluate(() => {
    const ink = (canvas) => {
      const d = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 250 || d[i+1] < 250 || d[i+2] < 250) n++;
      return n;
    };
    const a = [...document.querySelectorAll("#viewerA canvas")];
    const b = [...document.querySelectorAll("#viewerB canvas")];
    return {
      open: !document.getElementById("viewer").hidden,
      pagesA: a.length, pagesB: b.length,
      // Blank canvases would pass a "two panes exist" check and show nothing.
      inkA: a.length ? ink(a[0]) : 0,
      inkB: b.length ? ink(b[0]) : 0,
      sizes: [...document.querySelectorAll(".viewer-pane h3 span")].map((e) => e.textContent),
    };
  });
  preview.open && preview.pagesA === 2 && preview.pagesB === 2
    ? ok(`preview renders both documents (${preview.sizes.join(" vs ")})`)
    : bad(`preview: ${JSON.stringify(preview)}`);
  preview.inkA > 0 && preview.inkB > 0
    ? ok(`pages are actually painted (${preview.inkA} / ${preview.inkB} ink pixels)`)
    : bad(`blank canvases: ${JSON.stringify(preview)}`);

  // Vertical sync — the whole reason the renderer was swapped. Proportional, so
  // it holds even though the two documents are different lengths.
  const scrolled = await page.evaluate(async () => {
    const [a, b] = [document.getElementById("scrollA"), document.getElementById("scrollB")];
    a.scrollTop = Math.round((a.scrollHeight - a.clientHeight) * 0.5);
    a.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 80));
    const roomB = b.scrollHeight - b.clientHeight;
    return { fraction: roomB > 0 ? b.scrollTop / roomB : -1, moved: b.scrollTop > 0 };
  });
  scrolled.moved && Math.abs(scrolled.fraction - 0.5) < 0.05
    ? ok(`scrolling one pane scrolls the other (landed at ${scrolled.fraction.toFixed(2)})`)
    : bad(`vertical sync: ${JSON.stringify(scrolled)}`);

  // And back the other way, without the two fighting each other.
  const backwards = await page.evaluate(async () => {
    const [a, b] = [document.getElementById("scrollA"), document.getElementById("scrollB")];
    b.scrollTop = 0;
    b.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 80));
    return { a: a.scrollTop, b: b.scrollTop };
  });
  backwards.a === 0 && backwards.b === 0
    ? ok("and scrolling it back moves the first one too")
    : bad(`reverse sync: ${JSON.stringify(backwards)}`);

  // The panes must stay the same width as each other whatever is in them, or
  // the two documents are no longer shown at comparable sizes.
  const even = await page.evaluate(() => [
    document.getElementById("scrollA").clientWidth,
    document.getElementById("scrollB").clientWidth,
  ]);
  Math.abs(even[0] - even[1]) <= 1
    ? ok(`both panes are the same width (${even[0]}px)`)
    : bad(`panes differ: ${JSON.stringify(even)}`);

  // Zoom re-renders both at a larger scale — the canvases themselves grow.
  const atFit = await page.evaluate(() =>
    document.querySelector("#viewerA canvas").width);
  await page.evaluate(() => document.querySelector('.viewer-zoom [data-zoom="300"]').click());
  // Both panes, not just the first: a redraw is asynchronous, and measuring the
  // second before its render lands reads the old width and fails a working app.
  const grew = await page.waitForFunction(
    (w) => {
      const a = document.querySelector("#viewerA canvas")?.width || 0;
      const b = document.querySelector("#viewerB canvas")?.width || 0;
      return a > w && b > w ? { a, b } : false;
    },
    { timeout: 45000, polling: 200 }, atFit)
    .then((handle) => handle.jsonValue())
    .catch(() => null);

  if (!grew) {
    const now = await page.evaluate(() => ({
      a: [...document.querySelectorAll("#viewerA canvas")].map((c) => c.width),
      b: [...document.querySelectorAll("#viewerB canvas")].map((c) => c.width),
      panes: [document.getElementById("scrollA").clientWidth,
              document.getElementById("scrollB").clientWidth],
    }));
    bad(`300% did not reach both panes: fit=${atFit} now=${JSON.stringify(now)}`);
  } else {
    const pressed = await page.$eval('.viewer-zoom [data-zoom="300"]',
      (e) => e.getAttribute("aria-pressed"));
    pressed === "true"
      ? ok(`300% re-renders both larger (${atFit}px → ${grew.a}/${grew.b}px)`)
      : bad("zoom button not marked pressed");
  }

  await page.keyboard.press("Escape");
  const closed = await page.evaluate(() => ({
    hidden: document.getElementById("viewer").hidden,
    canvases: document.querySelectorAll("#viewerA canvas, #viewerB canvas").length,
  }));
  closed.hidden && closed.canvases === 0
    ? ok("Escape closes the preview and tears both documents down")
    : bad(`after Escape: ${JSON.stringify(closed)}`);

  // ---- Nothing is lost silently --------------------------------------------
  // The listener is added and removed rather than left in place, so its presence
  // is the assertion: a page that always asks is one people learn to click past.
  // Dispatching the event is how the guard is observed: the handler calls
  // preventDefault, which is exactly what makes a browser ask before leaving.
  // Nothing is rendered for this any more, so there is no text to read instead.
  const risk = () => page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return { asks: event.defaultPrevented };
  });

  await page.evaluate(() => document.querySelectorAll(".row .row-sel")
    .forEach((c) => { if (!c.checked) c.click(); }));
  let r = await risk();
  r.asks
    ? ok("closing the tab is challenged while results are unsaved")
    : bad("leaving was not challenged with unsaved results");

  // Downloading one row marks that one, and only that one, as taken.
  await page.evaluate(() => document.querySelector(".row-get").click());
  r = await risk();
  r.asks
    ? ok("still challenged while three of four are unsaved")
    : bad("stopped challenging after only one was saved");

  // Download the rest as a zip; nothing is then at risk.
  await page.evaluate(() => document.getElementById("downloadSelected").click());
  r = await risk();
  !r.asks
    ? ok("and stops once everything has been downloaded")
    : bad("still challenging after everything was saved");

  // The claim on the page is that nothing is uploaded. This is what checks it.
  const uploads = requests.filter((r) => r.method !== "GET");
  uploads.length === 0 ? ok("nothing was uploaded — every request was a GET")
                       : bad(`uploaded: ${JSON.stringify(uploads)}`);

  // Requests made *inside* a worker are not reported on the page's request
  // event — they belong to a separate target. So the worker's own existence is
  // what gets asserted here, and the successful compression above is the proof
  // that it fetched and compiled the wasm. That the wasm is served correctly
  // (application/wasm, cacheable) is a server concern and lives in prefix.sh.
  ok(`pool sized from ${await page.evaluate(() => navigator.hardwareConcurrency)} cores`);
  const offsite = requests.filter((r) =>
    !r.url.startsWith(BASE.replace(/\/[^/]*$/, "")) &&
    !r.url.startsWith("blob:") &&
    !r.url.startsWith("data:") &&
    // The built-in PDF viewer pulls its own assets over chrome:// and
    // chrome-extension://. That is the browser rendering the preview — the whole
    // point of using it rather than rendering the pages ourselves — and none of
    // it leaves the machine. Anything with a remote host still fails this, which
    // is what the assertion is actually for.
    !/^chrome(-extension)?:/.test(r.url));
  offsite.length === 0 ? ok("no third-party requests")
                       : bad(`off-site: ${offsite.map((r) => r.url).join(", ")}`);

  consoleErrors.length === 0 ? ok("no uncaught page errors")
                             : bad(`page errors: ${consoleErrors.join(" | ")}`);
} finally {
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
