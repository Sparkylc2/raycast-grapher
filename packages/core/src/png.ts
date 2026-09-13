import { deflateSync } from "node:zlib";

/**
 * Minimal PNG encoder for the Raycast preview path.
 *
 * Kept out of the package index deliberately: it is the one module that needs
 * Node built-ins, and the viewer bundle must stay free of them. Import it as
 * `@grapher/core/png`.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const tagged = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(tagged));
  return Buffer.concat([length, tagged, crc]);
}

export interface PngOptions {
  /**
   * zlib level. 6 suits a frame that will sit on screen; 1 encodes about three
   * times faster for frames that are replaced within milliseconds anyway.
   */
  readonly level?: number;
}

/** Encodes an RGBA buffer as a PNG. `rgba` must be width * height * 4 bytes. */
export function encodePng(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  options: PngOptions = {},
): Buffer {
  const stride = width * 4;
  // Each scanline is prefixed with its filter byte; 0 means no filtering.
  const raw = Buffer.alloc(height * (stride + 1));
  for (let row = 0; row < height; row++) {
    raw[row * (stride + 1)] = 0;
    raw.set(rgba.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: truecolour with alpha

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: options.level ?? 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
