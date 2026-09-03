// Minimal, dependency-free QR Code encoder (Node, CommonJS).
//
// Same reasoning as lib/ws-lite.js next to this file: the build sandbox has
// no npm registry access (`npm install qrcode` gets a hard 403), so a real
// QR library isn't an option there — and pulling one from a CDN at runtime
// isn't either, since the whole point of this file is to generate the QR
// image SERVER-SIDE (see server.js's /qr/<code>.svg route) so neither the
// TV nor the phone needs to fetch anything external to show or scan it.
//
// Scope, deliberately narrow to keep this both correct and small:
//   - byte mode only (the room-join URL has lowercase letters and
//     punctuation outside QR's restricted "alphanumeric" charset, so byte
//     mode is required anyway)
//   - versions 1-6 only, error-correction level M
//   - no version-info blocks (only required from version 7 up) — capped at
//     version 6 specifically to avoid needing that extra BCH code path
// Version 6 at level M holds 108 data codewords (~105 usable bytes after
// mode/length/terminator overhead), comfortably more than any join URL this
// project produces (an onrender.com host + a 6-digit code is ~55 chars).
//
// Verified against an independent decoder (OpenCV's QRCodeDetector,
// checked by rendering this module's SVG output and decoding it back to
// the original string) rather than only against hand-checked math — see
// /tmp/mr_test_qr_join.js.
'use strict';

// ---------------------------------------------------------------------
// GF(256) arithmetic (primitive polynomial 0x11D, matching the QR spec)
// ---------------------------------------------------------------------
const GF_EXP = new Array(512);
const GF_LOG = new Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();
function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

// ---------------------------------------------------------------------
// Reed-Solomon error-correction codeword generation
// ---------------------------------------------------------------------
function polyMul(a, b) {
  const result = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      result[i + j] ^= gfMul(a[i], b[j]);
    }
  }
  return result;
}
function rsGeneratorPoly(degree) {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    g = polyMul(g, [1, GF_EXP[i]]);
  }
  return g;
}
function rsEncode(dataCodewords, ecLen) {
  const generator = rsGeneratorPoly(ecLen);
  const msg = dataCodewords.concat(new Array(ecLen).fill(0));
  for (let i = 0; i < dataCodewords.length; i++) {
    const coef = msg[i];
    if (coef !== 0) {
      for (let j = 0; j < generator.length; j++) {
        msg[i + j] ^= gfMul(generator[j], coef);
      }
    }
  }
  return msg.slice(dataCodewords.length);
}

// ---------------------------------------------------------------------
// Per-version tables (level M only) — ISO/IEC 18004 Table 9 / Table 7,
// restricted to versions 1-6.
// ---------------------------------------------------------------------
// blocks: [count, dataCodewordsPerBlock] — a single group for every
// version in this range at level M, so no group interleaving is needed.
const VERSION_TABLE = {
  1: { totalCodewords: 26, ecPerBlock: 10, blocks: [[1, 16]] },
  2: { totalCodewords: 44, ecPerBlock: 16, blocks: [[1, 28]] },
  3: { totalCodewords: 70, ecPerBlock: 26, blocks: [[1, 44]] },
  4: { totalCodewords: 100, ecPerBlock: 18, blocks: [[2, 32]] },
  5: { totalCodewords: 134, ecPerBlock: 24, blocks: [[2, 43]] },
  6: { totalCodewords: 172, ecPerBlock: 16, blocks: [[4, 27]] },
};
const ALIGNMENT_POSITIONS = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
};
// Sanity-check the table above once at load time (count*dataLen + count*ec
// must equal totalCodewords) — cheap, and catches a typo instantly instead
// of producing a subtly-wrong QR code.
(function checkTables() {
  for (const v of Object.keys(VERSION_TABLE)) {
    const t = VERSION_TABLE[v];
    let sum = 0;
    for (const [count, dataLen] of t.blocks) sum += count * (dataLen + t.ecPerBlock);
    if (sum !== t.totalCodewords) {
      throw new Error(`qrcode-lite: version ${v} table is inconsistent (${sum} != ${t.totalCodewords})`);
    }
  }
})();

const EC_LEVEL_BITS = 0; // 'M' — see the format-info comment below for the bit mapping

function dataCodewordCapacity(version) {
  const t = VERSION_TABLE[version];
  return t.blocks.reduce((sum, [count, dataLen]) => sum + count * dataLen, 0);
}

// ---------------------------------------------------------------------
// 1. Build the codeword sequence (mode + length + bytes + padding),
//    split into blocks, add Reed-Solomon error-correction codewords, and
//    interleave.
// ---------------------------------------------------------------------
function chooseVersion(byteLen) {
  // Mode (4 bits) + byte-mode length indicator (8 bits, valid for
  // versions 1-9) + payload bytes + up to a 4-bit terminator, rounded up
  // to whole codewords.
  const overheadBits = 4 + 8;
  for (let v = 1; v <= 6; v++) {
    const capacityBits = dataCodewordCapacity(v) * 8;
    if (overheadBits + byteLen * 8 <= capacityBits) return v;
  }
  return null; // caller decides how to handle "too long for this encoder"
}

function buildCodewords(version, bytes) {
  const capacity = dataCodewordCapacity(version);
  const bits = [];
  const pushBits = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  pushBits(0b0100, 4); // byte-mode indicator
  pushBits(bytes.length, 8); // char-count indicator (8 bits for v1-9 byte mode)
  for (const b of bytes) pushBits(b, 8);

  // Terminator (up to 4 zero bits) then pad to a byte boundary.
  for (let i = 0; i < 4 && bits.length < capacity * 8; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  // Pad codewords, alternating the two standard filler bytes, until the
  // version's full data capacity is used.
  const PAD = [0xec, 0x11];
  let p = 0;
  while (codewords.length < capacity) codewords.push(PAD[p++ % 2]);
  return codewords;
}

function interleave(version, dataCodewords) {
  const t = VERSION_TABLE[version];
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (const [count, dataLen] of t.blocks) {
    for (let i = 0; i < count; i++) {
      const block = dataCodewords.slice(offset, offset + dataLen);
      offset += dataLen;
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, t.ecPerBlock));
    }
  }
  const out = [];
  const maxDataLen = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < t.ecPerBlock; i++) {
    for (const block of ecBlocks) out.push(block[i]);
  }
  return out;
}

// ---------------------------------------------------------------------
// 2. Module grid construction (finder/timing/alignment patterns, data
//    placement, masking, format info) — mirrors the standard reference
//    algorithm for laying out a QR symbol (see e.g. Project Nayuki's
//    widely-published from-scratch QR generator for the same structure).
// ---------------------------------------------------------------------
function buildMatrix(version, codewords) {
  const size = 17 + 4 * version;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));

  function setFn(x, y, dark) {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    modules[y][x] = !!dark;
    isFunction[y][x] = true;
  }

  function drawFinder(cx, cy) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        setFn(cx + dx, cy + dy, dist !== 2 && dist !== 4);
      }
    }
  }
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);

  function drawAlignment(cx, cy) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  const positions = ALIGNMENT_POSITIONS[version];
  for (const r of positions) {
    for (const c of positions) {
      const nearFinder =
        (r < 9 && c < 9) || (r < 9 && c > size - 9) || (r > size - 9 && c < 9);
      if (!nearFinder) drawAlignment(c, r);
    }
  }

  for (let i = 8; i < size - 8; i++) {
    setFn(6, i, i % 2 === 0); // vertical timing
    setFn(i, 6, i % 2 === 0); // horizontal timing
  }

  setFn(8, size - 8, true); // fixed dark module

  // Reserve the two format-info areas (real bits are written after the
  // best mask is chosen) so data placement below skips over them.
  for (let i = 0; i <= 5; i++) setFn(8, i, false);
  setFn(8, 7, false);
  setFn(8, 8, false);
  setFn(7, 8, false);
  for (let i = 9; i < 15; i++) setFn(14 - i, 8, false);
  for (let i = 0; i <= 7; i++) setFn(size - 1 - i, 8, false);
  for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, false);

  // Data placement: columns in pairs, right to left, skipping the
  // vertical timing column, alternating scan direction each column-pair.
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  const getBit = (byteIdx, bitPos) => (codewords[byteIdx] >>> bitPos) & 1;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x]) {
          let bit = 0;
          if (bitIndex < totalBits) {
            bit = getBit(bitIndex >>> 3, 7 - (bitIndex & 7));
            bitIndex++;
          }
          modules[y][x] = !!bit;
        }
      }
    }
  }

  return { size, modules, isFunction };
}

const MASK_FNS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(grid, maskIndex) {
  const { size, modules, isFunction } = grid;
  const out = modules.map((row) => row.slice());
  const fn = MASK_FNS[maskIndex];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!isFunction[y][x] && fn(x, y)) out[y][x] = !out[y][x];
    }
  }
  return out;
}

// Penalty rules 1, 2 and 4 from the spec (runs of 5+, 2x2 blocks, and dark
// -module proportion). Rule 3 (finder-like 1:1:3:1:1 patterns) is skipped —
// it only affects which mask is picked as "best", never whether the result
// is a valid, scannable code, so leaving it out trades a little mask
// optimality for materially less code and risk.
function penalty(size, modules) {
  let total = 0;
  for (let y = 0; y < size; y++) {
    let run = 1;
    for (let x = 1; x < size; x++) {
      if (modules[y][x] === modules[y][x - 1]) run++;
      else { if (run >= 5) total += 3 + (run - 5); run = 1; }
    }
    if (run >= 5) total += 3 + (run - 5);
  }
  for (let x = 0; x < size; x++) {
    let run = 1;
    for (let y = 1; y < size; y++) {
      if (modules[y][x] === modules[y - 1][x]) run++;
      else { if (run >= 5) total += 3 + (run - 5); run = 1; }
    }
    if (run >= 5) total += 3 + (run - 5);
  }
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = modules[y][x];
      if (modules[y][x + 1] === v && modules[y + 1][x] === v && modules[y + 1][x + 1] === v) total += 3;
    }
  }
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (modules[y][x]) dark++;
  const percent = (dark * 100) / (size * size);
  total += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return total;
}

// BCH(15,5) format-info bits — generator 0x537, mask 0x5412 — the standard
// reference computation (this specific shift/XOR loop is the well-known
// compact form of the BCH division, equivalent to the textbook long-hand
// polynomial division over GF(2)).
function formatBits(ecLevel, mask) {
  const data = (ecLevel << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function writeFormatInfo(grid, bits) {
  const { size } = grid;
  const setFn = (x, y, dark) => { grid.modules[y][x] = dark; };
  const bit = (i) => ((bits >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i++) setFn(8, i, bit(i));
  setFn(8, 7, bit(6));
  setFn(8, 8, bit(7));
  setFn(7, 8, bit(8));
  for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(i));
  for (let i = 0; i <= 7; i++) setFn(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(i));
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------
function encode(text) {
  const bytes = Array.from(Buffer.from(String(text), 'utf8'));
  const version = chooseVersion(bytes.length);
  if (!version) throw new Error(`qrcode-lite: text too long to encode (${bytes.length} bytes, max version 6/level M)`);
  const dataCodewords = buildCodewords(version, bytes);
  const allCodewords = interleave(version, dataCodewords);
  const grid = buildMatrix(version, allCodewords);

  let best = null;
  for (let m = 0; m < 8; m++) {
    const masked = applyMask(grid, m);
    const score = penalty(grid.size, masked);
    if (!best || score < best.score) best = { mask: m, modules: masked, score };
  }
  const finalGrid = { size: grid.size, modules: best.modules, isFunction: grid.isFunction };
  writeFormatInfo(finalGrid, formatBits(EC_LEVEL_BITS, best.mask));

  return { size: finalGrid.size, modules: finalGrid.modules };
}

// Renders an SVG string: a white quiet-zone background with dark modules
// on top. `moduleSize` is in SVG user units (1 unit == 1 module).
function toSVG(text, opts) {
  const options = opts || {};
  const quiet = options.quiet != null ? options.quiet : 4;
  const dark = options.dark || '#0b1220';
  const light = options.light || '#ffffff';
  const { size, modules } = encode(text);
  const dim = size + quiet * 2;
  let path = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) path += `M${x + quiet},${y + quiet}h1v1h-1z`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/>` +
    `</svg>`
  );
}

module.exports = { encode, toSVG };
