import { type Camera2D, bounds2D } from "./camera.js";
import type { Graph } from "./classify.js";
import { compileJs } from "./compile-js.js";
import { GLYPH_HEIGHT, drawText, textHeight, textWidth } from "./font.js";
import type { RasterSize } from "./raster.js";
import { type GraphTheme, type RGB, DEFAULT_THEME, hexToRgb } from "./theme.js";
import type { Typeface } from "./typeface.js";

/**
 * Antialiased colour rasteriser, the CPU twin of the viewer's fragment shader.
 *
 * It finds curves the same way the GPU does, by dividing the field value by its
 * screen-space gradient to get a distance in pixels. Here the gradient comes
 * from central differences over the sampled grid instead of dFdx/dFdy, so the
 * two paths produce the same picture and a Raycast still matches the window.
 */

export interface RenderLayer {
  readonly graph: Graph;
  /** Hex, as stored in the scene; converted once per frame. */
  readonly color: string;
}

export interface RenderOptions {
  /** Leave the ground transparent so the host surface shows through. */
  readonly transparent?: boolean;
  /**
   * Device pixels per display pixel. Line widths, label size and grid spacing
   * are all specified in display pixels and scaled by this, so a 1x draft and a
   * 2x refinement of the same view look identical apart from sharpness.
   */
  readonly pixelRatio?: number;
  /** Height of tick label figures in display pixels. */
  readonly labelSize?: number;
  /** Outline font for tick labels. Without one, labels fall back to the bitmap font. */
  readonly typeface?: Typeface;
}

/** Theme colours resolved to channels, so the pixel loops never parse hex. */
interface Palette {
  readonly background: RGB;
  readonly grid: RGB;
  readonly axis: RGB;
  readonly text: RGB;
}

interface Bounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

/** Gridline spacing that keeps at least `targetPx` between minor lines. */
export function niceStep(span: number, pixels: number, targetPx = 70): number {
  const target = (span / Math.max(pixels, 1)) * targetPx;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const norm = target / magnitude;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * magnitude;
}

/** Formats a tick so the label never shows more precision than the step implies. */
export function formatTick(value: number, step: number): string {
  if (Math.abs(value) < step * 1e-6) return "0";
  const decimals = Math.max(0, Math.min(6, -Math.floor(Math.log10(step))));
  const text = value.toFixed(decimals);
  return Math.abs(value) >= 1e6 || (Math.abs(value) < 1e-4 && value !== 0)
    ? value.toExponential(1).replace("+", "")
    : text;
}

class Canvas {
  readonly data: Uint8ClampedArray;

  constructor(
    readonly width: number,
    readonly height: number,
    background: RGB | null,
  ) {
    this.data = new Uint8ClampedArray(width * height * 4);
    if (!background) return;
    for (let i = 0; i < width * height; i++) {
      this.data[i * 4] = background[0];
      this.data[i * 4 + 1] = background[1];
      this.data[i * 4 + 2] = background[2];
      this.data[i * 4 + 3] = 255;
    }
  }

  /**
   * Straight-alpha "source over". Against an opaque destination this reduces to
   * a plain lerp, so one path serves both the painted and transparent grounds.
   */
  blend(x: number, y: number, color: RGB, alpha: number): void {
    if (alpha <= 0 || x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const a = alpha >= 1 ? 1 : alpha;
    const d = this.data;
    const i = (y * this.width + x) * 4;
    const keep = (d[i + 3]! / 255) * (1 - a);
    const out = a + keep;
    d[i] = (color[0] * a + d[i]! * keep) / out;
    d[i + 1] = (color[1] * a + d[i + 1]! * keep) / out;
    d[i + 2] = (color[2] * a + d[i + 2]! * keep) / out;
    d[i + 3] = out * 255;
  }

  /** Vertical line at a fractional pixel position, antialiased across columns. */
  vline(px: number, color: RGB, halfWidth: number, alpha: number): void {
    const from = Math.floor(px - halfWidth - 1);
    const to = Math.ceil(px + halfWidth + 1);
    for (let x = from; x <= to; x++) {
      const cover = Math.max(0, Math.min(1, halfWidth + 0.5 - Math.abs(x + 0.5 - px)));
      if (cover > 0) for (let y = 0; y < this.height; y++) this.blend(x, y, color, cover * alpha);
    }
  }

  hline(py: number, color: RGB, halfWidth: number, alpha: number): void {
    const from = Math.floor(py - halfWidth - 1);
    const to = Math.ceil(py + halfWidth + 1);
    for (let y = from; y <= to; y++) {
      const cover = Math.max(0, Math.min(1, halfWidth + 0.5 - Math.abs(y + 0.5 - py)));
      if (cover > 0) for (let x = 0; x < this.width; x++) this.blend(x, y, color, cover * alpha);
    }
  }
}

/*
 * Compiled closures are cached per graph object. Building a fresh function every
 * frame discarded V8's optimised code just as it warmed up, which starts to cost
 * real time once frames arrive at animation rates. Callers that keep graph
 * objects stable between frames get the benefit.
 */
const fieldCache = new WeakMap<Graph, (x: number, y: number) => number>();
const curveCache = new WeakMap<Graph, (x: number) => number>();

function fieldOf(graph: Graph): (x: number, y: number) => number {
  let field = fieldCache.get(graph);
  if (!field) {
    const f = compileJs(graph.type === "explicit2d" || graph.type === "surface3d" ? graph.fn : graph.field);
    field = graph.type === "explicit2d" ? (x, y) => y - f(x, 0, 0) : (x, y) => f(x, y, 0);
    fieldCache.set(graph, field);
  }
  return field;
}

function curveOf(graph: Graph & { type: "explicit2d" }): (x: number) => number {
  let curve = curveCache.get(graph);
  if (!curve) {
    const f = compileJs(graph.fn);
    curve = (x) => f(x, 0, 0);
    curveCache.set(graph, curve);
  }
  return curve;
}

export function renderScene(
  layers: readonly RenderLayer[],
  camera: Camera2D,
  size: RasterSize,
  theme: GraphTheme = DEFAULT_THEME,
  options: RenderOptions = {},
): Uint8ClampedArray {
  const { width, height } = size;
  const ratio = options.pixelRatio ?? 1;
  const palette: Palette = {
    background: hexToRgb(theme.background),
    grid: hexToRgb(theme.grid),
    axis: hexToRgb(theme.axis),
    text: hexToRgb(theme.text),
  };
  const canvas = new Canvas(width, height, options.transparent ? null : palette.background);
  const b = bounds2D(camera, width / height);

  const toPxX = (x: number): number => ((x - b.minX) / (b.maxX - b.minX)) * width;
  const toPxY = (y: number): number => ((b.maxY - y) / (b.maxY - b.minY)) * height;

  const step = niceStep(b.maxY - b.minY, height / ratio, 45);

  for (let g = Math.ceil(b.minX / step) * step; g <= b.maxX; g += step) {
    canvas.vline(toPxX(g), palette.grid, 0.5 * ratio, isMajor(g, step) ? 0.55 : 0.3);
  }
  for (let g = Math.ceil(b.minY / step) * step; g <= b.maxY; g += step) {
    canvas.hline(toPxY(g), palette.grid, 0.5 * ratio, isMajor(g, step) ? 0.55 : 0.3);
  }

  if (b.minX <= 0 && b.maxX >= 0) canvas.vline(toPxX(0), palette.axis, 0.6 * ratio, 0.9);
  if (b.minY <= 0 && b.maxY >= 0) canvas.hline(toPxY(0), palette.axis, 0.6 * ratio, 0.9);

  const halfWidth = 1.2 * ratio;
  for (const layer of layers) {
    const color = hexToRgb(layer.color);
    if (layer.graph.type === "explicit2d") {
      drawCurve(canvas, curveOf(layer.graph), color, b, halfWidth);
    } else {
      drawField(canvas, layer.graph, color, b, halfWidth);
    }
  }

  // Labels go last so curves never run through them.
  const figureHeight = (options.labelSize ?? 12) * ratio;
  const ink = options.typeface
    ? outlineInk(canvas, options.typeface, figureHeight, ratio, palette)
    : bitmapInk(canvas, figureHeight, ratio, palette);
  drawTicks(canvas, b, step, ratio, ink, toPxX, toPxY);
  return canvas.data;
}

const isMajor = (g: number, step: number): boolean =>
  Math.abs(g / (step * 5) - Math.round(g / (step * 5))) < 1e-6;

/** How tick labels get onto the canvas, independent of which font draws them. */
interface LabelInk {
  /** Visual height of figures, used to centre and space labels. */
  readonly height: number;
  width(text: string): number;
  /** Draws `text` with the top of its figures at `top`, on a knockout in the ground colour. */
  stamp(text: string, x: number, top: number): void;
}

function outlineInk(
  canvas: Canvas,
  typeface: Typeface,
  figureHeight: number,
  ratio: number,
  palette: Palette,
): LabelInk {
  // Size the font so its cap height, which figures share, lands on the requested height.
  const size = figureHeight / typeface.capHeight(1);
  const cap = typeface.capHeight(size);
  const halo = Math.max(1, Math.round(1.5 * ratio));
  return {
    height: cap,
    width: (text) => typeface.measure(typeface.shape(text), size),
    stamp: (text, x, top) => {
      const shaped = typeface.shape(text);
      const baseline = top + cap;
      // On a transparent frame the knockout matches the Raycast background
      // behind it, so a curve or gridline passing under the figures reads as a gap.
      typeface.draw(shaped, x, baseline, size, (px, py, c) => canvas.blend(px, py, palette.background, 0.9 * c), halo);
      typeface.draw(shaped, x, baseline, size, (px, py, c) => canvas.blend(px, py, palette.text, c));
    },
  };
}

function bitmapInk(canvas: Canvas, figureHeight: number, ratio: number, palette: Palette): LabelInk {
  // Bitmap glyphs scale by whole pixels, so round to the nearest multiple of the cell.
  const scale = Math.max(1, Math.round(figureHeight / GLYPH_HEIGHT));
  const halo = Math.max(1, Math.round(ratio));
  return {
    height: textHeight(scale),
    width: (text) => textWidth(text, scale),
    stamp: (text, x, top) => {
      drawText(text, x, top, scale, (px, py) => {
        for (let dy = -halo; dy <= halo; dy++) {
          for (let dx = -halo; dx <= halo; dx++) canvas.blend(px + dx, py + dy, palette.background, 0.85);
        }
      });
      drawText(text, x, top, scale, (px, py) => canvas.blend(px, py, palette.text, 1));
    },
  };
}

/** Smallest multiple of the grid step whose labels will not touch their neighbours. */
function labelStepFor(step: number, pxPerUnit: number, needPx: number): number {
  for (const m of [1, 2, 5, 10, 20, 50]) {
    if (step * m * pxPerUnit >= needPx) return step * m;
  }
  return step * 100;
}

function drawTicks(
  canvas: Canvas,
  b: Bounds,
  step: number,
  ratio: number,
  ink: LabelInk,
  toPxX: (x: number) => number,
  toPxY: (y: number) => number,
): void {
  const pad = 4 * ratio;
  const gap = 10 * ratio;
  const pxPerUnitX = canvas.width / (b.maxX - b.minX);
  const pxPerUnitY = canvas.height / (b.maxY - b.minY);

  // Labels hug the axis when it is on screen, otherwise they pin to the edge.
  const baseY = Math.min(Math.max(toPxY(0) + pad, pad), canvas.height - ink.height - pad);
  const baseX = Math.min(Math.max(toPxX(0) + pad, pad), canvas.width - pad);

  const widest = Math.max(ink.width(formatTick(b.minX, step)), ink.width(formatTick(b.maxX, step)));
  const xStep = labelStepFor(step, pxPerUnitX, widest + gap);
  for (let g = Math.ceil(b.minX / xStep) * xStep; g <= b.maxX; g += xStep) {
    if (Math.abs(g) < xStep * 1e-6) continue;
    const label = formatTick(g, xStep);
    ink.stamp(label, toPxX(g) - ink.width(label) / 2, baseY);
  }

  const yStep = labelStepFor(step, pxPerUnitY, ink.height + gap);
  for (let g = Math.ceil(b.minY / yStep) * yStep; g <= b.maxY; g += yStep) {
    if (Math.abs(g) < yStep * 1e-6) continue;
    const label = formatTick(g, yStep);
    // Keep y labels on canvas when the axis sits at the right edge.
    const x = Math.min(baseX, canvas.width - ink.width(label) - pad);
    ink.stamp(label, x, toPxY(g) - ink.height / 2);
  }
}

/**
 * Fast path for y = f(x). The field y - f(x) has the same value and gradient
 * as the general path computes, but f only needs evaluating once per column,
 * and only the rows within reach of the curve need touching.
 */
function drawCurve(
  canvas: Canvas,
  f: (x: number) => number,
  color: RGB,
  b: Bounds,
  halfWidth: number,
): void {
  const { width, height } = canvas;
  const fx = new Float64Array(width);
  for (let col = 0; col < width; col++) {
    fx[col] = f(b.minX + ((col + 0.5) / width) * (b.maxX - b.minX));
  }

  const unitsPerRow = (b.maxY - b.minY) / height;
  const reach = halfWidth + 1;

  for (let col = 0; col < width; col++) {
    const v0 = fx[col]!;
    if (!Number.isFinite(v0)) continue;

    // Same central difference as the general path, one-sided at the borders.
    const l = col > 0 ? fx[col - 1]! : v0;
    const r = col + 1 < width ? fx[col + 1]! : v0;
    const gx = (r - l) / (col > 0 && col + 1 < width ? 2 : 1);
    const grad = Math.sqrt(gx * gx + unitsPerRow * unitsPerRow);
    if (!Number.isFinite(grad) || grad < 1e-300) continue;

    // Rows where |y - f(x)| / grad < reach.
    const band = reach * grad;
    const rowLo = Math.max(0, Math.floor((b.maxY - (v0 + band)) / unitsPerRow - 0.5));
    const rowHi = Math.min(height - 1, Math.ceil((b.maxY - (v0 - band)) / unitsPerRow - 0.5));

    for (let row = rowLo; row <= rowHi; row++) {
      const y = b.maxY - (row + 0.5) * unitsPerRow;
      const alpha = 1 - smoothstep(halfWidth - 1, halfWidth + 1, Math.abs(y - v0) / grad);
      canvas.blend(col, row, color, alpha);
    }
  }
}

function drawField(canvas: Canvas, graph: Graph, color: RGB, b: Bounds, halfWidth: number): void {
  const { width, height } = canvas;
  const field = fieldOf(graph);
  const values = new Float64Array(width * height);

  for (let row = 0; row < height; row++) {
    const y = b.maxY - ((row + 0.5) / height) * (b.maxY - b.minY);
    for (let col = 0; col < width; col++) {
      const x = b.minX + ((col + 0.5) / width) * (b.maxX - b.minX);
      values[row * width + col] = field(x, y);
    }
  }

  const region = graph.type === "inequality2d";
  const strict = graph.type === "inequality2d" && graph.strict;

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const i = row * width + col;
      const v = values[i]!;
      if (!Number.isFinite(v)) continue;

      // Central differences, falling back to one-sided at the borders.
      const gx =
        (values[i + (col + 1 < width ? 1 : 0)]! - values[i - (col > 0 ? 1 : 0)]!) /
        (col > 0 && col + 1 < width ? 2 : 1);
      const gy =
        (values[i + (row + 1 < height ? width : 0)]! - values[i - (row > 0 ? width : 0)]!) /
        (row > 0 && row + 1 < height ? 2 : 1);
      // Math.hypot guards against overflow that cannot arise here, and it is
      // several times slower than the direct form on this hot path.
      const grad = Math.sqrt(gx * gx + gy * gy);
      if (!Number.isFinite(grad) || grad < 1e-300) continue;

      const signed = v / grad;
      if (region) {
        const inside = 1 - smoothstep(-1, 1, signed);
        const edge = strict ? 0 : 1 - smoothstep(halfWidth - 1, halfWidth + 1, Math.abs(signed));
        canvas.blend(col, row, color, Math.max(inside * 0.22, edge));
      } else {
        const alpha = 1 - smoothstep(halfWidth - 1, halfWidth + 1, Math.abs(signed));
        canvas.blend(col, row, color, alpha);
      }
    }
  }
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
