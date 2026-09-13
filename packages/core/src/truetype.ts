import type { OutlineFont, PathCommand } from "./typeface.js";

/**
 * Just enough TrueType to draw tick labels.
 *
 * Raycast caps each command's JavaScript heap at 100 MB. SF Pro is a variable
 * font whose file is 8.3 MB, 7.2 MB of it variation deltas, and a general font
 * parser turns those into objects that alone exceed the cap. Labels need a
 * dozen glyphs at one weight, so this reads only outlines, metrics and the
 * character map, a few hundred kilobytes, and leaves variation and layout
 * tables untouched. Glyphs come out at the font's default instance.
 */

/** The tables this reader needs. Callers should load these and nothing else. */
export const TRUETYPE_TABLES: readonly string[] = ["head", "hhea", "maxp", "hmtx", "loca", "glyf", "cmap", "OS/2"];

/** Affine transform in font units: x' = a·x + c·y + e, y' = b·x + d·y + f. */
type Affine = readonly [a: number, b: number, c: number, d: number, e: number, f: number];

interface Point {
  readonly x: number;
  readonly y: number;
  readonly on: boolean;
}

const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];
const MAX_COMPOSITE_DEPTH = 8;

export class TrueTypeFont implements OutlineFont {
  readonly unitsPerEm: number;
  readonly tables: { readonly os2?: { readonly sCapHeight?: number } };
  private readonly numHMetrics: number;
  private readonly longLoca: boolean;
  private readonly hmtx: DataView;
  private readonly loca: DataView;
  private readonly glyf: DataView;
  private readonly glyphFor: (codePoint: number) => number;

  constructor(tables: Readonly<Record<string, Uint8Array>>) {
    const view = (tag: string): DataView => {
      const bytes = tables[tag];
      if (!bytes) throw new Error(`Font is missing its ${tag} table`);
      return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    };
    const head = view("head");
    this.unitsPerEm = head.getUint16(18);
    this.longLoca = head.getInt16(50) === 1;
    this.numHMetrics = view("hhea").getUint16(34);
    this.hmtx = view("hmtx");
    this.loca = view("loca");
    this.glyf = view("glyf");
    this.glyphFor = readCmap(view("cmap"));

    // sCapHeight arrived in OS/2 version 2; older fonts fall back to an estimate downstream.
    const os2 = tables["OS/2"];
    const os2View = os2 ? new DataView(os2.buffer, os2.byteOffset, os2.byteLength) : null;
    this.tables =
      os2View && os2View.byteLength >= 90 && os2View.getUint16(0) >= 2
        ? { os2: { sCapHeight: os2View.getInt16(88) } }
        : {};
  }

  charToGlyph(char: string): { readonly index: number } {
    return { index: this.glyphFor(char.codePointAt(0) ?? 0) };
  }

  getAdvanceWidth(text: string, fontSize: number): number {
    let width = 0;
    for (const char of text) width += this.advanceOf(this.glyphFor(char.codePointAt(0) ?? 0));
    return (width * fontSize) / this.unitsPerEm;
  }

  /** Outline of `text` in pixels, y pointing down, pen starting at (x, y) on the baseline. */
  getPath(text: string, x: number, y: number, fontSize: number): { readonly commands: readonly PathCommand[] } {
    const scale = fontSize / this.unitsPerEm;
    const commands: PathCommand[] = [];
    let pen = x;
    for (const char of text) {
      const glyph = this.glyphFor(char.codePointAt(0) ?? 0);
      this.appendGlyph(glyph, IDENTITY, (px, py) => ({ x: pen + px * scale, y: y - py * scale }), commands, 0);
      pen += this.advanceOf(glyph) * scale;
    }
    return { commands };
  }

  private advanceOf(glyph: number): number {
    // Glyphs past the last full metric share its advance, per the hmtx format.
    const index = Math.min(glyph, this.numHMetrics - 1);
    return this.hmtx.getUint16(index * 4);
  }

  private glyphRange(glyph: number): [number, number] {
    if (this.longLoca) {
      if ((glyph + 1) * 4 + 4 > this.loca.byteLength) return [0, 0];
      return [this.loca.getUint32(glyph * 4), this.loca.getUint32((glyph + 1) * 4)];
    }
    if ((glyph + 1) * 2 + 2 > this.loca.byteLength) return [0, 0];
    return [this.loca.getUint16(glyph * 2) * 2, this.loca.getUint16((glyph + 1) * 2) * 2];
  }

  private appendGlyph(
    glyph: number,
    transform: Affine,
    toPixels: (x: number, y: number) => { x: number; y: number },
    out: PathCommand[],
    depth: number,
  ): void {
    const [start, end] = this.glyphRange(glyph);
    // An empty range is a legitimate blank glyph, such as a space.
    if (end <= start || end > this.glyf.byteLength) return;

    const g = this.glyf;
    const contours = g.getInt16(start);
    let p = start + 10;
    const place = (x: number, y: number): { x: number; y: number } => {
      const [a, b, c, d, e, f] = transform;
      return toPixels(a * x + c * y + e, b * x + d * y + f);
    };

    if (contours >= 0) {
      const endPoints: number[] = [];
      for (let i = 0; i < contours; i++, p += 2) endPoints.push(g.getUint16(p));
      const count = contours > 0 ? endPoints[contours - 1]! + 1 : 0;
      p += 2 + g.getUint16(p); // skip hinting instructions

      const flags = new Uint8Array(count);
      for (let i = 0; i < count; ) {
        const flag = g.getUint8(p++);
        flags[i++] = flag;
        if (flag & 0x08) {
          for (let repeat = g.getUint8(p++); repeat > 0 && i < count; repeat--) flags[i++] = flag;
        }
      }

      const xs = new Float64Array(count);
      for (let i = 0, v = 0; i < count; i++) {
        const flag = flags[i]!;
        if (flag & 0x02) v += flag & 0x10 ? g.getUint8(p++) : -g.getUint8(p++);
        else if (!(flag & 0x10)) (v += g.getInt16(p), (p += 2));
        xs[i] = v;
      }
      const ys = new Float64Array(count);
      for (let i = 0, v = 0; i < count; i++) {
        const flag = flags[i]!;
        if (flag & 0x04) v += flag & 0x20 ? g.getUint8(p++) : -g.getUint8(p++);
        else if (!(flag & 0x20)) (v += g.getInt16(p), (p += 2));
        ys[i] = v;
      }

      let first = 0;
      for (const last of endPoints) {
        const points: Point[] = [];
        for (let i = first; i <= last; i++) {
          const at = place(xs[i]!, ys[i]!);
          points.push({ x: at.x, y: at.y, on: (flags[i]! & 0x01) !== 0 });
        }
        emitContour(points, out);
        first = last + 1;
      }
      return;
    }

    if (depth >= MAX_COMPOSITE_DEPTH) return;

    // Composite glyph: place each component with its own offset and matrix.
    for (let more = true; more; ) {
      const flag = g.getUint16(p);
      const component = g.getUint16(p + 2);
      p += 4;
      const xyValues = (flag & 0x0002) !== 0;
      let arg1: number;
      let arg2: number;
      if (flag & 0x0001) {
        arg1 = xyValues ? g.getInt16(p) : g.getUint16(p);
        arg2 = xyValues ? g.getInt16(p + 2) : g.getUint16(p + 2);
        p += 4;
      } else {
        arg1 = xyValues ? g.getInt8(p) : g.getUint8(p);
        arg2 = xyValues ? g.getInt8(p + 1) : g.getUint8(p + 1);
        p += 2;
      }

      let a = 1;
      let b = 0;
      let c = 0;
      let d = 1;
      if (flag & 0x0008) {
        a = d = f2dot14(g.getInt16(p));
        p += 2;
      } else if (flag & 0x0040) {
        a = f2dot14(g.getInt16(p));
        d = f2dot14(g.getInt16(p + 2));
        p += 4;
      } else if (flag & 0x0080) {
        a = f2dot14(g.getInt16(p));
        b = f2dot14(g.getInt16(p + 2));
        c = f2dot14(g.getInt16(p + 4));
        d = f2dot14(g.getInt16(p + 6));
        p += 8;
      }
      // Point-matched placement is vanishingly rare in UI fonts; treat it as no offset.
      const e = xyValues ? arg1 : 0;
      const f = xyValues ? arg2 : 0;

      const [ta, tb, tc, td, te, tf] = transform;
      const composed: Affine = [
        ta * a + tc * b,
        tb * a + td * b,
        ta * c + tc * d,
        tb * c + td * d,
        ta * e + tc * f + te,
        tb * e + td * f + tf,
      ];
      this.appendGlyph(component, composed, toPixels, out, depth + 1);
      more = (flag & 0x0020) !== 0;
    }
  }
}

const f2dot14 = (value: number): number => value / 16384;

const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true });

/**
 * Turns a TrueType contour into path commands. Two off-curve points in a row
 * imply an on-curve point halfway between them, which is how TrueType stores
 * runs of quadratic curves compactly.
 */
function emitContour(points: readonly Point[], out: PathCommand[]): void {
  const n = points.length;
  if (n === 0) return;

  const firstOn = points.findIndex((pt) => pt.on);
  let start: Point;
  let rest: readonly Point[];
  if (firstOn === -1) {
    // Every point is off-curve: the contour starts at the implied point before the first.
    start = midpoint(points[n - 1]!, points[0]!);
    rest = points;
  } else {
    start = points[firstOn]!;
    rest = [...points.slice(firstOn + 1), ...points.slice(0, firstOn)];
  }

  out.push({ type: "M", x: start.x, y: start.y });
  let control: Point | null = null;
  for (const pt of rest) {
    if (pt.on) {
      if (control) out.push({ type: "Q", x1: control.x, y1: control.y, x: pt.x, y: pt.y });
      else out.push({ type: "L", x: pt.x, y: pt.y });
      control = null;
    } else {
      if (control) {
        const mid = midpoint(control, pt);
        out.push({ type: "Q", x1: control.x, y1: control.y, x: mid.x, y: mid.y });
      }
      control = pt;
    }
  }
  if (control) out.push({ type: "Q", x1: control.x, y1: control.y, x: start.x, y: start.y });
  out.push({ type: "Z" });
}

/** Builds a code point to glyph lookup from the best Unicode subtable present. */
function readCmap(cmap: DataView): (codePoint: number) => number {
  const count = cmap.getUint16(2);
  let chosen = -1;
  let chosenFormat = 0;
  let chosenScore = 0;

  for (let i = 0; i < count; i++) {
    const platform = cmap.getUint16(4 + i * 8);
    const encoding = cmap.getUint16(6 + i * 8);
    const offset = cmap.getUint32(8 + i * 8);
    if (offset + 2 > cmap.byteLength) continue;
    const format = cmap.getUint16(offset);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    // Prefer the full-range format 12 table, then the BMP-only format 4 table.
    const score = !unicode ? 0 : format === 12 ? 2 : format === 4 ? 1 : 0;
    if (score > chosenScore) {
      chosen = offset;
      chosenFormat = format;
      chosenScore = score;
    }
  }

  if (chosen === -1) return () => 0;

  if (chosenFormat === 12) {
    const groups = cmap.getUint32(chosen + 12);
    return (codePoint) => {
      let lo = 0;
      let hi = groups - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const base = chosen + 16 + mid * 12;
        const startCode = cmap.getUint32(base);
        const endCode = cmap.getUint32(base + 4);
        if (codePoint < startCode) hi = mid - 1;
        else if (codePoint > endCode) lo = mid + 1;
        else return cmap.getUint32(base + 8) + (codePoint - startCode);
      }
      return 0;
    };
  }

  const segments = cmap.getUint16(chosen + 6) / 2;
  const endCodes = chosen + 14;
  const startCodes = endCodes + segments * 2 + 2;
  const deltas = startCodes + segments * 2;
  const rangeOffsets = deltas + segments * 2;
  return (codePoint) => {
    if (codePoint > 0xffff) return 0;
    for (let i = 0; i < segments; i++) {
      if (cmap.getUint16(endCodes + i * 2) < codePoint) continue;
      const startCode = cmap.getUint16(startCodes + i * 2);
      if (startCode > codePoint) return 0;
      const delta = cmap.getInt16(deltas + i * 2);
      const rangeOffset = cmap.getUint16(rangeOffsets + i * 2);
      if (rangeOffset === 0) return (codePoint + delta) & 0xffff;
      const glyph = cmap.getUint16(rangeOffsets + i * 2 + rangeOffset + (codePoint - startCode) * 2);
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
    }
    return 0;
  };
}
