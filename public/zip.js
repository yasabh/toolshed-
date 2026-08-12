// A minimal ZIP writer, so "Download selected" is one file instead of twenty
// clicks — built here rather than pulled in, because a dependency for this would
// be larger than this.
//
// Entries are **stored, not deflated**. A compressed PDF does not compress
// again: deflating one spends CPU to save a percent or two, and the whole point
// of doing this in the browser is that the browser is the one paying.
//
// No ZIP64. The offsets below are 32-bit, so this tops out at 4 GB — which
// ShrinkPDF cannot reach, since it caps a batch at 20 files of 100 MB. If either
// cap is ever raised past that, this needs ZIP64 or it will write a corrupt
// archive rather than fail.

// CRC-32, table-driven. The table is built once; doing it per byte is what makes
// a hand-written CRC feel slow.
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// MS-DOS date and time, which is what ZIP stores. Seconds have 2-second
// resolution in this format; that is the format's limitation, not a rounding
// choice.
function dosStamp(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/**
 * Build a zip from [{ name, bytes }].
 *
 * Names are used as written — callers pass names they built themselves, and this
 * never touches the filesystem, so there is no path to traverse.
 */
export function makeZip(entries, now = new Date()) {
  const encoder = new TextEncoder();
  const { time, day } = dosStamp(now);

  const parts = [];
  const central = [];
  let offset = 0;

  for (const { name, bytes } of entries) {
    const nameBytes = encoder.encode(name);
    const crc = crc32(bytes);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);   // local file header
    local.setUint16(4, 20, true);           // version needed
    // Bit 11 says the name is UTF-8. Without it a name with an accent in it
    // arrives mangled in Windows Explorer.
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true);            // stored
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, bytes.length, true);
    local.setUint32(22, bytes.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);           // no extra field

    parts.push(new Uint8Array(local.buffer), nameBytes, bytes);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);   // central directory header
    entry.setUint16(4, 20, true);           // version made by
    entry.setUint16(6, 20, true);           // version needed
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, time, true);
    entry.setUint16(14, day, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, bytes.length, true);
    entry.setUint32(24, bytes.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);      // where the local header sits
    central.push(new Uint8Array(entry.buffer), nameBytes);

    offset += 30 + nameBytes.length + bytes.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);       // end of central directory
  end.setUint16(8, entries.length, true);   // entries on this disk
  end.setUint16(10, entries.length, true);  // entries in total
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);          // where the central directory starts

  return new Blob([...parts, ...central, new Uint8Array(end.buffer)],
                  { type: "application/zip" });
}
