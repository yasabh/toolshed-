// The target-quality presets, in one place.
//
// Imported by both pdf.js (which draws the picker) and gs-worker.js (which runs
// the chosen one), so a label, a filename suffix and the arguments behind them
// cannot drift apart. Adding a preset means adding one entry here.
//
// -------------------------------------------------------------------------
// A warning worth reading before editing `args`:
//
//   **`-dJPEGQ` does nothing.** pdfwrite ignores it — measured, not assumed:
//   -dJPEGQ=10 and -dJPEGQ=95 produce byte-identical output. Any recipe copied
//   off the internet that sets it is not doing what it claims.
//
//   JPEG quality in pdfwrite is set through distiller parameters instead, as a
//   **QFactor**, where *lower means better*. On one test image:
//
//     QFactor  0.05 → 2.50 MB    0.76 → 759 KB
//              0.15 → 1.67 MB    1.30 → 568 KB
//              0.40 → 1.09 MB    2.40 → 368 KB
//
//   Adobe's names for those: 0.1 maximum, 0.4 high, 0.76 medium, 1.3 low.
// -------------------------------------------------------------------------

// Chroma sampling: [1 1 1 1] is 4:4:4, i.e. no chroma subsampling at all. Worth
// the bytes on both presets — subsampling is what smears coloured text and thin
// coloured lines, which is exactly what a brochure is made of.
const NO_CHROMA_SUBSAMPLING = "/Blend 1 /HSamples [1 1 1 1] /VSamples [1 1 1 1]";

const distiller = (qFactor) =>
  `<< /ColorImageDict << /QFactor ${qFactor} ${NO_CHROMA_SUBSAMPLING} >>` +
  ` /GrayImageDict << /QFactor ${qFactor} ${NO_CHROMA_SUBSAMPLING} >> >>` +
  ` setdistillerparams`;

export const PRESETS = [
  {
    id: "email",
    name: "Email",
    detail: "200 dpi · JPEG high · bicubic",
    blurb: "Smallest. For sending and for reading on a screen.",
    // Appended to the original filename, so a file's name says how it was made.
    suffix: "_compressed_email_quality",
    args: [
      "-dCompatibilityLevel=1.5",
      "-dDownsampleColorImages=true",
      "-dColorImageResolution=200",
      "-dColorImageDownsampleType=/Bicubic",
      "-dDownsampleGrayImages=true",
      "-dGrayImageResolution=200",
      "-dAutoFilterColorImages=false",
      "-dColorImageFilter=/DCTEncode",
      // Ghostscript's default DownsampleThreshold is 1.5, which would make
      // "200 dpi" quietly mean "anything above 300 dpi becomes 200" and leave a
      // 250 dpi scan untouched. 1.0 makes 200 the cutoff the label claims.
      "-dColorImageDownsampleThreshold=1.0",
      "-dGrayImageDownsampleThreshold=1.0",
    ],
    // 0.4 = Adobe's "high". The intent behind the original -dJPEGQ=88.
    distiller: distiller(0.4),
  },
  {
    id: "print",
    name: "Print (Brochure)",
    detail: "300 dpi · JPEG maximum · mono 1200 CCITT · colours preserved",
    blurb: "Keeps enough detail to print. Bigger, and colour-safe.",
    suffix: "_compressed_print_quality",
    args: [
      "-dCompatibilityLevel=1.6",
      "-dDownsampleColorImages=true",
      "-dColorImageResolution=300",
      "-dColorImageDownsampleType=/Bicubic",
      "-dDownsampleGrayImages=true",
      "-dGrayImageResolution=300",
      // Line art and scanned text: kept at print resolution, and CCITT rather
      // than JPEG because JPEG on 1-bit black and white is both larger and
      // uglier — it invents grey where there was none.
      "-dDownsampleMonoImages=true",
      "-dMonoImageResolution=1200",
      "-dMonoImageFilter=/CCITTFaxEncode",
      "-dAutoFilterColorImages=false",
      "-dColorImageFilter=/DCTEncode",
      // No conversion to sRGB: a brochure heading for a press carries CMYK and
      // spot colours, and flattening those is the one thing a printer cannot
      // undo. This is the flag that makes this preset "Print" rather than
      // "Email at 300 dpi".
      "-dColorConversionStrategy=/LeaveColorUnchanged",
      // Note the *absence* of a DownsampleThreshold here, unlike Email above.
      // Ghostscript's 1.5 default means only images past 450 dpi are resampled,
      // so a 350 dpi photo is left exactly as it is. For print that is the
      // point: resampling 350 to 300 costs real quality and saves very little.
    ],
    // 0.15 ≈ Adobe's "maximum". The intent behind the original -dJPEGQ=95.
    distiller: distiller(0.15),
  },
];

export const DEFAULT_PRESET = "email";

export function presetById(id) {
  return PRESETS.find((p) => p.id === id) ||
         PRESETS.find((p) => p.id === DEFAULT_PRESET);
}
