import type { Range, Surface3D } from "./plot.js";

/**
 * Geometry for the 3D view, built once per equation and reused for every
 * orbit frame. Rotating the camera only re-projects these triangles, which is
 * what makes keyboard orbiting cheap enough to animate.
 */

export interface Mesh {
  readonly color: string;
  /** x, y, z per vertex in world coordinates. */
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
}

export interface Polyline3D {
  readonly color: string;
  /** x, y, z per point; a NaN point breaks the line. */
  readonly points: Float32Array;
}

export interface Point3D {
  readonly color: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Scene3D {
  readonly meshes: readonly Mesh[];
  readonly lines: readonly Polyline3D[];
  readonly points: readonly Point3D[];
  /** The plotting box that the view maps onto a cube. */
  readonly bounds: readonly [Range, Range, Range];
}

export type MeshQuality = "draft" | "fine";

const RESOLUTION = {
  draft: { grid: 40, implicit: 28, curve: 512 },
  fine: { grid: 96, implicit: 56, curve: 2048 },
} as const;

class MeshBuilder {
  private positions: number[] = [];
  private normals: number[] = [];
  private indices: number[] = [];

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number): number {
    const length = Math.hypot(nx, ny, nz) || 1;
    this.positions.push(x, y, z);
    this.normals.push(nx / length, ny / length, nz / length);
    return this.vertexCount - 1;
  }

  triangle(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  build(color: string): Mesh {
    return {
      color,
      positions: Float32Array.from(this.positions),
      normals: Float32Array.from(this.normals),
      indices: Uint32Array.from(this.indices),
    };
  }
}

/** A regular grid of positions, triangulated, with normals from neighbouring points. */
function gridMesh(
  color: string,
  cols: number,
  rows: number,
  at: (c: number, r: number) => [number, number, number],
  keep: (p: [number, number, number]) => boolean,
): Mesh {
  const points: ([number, number, number] | null)[] = [];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const p = at(c, r);
      points.push(p.every(Number.isFinite) && keep(p) ? p : null);
    }
  }
  const index = (c: number, r: number): number => r * (cols + 1) + c;
  const get = (c: number, r: number): [number, number, number] | null =>
    c < 0 || r < 0 || c > cols || r > rows ? null : points[index(c, r)]!;

  const builder = new MeshBuilder();
  const ids = new Int32Array(points.length).fill(-1);
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const p = get(c, r);
      if (!p) continue;
      // Tangents from central differences, falling back to one side at edges and holes.
      const u0 = get(c - 1, r) ?? p;
      const u1 = get(c + 1, r) ?? p;
      const v0 = get(c, r - 1) ?? p;
      const v1 = get(c, r + 1) ?? p;
      const tu = [u1[0] - u0[0], u1[1] - u0[1], u1[2] - u0[2]] as const;
      const tv = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]] as const;
      ids[index(c, r)] = builder.vertex(
        p[0],
        p[1],
        p[2],
        tu[1] * tv[2] - tu[2] * tv[1],
        tu[2] * tv[0] - tu[0] * tv[2],
        tu[0] * tv[1] - tu[1] * tv[0],
      );
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = ids[index(c, r)]!;
      const b = ids[index(c + 1, r)]!;
      const d = ids[index(c, r + 1)]!;
      const e = ids[index(c + 1, r + 1)]!;
      if (a >= 0 && b >= 0 && e >= 0) builder.triangle(a, b, e);
      if (a >= 0 && e >= 0 && d >= 0) builder.triangle(a, e, d);
    }
  }
  return builder.build(color);
}

const lerp = (range: Range, t: number): number => range.lo + (range.hi - range.lo) * t;

/** The six tetrahedra of a cube, all sharing the diagonal from corner 0 to corner 6. */
const TETRAHEDRA = [
  [0, 5, 1, 6],
  [0, 1, 2, 6],
  [0, 2, 3, 6],
  [0, 3, 7, 6],
  [0, 7, 4, 6],
  [0, 4, 5, 6],
] as const;
const CORNERS = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
] as const;

/**
 * Marching tetrahedra: the zero set of F as triangles. Chosen over marching
 * cubes because it needs no 256-case table and has no ambiguous cases.
 * Normals come from the gradient of F, so shading follows the true surface
 * rather than the facets.
 */
function implicitMesh(color: string, F: (x: number, y: number, z: number) => number, box: readonly [Range, Range, Range], n: number): Mesh {
  const side = n + 1;
  const xs = Float64Array.from({ length: side }, (_, i) => lerp(box[0], i / n));
  const ys = Float64Array.from({ length: side }, (_, i) => lerp(box[1], i / n));
  const zs = Float64Array.from({ length: side }, (_, i) => lerp(box[2], i / n));
  const values = new Float64Array(side * side * side);
  for (let k = 0; k < side; k++) {
    for (let j = 0; j < side; j++) {
      for (let i = 0; i < side; i++) values[i + side * (j + side * k)] = F(xs[i]!, ys[j]!, zs[k]!);
    }
  }

  const builder = new MeshBuilder();
  const edgeVertices = new Map<number, number>();
  const total = values.length;
  const h = [
    (box[0].hi - box[0].lo) * 1e-4,
    (box[1].hi - box[1].lo) * 1e-4,
    (box[2].hi - box[2].lo) * 1e-4,
  ] as const;

  const vertexOnEdge = (a: number, b: number): number => {
    const key = a < b ? a * total + b : b * total + a;
    const existing = edgeVertices.get(key);
    if (existing !== undefined) return existing;
    const va = values[a]!;
    const vb = values[b]!;
    const t = va / (va - vb);
    const coord = (index: number): [number, number, number] => {
      const i = index % side;
      const j = Math.floor(index / side) % side;
      const k = Math.floor(index / (side * side));
      return [xs[i]!, ys[j]!, zs[k]!];
    };
    const pa = coord(a);
    const pb = coord(b);
    const x = pa[0] + (pb[0] - pa[0]) * t;
    const y = pa[1] + (pb[1] - pa[1]) * t;
    const z = pa[2] + (pb[2] - pa[2]) * t;
    const gx = (F(x + h[0], y, z) - F(x - h[0], y, z)) / h[0];
    const gy = (F(x, y + h[1], z) - F(x, y - h[1], z)) / h[1];
    const gz = (F(x, y, z + h[2]) - F(x, y, z - h[2])) / h[2];
    const id = builder.vertex(x, y, z, gx, gy, gz);
    edgeVertices.set(key, id);
    return id;
  };

  const corner = new Int32Array(8);
  for (let k = 0; k < n; k++) {
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        let finite = true;
        let negatives = 0;
        for (let c = 0; c < 8; c++) {
          const [di, dj, dk] = CORNERS[c]!;
          const index = i + di + side * (j + dj + side * (k + dk));
          corner[c] = index;
          const value = values[index]!;
          if (!Number.isFinite(value)) finite = false;
          if (value < 0) negatives++;
        }
        if (!finite || negatives === 0 || negatives === 8) continue;

        for (const tet of TETRAHEDRA) {
          const ids = tet.map((c) => corner[c]!);
          const inside = ids.filter((id) => values[id]! < 0);
          const outside = ids.filter((id) => values[id]! >= 0);
          if (inside.length === 0 || outside.length === 0) continue;
          if (inside.length === 1 || outside.length === 1) {
            const [lone, others] = inside.length === 1 ? [inside[0]!, outside] : [outside[0]!, inside];
            builder.triangle(vertexOnEdge(lone, others[0]!), vertexOnEdge(lone, others[1]!), vertexOnEdge(lone, others[2]!));
          } else {
            const [a, b] = inside as [number, number];
            const [c, d] = outside as [number, number];
            const ac = vertexOnEdge(a, c);
            const ad = vertexOnEdge(a, d);
            const bc = vertexOnEdge(b, c);
            const bd = vertexOnEdge(b, d);
            builder.triangle(ac, ad, bd);
            builder.triangle(ac, bd, bc);
          }
        }
      }
    }
  }
  return builder.build(color);
}

const union = (a: Range | null, b: Range): Range => (a ? { lo: Math.min(a.lo, b.lo), hi: Math.max(a.hi, b.hi) } : b);

/** Finite min and max of the given axis across mesh positions or line points. */
function extent(values: Float32Array, axis: number): Range | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = axis; i < values.length; i += 3) {
    const v = values[i]!;
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return Number.isFinite(lo) ? { lo, hi } : null;
}

/** Widens a range to multiples of a 1, 2 or 5 step, so box ticks land on its corners. */
function roundOut(range: Range): Range {
  const span = range.hi - range.lo;
  if (!(span > 1e-9)) return padded(range);
  const raw = span / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const n = raw / magnitude;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * magnitude;
  return { lo: Math.floor(range.lo / step + 1e-9) * step, hi: Math.ceil(range.hi / step - 1e-9) * step };
}

const padded = (range: Range): Range => {
  if (range.hi - range.lo > 1e-9) return range;
  const pad = Math.max(1, Math.abs(range.lo) * 0.1);
  return { lo: range.lo - pad, hi: range.hi + pad };
};

export function buildScene3D(surfaces: readonly Surface3D[], quality: MeshQuality = "fine"): Scene3D {
  const res = RESOLUTION[quality];
  const meshes: Mesh[] = [];
  const lines: Polyline3D[] = [];
  const points: Point3D[] = [];
  let bx: Range | null = null;
  let by: Range | null = null;
  let bz: Range | null = null;

  for (const s of surfaces) {
    switch (s.kind) {
      case "explicitSurface": {
        const n = res.grid;
        const mesh = gridMesh(
          s.color,
          n,
          n,
          (c, r) => {
            const x = lerp(s.x, c / n);
            const y = lerp(s.y, r / n);
            return [x, y, s.f(x, y)];
          },
          (p) => !s.zClip || (p[2] >= s.zClip.lo && p[2] <= s.zClip.hi),
        );
        meshes.push(mesh);
        bx = union(bx, s.x);
        by = union(by, s.y);
        const z = s.zClip ?? extent(mesh.positions, 2);
        if (z) bz = union(bz, s.zClip ? z : roundOut(z));
        break;
      }
      case "implicitSurface": {
        const mesh = implicitMesh(s.color, s.F, s.box, res.implicit);
        meshes.push(mesh);
        // Without ranges the box was only a search volume; show the surface found, not the volume.
        const found = s.fit ? [0, 1, 2].map((axis) => extent(mesh.positions, axis)) : [null, null, null];
        bx = union(bx, found[0] ? roundOut(found[0]) : s.box[0]);
        by = union(by, found[1] ? roundOut(found[1]) : s.box[1]);
        bz = union(bz, found[2] ? roundOut(found[2]) : s.box[2]);
        break;
      }
      case "parametricSurface": {
        const n = res.grid;
        const mesh = gridMesh(
          s.color,
          n,
          n,
          (c, r) => {
            const u = lerp(s.u, c / n);
            const v = lerp(s.v, r / n);
            return [s.x(u, v), s.y(u, v), s.z(u, v)];
          },
          () => true,
        );
        meshes.push(mesh);
        for (const [axis, set] of [
          [0, (r: Range) => (bx = union(bx, r))],
          [1, (r: Range) => (by = union(by, r))],
          [2, (r: Range) => (bz = union(bz, r))],
        ] as const) {
          const e = extent(mesh.positions, axis);
          if (e) set(roundOut(e));
        }
        break;
      }
      case "gridSurface": {
        const mesh = gridMesh(
          s.color,
          s.cols - 1,
          s.rows - 1,
          (c, r) => [lerp(s.x, c / (s.cols - 1)), lerp(s.y, r / (s.rows - 1)), s.values[r * s.cols + c]!],
          () => true,
        );
        meshes.push(mesh);
        bx = union(bx, s.x);
        by = union(by, s.y);
        bz = union(bz, { lo: s.min, hi: s.max });
        break;
      }
      case "curve3d": {
        const n = res.curve;
        const data = new Float32Array((n + 1) * 3);
        for (let i = 0; i <= n; i++) {
          const t = lerp(s.range, i / n);
          data[i * 3] = s.x(t);
          data[i * 3 + 1] = s.y(t);
          data[i * 3 + 2] = s.z(t);
        }
        lines.push({ color: s.color, points: data });
        for (const [axis, set] of [
          [0, (r: Range) => (bx = union(bx, r))],
          [1, (r: Range) => (by = union(by, r))],
          [2, (r: Range) => (bz = union(bz, r))],
        ] as const) {
          const e = extent(data, axis);
          if (e) set(roundOut(e));
        }
        break;
      }
      case "arrow3d": {
        lines.push({ color: s.color, points: Float32Array.from([0, 0, 0, s.x, s.y, s.z]) });
        points.push({ color: s.color, x: s.x, y: s.y, z: s.z });
        bx = union(bx, { lo: Math.min(0, s.x), hi: Math.max(0, s.x) });
        by = union(by, { lo: Math.min(0, s.y), hi: Math.max(0, s.y) });
        bz = union(bz, { lo: Math.min(0, s.z), hi: Math.max(0, s.z) });
        break;
      }
      case "point3d":
        points.push({ color: s.color, x: s.x, y: s.y, z: s.z });
        bx = union(bx, { lo: s.x, hi: s.x });
        by = union(by, { lo: s.y, hi: s.y });
        bz = union(bz, { lo: s.z, hi: s.z });
        break;
    }
  }

  const fallback: Range = { lo: -5, hi: 5 };
  return {
    meshes,
    lines,
    points,
    bounds: [padded(bx ?? fallback), padded(by ?? fallback), padded(bz ?? fallback)],
  };
}
