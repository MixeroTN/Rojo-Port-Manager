// Draws media/icon.png (128 x 128): a port panel with three sockets, one of them plugged in, on a dark rounded square.
// The shapes are the ones of media/view.svg (the view icon), in its 16 x 16 units.
// Run it only when the icon changes: `npm run icon`.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SAMPLES = 4; // supersampling per axis, for smooth edges

// The shapes in the 16 x 16 units of media/view.svg.
const BODY = { x0: 1.5, y0: 3.5, x1: 14.5, y1: 10.5, radius: 1.5, width: 1.3 };
const SOCKETS = [4.75, 8, 11.25].map((x) => ({ x, y: 7, half: 1, radius: 0.35 }));
const CABLE = { x: 4.75, y0: 8, y1: 14.5, width: 1.6 };

/** Signed distance to a rounded rectangle (negative inside). */
function roundedRect(x, y, x0, y0, x1, y1, radius) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const qx = Math.abs(x - cx) - ((x1 - x0) / 2 - radius);
  const qy = Math.abs(y - cy) - ((y1 - y0) / 2 - radius);

  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function onBody(x, y) {
  return Math.abs(roundedRect(x, y, BODY.x0, BODY.y0, BODY.x1, BODY.y1, BODY.radius)) <= BODY.width / 2;
}

function inSocket(x, y, socket) {
  return (
    roundedRect(
      x,
      y,
      socket.x - socket.half,
      socket.y - socket.half,
      socket.x + socket.half,
      socket.y + socket.half,
      socket.radius,
    ) <= 0
  );
}

function onCable(x, y) {
  const cy = Math.min(Math.max(y, CABLE.y0), CABLE.y1);

  return Math.hypot(x - CABLE.x, y - cy) <= CABLE.width / 2;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }

  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));

  return Buffer.concat([length, body, crc]);
}

/** Renders a square PNG; `color(x, y)` returns [r, g, b] or null (transparent) for a point in pixel units. */
function render(size, color) {
  const pixels = Buffer.alloc(size * (size * 4 + 1));

  for (let y = 0; y < size; y += 1) {
    pixels[y * (size * 4 + 1)] = 0; // filter: none

    for (let x = 0; x < size; x += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let covered = 0;

      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const sample = color(x + (sx + 0.5) / SAMPLES, y + (sy + 0.5) / SAMPLES);
          if (sample) {
            red += sample[0];
            green += sample[1];
            blue += sample[2];
            covered += 1;
          }
        }
      }

      const offset = y * (size * 4 + 1) + 1 + x * 4;
      pixels[offset] = covered ? Math.round(red / covered) : 0;
      pixels[offset + 1] = covered ? Math.round(green / covered) : 0;
      pixels[offset + 2] = covered ? Math.round(blue / covered) : 0;
      pixels[offset + 3] = Math.round((covered / (SAMPLES * SAMPLES)) * 255);
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const GREEN = [63, 185, 80];
const LIGHT = [219, 228, 238];
const GREY = [139, 152, 168];

// The extension icon: the mark at 6 px per unit (96 px), centred on a rounded square with a vertical gradient.
const SIZE = 128;
const icon = render(SIZE, (x, y) => {
  if (roundedRect(x, y, 2, 2, SIZE - 2, SIZE - 2, 26) > 0) {
    return null;
  }

  const ux = (x - 16) / 6;
  const uy = (y - 16) / 6;

  if (onCable(ux, uy) || inSocket(ux, uy, SOCKETS[0])) {
    return GREEN;
  }

  if (SOCKETS.slice(1).some((socket) => inSocket(ux, uy, socket))) {
    return GREY;
  }

  if (onBody(ux, uy)) {
    return LIGHT;
  }

  const t = y / SIZE;
  return [30 + (14 - 30) * t, 42 + (20 - 42) * t, 58 + (29 - 58) * t];
});

writeFileSync(new URL('../media/icon.png', import.meta.url), icon);
console.log(`media/icon.png: ${icon.length} bytes`);
