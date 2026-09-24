// DDS -> RGBA decoding and a minimal PNG encoder, so the extract tool needs no
// ffmpeg or other system dependency - just Deno.
//
// Covers what Living Marine Aquarium 2 ships: DXT1, DXT3, DXT5 and uncompressed
// 32-bit (any channel masks). Only the top mip level is decoded; three.js
// regenerates mips on upload.

export interface Image {
  width: number;
  height: number;
  /** Row-major RGBA, 8 bits per channel, straight (not premultiplied) alpha. */
  rgba: Uint8Array;
  format: string;
}

const DDPF_ALPHAPIXELS = 0x1;
const DDPF_FOURCC = 0x4;

export function decodeDDS(file: Uint8Array): Image {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (dv.getUint32(0, true) !== 0x20534444) throw new Error("not a DDS file"); // "DDS "
  const height = dv.getUint32(12, true);
  const width = dv.getUint32(16, true);
  const pfFlags = dv.getUint32(80, true);
  const fourCC = String.fromCharCode(file[84], file[85], file[86], file[87]);
  const data = file.subarray(128);

  if (pfFlags & DDPF_FOURCC) {
    if (fourCC === "DXT1") return { width, height, format: fourCC, rgba: decodeBlocks(data, width, height, 8, dxt1Block) };
    if (fourCC === "DXT3") return { width, height, format: fourCC, rgba: decodeBlocks(data, width, height, 16, dxt3Block) };
    if (fourCC === "DXT5") return { width, height, format: fourCC, rgba: decodeBlocks(data, width, height, 16, dxt5Block) };
    throw new Error(`unsupported DDS fourCC ${JSON.stringify(fourCC)}`);
  }

  const bits = dv.getUint32(88, true);
  if (bits !== 32 && bits !== 24) throw new Error(`unsupported uncompressed DDS: ${bits} bpp`);
  const masks = [dv.getUint32(92, true), dv.getUint32(96, true), dv.getUint32(100, true), pfFlags & DDPF_ALPHAPIXELS ? dv.getUint32(104, true) : 0];
  return { width, height, format: `RGB${bits}`, rgba: decodeMasked(data, width, height, bits / 8, masks) };
}

// ---------------------------------------------------------------------------
// Block compression
// ---------------------------------------------------------------------------

type BlockFn = (src: Uint8Array, o: number, out: Uint8Array /* 64 bytes: 16 px RGBA */) => void;

function decodeBlocks(src: Uint8Array, w: number, h: number, blockBytes: number, fn: BlockFn): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  const px = new Uint8Array(64);
  const bw = Math.max(1, Math.ceil(w / 4)), bh = Math.max(1, Math.ceil(h / 4));
  let o = 0;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++, o += blockBytes) {
      fn(src, o, px);
      for (let y = 0; y < 4; y++) {
        const py = by * 4 + y;
        if (py >= h) break;
        for (let x = 0; x < 4; x++) {
          const pxX = bx * 4 + x;
          if (pxX >= w) break;
          out.set(px.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4), (py * w + pxX) * 4);
        }
      }
    }
  }
  return out;
}

/** RGB565 -> 8-bit channels, replicating high bits into the low ones. */
function rgb565(c: number): [number, number, number] {
  const r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
}

/**
 * The colour half of every DXT block (8 bytes at src[o]).
 * `allowPunchThrough`: DXT1 switches to 3 colours + transparent when c0 <= c1.
 * DXT3/5 always use four colours.
 */
function colorBlock(src: Uint8Array, o: number, out: Uint8Array, allowPunchThrough: boolean): void {
  const c0 = src[o] | (src[o + 1] << 8);
  const c1 = src[o + 2] | (src[o + 3] << 8);
  const a = rgb565(c0), b = rgb565(c1);
  const pal = new Uint8Array(16);
  pal.set([a[0], a[1], a[2], 255], 0);
  pal.set([b[0], b[1], b[2], 255], 4);
  if (c0 > c1 || !allowPunchThrough) {
    for (let k = 0; k < 3; k++) {
      pal[8 + k] = ((2 * a[k] + b[k]) / 3) | 0;
      pal[12 + k] = ((a[k] + 2 * b[k]) / 3) | 0;
    }
    pal[11] = 255;
    pal[15] = 255;
  } else {
    for (let k = 0; k < 3; k++) pal[8 + k] = ((a[k] + b[k]) / 2) | 0;
    pal[11] = 255;
    pal.set([0, 0, 0, 0], 12); // punch-through transparent
  }
  const bits = (src[o + 4] | (src[o + 5] << 8) | (src[o + 6] << 16) | (src[o + 7] << 24)) >>> 0;
  for (let i = 0; i < 16; i++) {
    const idx = (bits >>> (i * 2)) & 3;
    out.set(pal.subarray(idx * 4, idx * 4 + 4), i * 4);
  }
}

const dxt1Block: BlockFn = (src, o, out) => colorBlock(src, o, out, true);

/** DXT3: 64 bits of explicit 4-bit alpha, then a colour block. */
const dxt3Block: BlockFn = (src, o, out) => {
  colorBlock(src, o + 8, out, false);
  for (let i = 0; i < 16; i++) {
    const nib = (src[o + (i >> 1)] >> ((i & 1) * 4)) & 15;
    out[i * 4 + 3] = nib * 17; // 4-bit -> 8-bit
  }
};

/** DXT5: two alpha endpoints + 48 bits of 3-bit indices, then a colour block. */
const dxt5Block: BlockFn = (src, o, out) => {
  colorBlock(src, o + 8, out, false);
  const a0 = src[o], a1 = src[o + 1];
  const pal = [a0, a1, 0, 0, 0, 0, 0, 0];
  if (a0 > a1) {
    for (let k = 1; k < 7; k++) pal[k + 1] = (((7 - k) * a0 + k * a1) / 7) | 0;
  } else {
    for (let k = 1; k < 5; k++) pal[k + 1] = (((5 - k) * a0 + k * a1) / 5) | 0;
    pal[6] = 0;
    pal[7] = 255;
  }
  // 48-bit index field, little-endian; read as two 24-bit halves.
  const lo = src[o + 2] | (src[o + 3] << 8) | (src[o + 4] << 16);
  const hi = src[o + 5] | (src[o + 6] << 8) | (src[o + 7] << 16);
  for (let i = 0; i < 16; i++) {
    const idx = i < 8 ? (lo >> (i * 3)) & 7 : (hi >> ((i - 8) * 3)) & 7;
    out[i * 4 + 3] = pal[idx];
  }
};

// ---------------------------------------------------------------------------
// Uncompressed
// ---------------------------------------------------------------------------

function decodeMasked(src: Uint8Array, w: number, h: number, bpp: number, masks: number[]): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  const shifts = masks.map(trailingZeros);
  const maxes = masks.map((m, i) => (m ? m >>> shifts[i] : 0));
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
  for (let p = 0; p < w * h; p++) {
    const v = bpp === 4 ? dv.getUint32(p * 4, true) : src[p * 3] | (src[p * 3 + 1] << 8) | (src[p * 3 + 2] << 16);
    for (let c = 0; c < 4; c++) {
      out[p * 4 + c] = masks[c] ? Math.round((((v & masks[c]) >>> shifts[c]) / maxes[c]) * 255) : c === 3 ? 255 : 0;
    }
  }
  return out;
}

function trailingZeros(m: number): number {
  if (!m) return 0;
  let n = 0;
  while (((m >>> n) & 1) === 0) n++;
  return n;
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function zlib(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  // "deflate" here is the zlib container (RFC 1950), which PNG requires.
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Encode straight-alpha RGBA as an 8-bit RGBA PNG. */
export async function encodePNG(width: number, height: number, rgba: Uint8Array): Promise<Uint8Array> {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit, RGBA, deflate, adaptive filtering, no interlace

  // Filter type 1 ("Sub") on every row: cheap, and compresses texture data
  // noticeably better than no filter.
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    raw[row] = 1;
    for (let x = 0; x < stride; x++) {
      const cur = rgba[y * stride + x];
      const left = x >= 4 ? rgba[y * stride + x - 4] : 0;
      raw[row + 1 + x] = (cur - left) & 0xff;
    }
  }

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", await zlib(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
