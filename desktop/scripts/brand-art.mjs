// Draws the small brand images that are not web assets, from the shapes of
// src-tauri/icon.svg (dark rounded square, accent ring, green dot). Pure Node,
// no image library: shapes are rasterised with 8x8 supersampling.
//   - src-tauri/icons/tray/*.png: the tray icon in four voice states (PLAN fase 9D)
//   - src-tauri/installer/logo-*.bmp: the mark on the installer page, per DPI (fase 9B)
//   node desktop/scripts/brand-art.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SS = 8;
const tauri = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src-tauri');

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const BG0 = hex('#0B0C10');
const BG = hex('#111218');
const ACCENT = hex('#8B9CFF');
const OK = hex('#3DDC97');
const DANGER = hex('#FF5C6C');

// Each shape: (x, y) -> inside? Coordinates are in a 32x32 box, scaled at render time.
const B = 32;
const C = B / 2;
const roundedSquare = (r) => (x, y) => {
  const dx = Math.max(r - x, 0, x - (B - r));
  const dy = Math.max(r - y, 0, y - (B - r));
  return dx * dx + dy * dy <= r * r;
};
const disc = (cx, cy, r) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const ring = (cx, cy, r, w) => (x, y) => {
  const d = Math.hypot(x - cx, y - cy);
  return d >= r - w / 2 && d <= r + w / 2;
};

const tray = {
  // Not in voice: the brand ring.
  idle: [[roundedSquare(7), BG], [ring(C, C, 9, 3.4), ACCENT]],
  // In a call, quiet: ring and a green dot.
  voice: [[roundedSquare(7), BG], [ring(C, C, 9, 3.4), ACCENT], [disc(24.5, 24.5, 6.6), BG], [disc(24.5, 24.5, 4.6), OK]],
  // Speaking: the whole ring turns green, a little thicker.
  speaking: [[roundedSquare(7), BG], [ring(C, C, 9, 4.4), OK], [disc(C, C, 3), OK]],
  // Muted or deafened: ring and a red dot.
  muted: [[roundedSquare(7), BG], [ring(C, C, 9, 3.4), ACCENT], [disc(24.5, 24.5, 6.6), BG], [disc(24.5, 24.5, 4.6), DANGER]],
};
// icon.svg at 32/1024: rx 224, ring r 300 / stroke 88, dot r 96.
const mark = [[roundedSquare(7), BG], [ring(C, C, 9.375, 2.75), ACCENT], [disc(C, C, 3), OK]];

/** RGBA pixels of `layers` at `size` px; `under` fills transparent areas (for BMP). */
function render(layers, size, under = null) {
  const k = B / size;
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = (x + (sx + 0.5) / SS) * k;
          const fy = (y + (sy + 0.5) / SS) * k;
          let color = under;
          for (const [inside, c] of layers) if (inside(fx, fy)) color = c;
          if (color) {
            r += color[0];
            g += color[1];
            b += color[2];
            a += 1;
          }
        }
      }
      const i = (y * size + x) * 4;
      if (a > 0) {
        px[i] = Math.round(r / a);
        px[i + 1] = Math.round(g / a);
        px[i + 2] = Math.round(b / a);
      }
      px[i + 3] = Math.round((a * 255) / (SS * SS));
    }
  }
  return px;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 24-bit bottom-up BMP, what the Win32 STATIC control loads. */
function bmp(rgba, size) {
  const stride = Math.ceil((size * 3) / 4) * 4;
  const data = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4;
      const d = (size - 1 - y) * stride + x * 3;
      data[d] = rgba[s + 2];
      data[d + 1] = rgba[s + 1];
      data[d + 2] = rgba[s];
    }
  }
  const head = Buffer.alloc(54);
  head.write('BM', 0, 'ascii');
  head.writeUInt32LE(54 + data.length, 2);
  head.writeUInt32LE(54, 10);
  head.writeUInt32LE(40, 14);
  head.writeInt32LE(size, 18);
  head.writeInt32LE(size, 22);
  head.writeUInt16LE(1, 26);
  head.writeUInt16LE(24, 28);
  head.writeUInt32LE(data.length, 34);
  return Buffer.concat([head, data]);
}

function write(rel, buf) {
  const file = path.join(tauri, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  console.log(rel);
}

for (const [name, layers] of Object.entries(tray)) write(`icons/tray/${name}.png`, png(render(layers, 32), 32));
// 100 %, 150 % and 200 % display scaling.
for (const size of [64, 96, 128]) write(`installer/logo-${size}.bmp`, bmp(render(mark, size, BG0), size));
