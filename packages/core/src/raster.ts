import { type Camera2D, bounds2D } from "./camera.js";
import type { Graph } from "./classify.js";
import { compileJs } from "./compile-js.js";

/**
 * CPU rasteriser for the surfaces that cannot run a shader.
 *
 * Raycast draws native components and has no canvas, so anything shown inside
 * the panel is either a pre-rendered image or text. Both start here, as a
 * boolean dot mask over a pixel grid.
 */

export interface RasterSize {
  readonly width: number;
  readonly height: number;
}

/** Evaluates the field once per dot. Row 0 is the top of the image. */
function sampleField(graph: Graph, camera: Camera2D, size: RasterSize): Float64Array {
  const field =
    graph.type === "explicit2d"
      ? (() => {
          const f = compileJs(graph.fn);
          return (x: number, y: number) => y - f(x, 0, 0);
        })()
      : (() => {
          const f = compileJs(graph.type === "surface3d" ? graph.fn : graph.field);
          return (x: number, y: number) => f(x, y, 0);
        })();

  const { width, height } = size;
  const b = bounds2D(camera, width / height);
  const out = new Float64Array(width * height);

  for (let row = 0; row < height; row++) {
    const y = b.maxY - ((row + 0.5) / height) * (b.maxY - b.minY);
    for (let col = 0; col < width; col++) {
      const x = b.minX + ((col + 0.5) / width) * (b.maxX - b.minX);
      out[row * width + col] = field(x, y);
    }
  }
  return out;
}

/**
 * Marks dots where the field changes sign against its right or lower
 * neighbour. This traces the zero set at one-dot width without needing a
 * gradient, and it handles vertical lines and closed curves alike.
 */
function curveMask(values: Float64Array, size: RasterSize): Uint8Array {
  const { width, height } = size;
  const mask = new Uint8Array(width * height);

  const differs = (a: number, b: number): boolean =>
    Number.isFinite(a) && Number.isFinite(b) && a !== 0 && b !== 0 && a < 0 !== b < 0;

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const i = row * width + col;
      const v = values[i]!;
      if (v === 0) {
        mask[i] = 1;
        continue;
      }
      if (col + 1 < width && differs(v, values[i + 1]!)) mask[i] = 1;
      else if (row + 1 < height && differs(v, values[i + width]!)) mask[i] = 1;
    }
  }
  return mask;
}

function regionMask(values: Float64Array, size: RasterSize, stipple: number): Uint8Array {
  const { width, height } = size;
  const mask = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const i = row * width + col;
      // A sparse lattice reads as shading; anything denser turns into a solid
      // block once the Braille cells are packed.
      if (values[i]! < 0 && col % stipple === 0 && row % stipple === 0) mask[i] = 1;
    }
  }
  return mask;
}

export function rasterize(graph: Graph, camera: Camera2D, size: RasterSize): Uint8Array {
  const values = sampleField(graph, camera, size);
  return graph.type === "inequality2d"
    ? regionMask(values, size, 4)
    : curveMask(values, size);
}

/** Dots on the x and y axes, so a text plot still reads as a graph. */
export function axesMask(camera: Camera2D, size: RasterSize): Uint8Array {
  const { width, height } = size;
  const b = bounds2D(camera, width / height);
  const mask = new Uint8Array(width * height);

  const col0 = Math.round(((0 - b.minX) / (b.maxX - b.minX)) * width - 0.5);
  const row0 = Math.round(((b.maxY - 0) / (b.maxY - b.minY)) * height - 0.5);

  if (col0 >= 0 && col0 < width) for (let r = 0; r < height; r++) mask[r * width + col0] = 1;
  if (row0 >= 0 && row0 < height) for (let c = 0; c < width; c++) mask[row0 * width + c] = 1;
  return mask;
}

export function combine(masks: readonly Uint8Array[], size: RasterSize): Uint8Array {
  const out = new Uint8Array(size.width * size.height);
  for (const mask of masks) {
    for (let i = 0; i < out.length; i++) if (mask[i]) out[i] = 1;
  }
  return out;
}

/**
 * Packs the dot mask into Braille characters.
 *
 * Each glyph carries a 2x4 dot cell, so a monospace block of text reaches four
 * times the vertical resolution the character grid alone would give. Raycast
 * renders fenced code blocks in a monospace face, which is the only typographic
 * control an extension has.
 */
const BRAILLE_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const;

export function toBraille(mask: Uint8Array, size: RasterSize): string {
  const { width, height } = size;
  const lines: string[] = [];

  for (let row = 0; row < height; row += 4) {
    let line = "";
    for (let col = 0; col < width; col += 2) {
      let bits = 0;
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const y = row + dy;
          const x = col + dx;
          if (y < height && x < width && mask[y * width + x]) bits |= BRAILLE_BITS[dy]![dx]!;
        }
      }
      // U+2800 is blank Braille; adding the bit pattern selects the raised dots.
      line += String.fromCharCode(0x2800 + bits);
    }
    lines.push(line.replace(/⠀+$/, ""));
  }
  return lines.join("\n");
}

/** Character-grid size needed for a Braille block of the given dot size. */
export const brailleCells = (size: RasterSize): RasterSize => ({
  width: Math.ceil(size.width / 2),
  height: Math.ceil(size.height / 4),
});
