import { EigenvalueDecomposition, Matrix, SingularValueDecomposition, determinant as numericDeterminantOf, inverse as numericInverseOf } from "ml-matrix";
import type { Expr } from "./ast.js";
import { add, div, mul, neg, pow, simplify, sub } from "./symbolic.js";

/**
 * Matrices as grids of expressions.
 *
 * Matrix arithmetic happens while a line is resolved, entry by entry, so
 * `A * v` becomes two ordinary expressions before anything is compiled.
 * Everything downstream, from derivatives to the renderers, keeps working on
 * plain numbers, and entries can still depend on sliders or on x. Only the
 * operations with no closed form, such as eigenvalues, need numeric entries,
 * and those go to ml-matrix.
 */

export interface MatrixValue {
  readonly kind: "matrixValue";
  readonly rows: number;
  readonly cols: number;
  /** Row by row. */
  readonly entries: readonly Expr[];
}

export type Value = Expr | MatrixValue;

export class ShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShapeError";
  }
}

const N = (value: number): Expr => ({ kind: "num", value });

export const isMatrix = (v: Value): v is MatrixValue => v.kind === "matrixValue";

export function matrix(rows: number, cols: number, entries: readonly Expr[]): MatrixValue {
  return { kind: "matrixValue", rows, cols, entries };
}

export const entryAt = (m: MatrixValue, i: number, j: number): Expr => m.entries[i * m.cols + j]!;

export const isVector = (m: MatrixValue): boolean => m.rows === 1 || m.cols === 1;

export const isScalarMatrix = (m: MatrixValue): boolean => m.rows === 1 && m.cols === 1;

export const dimensions = (m: MatrixValue): string => `${m.rows}×${m.cols}`;

export function describe(m: MatrixValue): string {
  return `${dimensions(m)} ${isVector(m) ? "vector" : "matrix"}`;
}

export const asMatrix = (v: Value): MatrixValue => (isMatrix(v) ? v : matrix(1, 1, [v]));

export function mapEntries(m: MatrixValue, f: (e: Expr, i: number, j: number) => Expr): MatrixValue {
  return matrix(
    m.rows,
    m.cols,
    m.entries.map((e, k) => f(e, Math.floor(k / m.cols), k % m.cols)),
  );
}

export const simplifyMatrix = (m: MatrixValue): MatrixValue => mapEntries(m, simplify);

/**
 * Applies a scalar operation entry by entry. A number, or a 1×1 matrix, pairs
 * with every entry of the other side, as in MATLAB.
 */
export function elementwise(a: Value, b: Value, f: (x: Expr, y: Expr) => Expr, symbol: string): Value {
  if (!isMatrix(a) && !isMatrix(b)) return f(a, b);
  const A = asMatrix(a);
  const B = asMatrix(b);
  if (isScalarMatrix(A)) return mapEntries(B, (e) => f(A.entries[0]!, e));
  if (isScalarMatrix(B)) return mapEntries(A, (e) => f(e, B.entries[0]!));
  if (A.rows !== B.rows || A.cols !== B.cols) {
    throw new ShapeError(`${symbol} needs matching sizes, but these are ${dimensions(A)} and ${dimensions(B)}`);
  }
  return matrix(A.rows, A.cols, A.entries.map((e, k) => f(e, B.entries[k]!)));
}

export function multiply(a: Value, b: Value): Value {
  if (!isMatrix(a) || !isMatrix(b) || isScalarMatrix(a) || isScalarMatrix(b)) return elementwise(a, b, mul, "*");
  if (a.cols !== b.rows) {
    throw new ShapeError(
      `Can't multiply a ${dimensions(a)} by a ${dimensions(b)}: the first needs as many columns as the second has rows`,
    );
  }
  const entries: Expr[] = [];
  for (let i = 0; i < a.rows; i++) {
    for (let j = 0; j < b.cols; j++) {
      let sum: Expr = N(0);
      for (let k = 0; k < a.cols; k++) sum = add(sum, mul(entryAt(a, i, k), entryAt(b, k, j)));
      entries.push(sum);
    }
  }
  return matrix(a.rows, b.cols, entries);
}

export function transpose(m: MatrixValue): MatrixValue {
  const entries: Expr[] = [];
  for (let j = 0; j < m.cols; j++) for (let i = 0; i < m.rows; i++) entries.push(entryAt(m, i, j));
  return matrix(m.cols, m.rows, entries);
}

export function identity(n: number): MatrixValue {
  return matrix(n, n, Array.from({ length: n * n }, (_, k) => N(Math.floor(k / n) === k % n ? 1 : 0)));
}

export function filled(rows: number, cols: number, value: number): MatrixValue {
  return matrix(rows, cols, Array.from({ length: rows * cols }, () => N(value)));
}

export function requireSquare(m: MatrixValue, what: string): void {
  if (m.rows !== m.cols) throw new ShapeError(`${what} needs a square matrix, but this is ${dimensions(m)}`);
}

export function trace(m: MatrixValue): Expr {
  requireSquare(m, "trace");
  let sum: Expr = N(0);
  for (let i = 0; i < m.rows; i++) sum = add(sum, entryAt(m, i, i));
  return sum;
}

/** Symbolic determinant by cofactor expansion, practical up to 4×4. */
export function determinant(m: MatrixValue): Expr {
  requireSquare(m, "det");
  const n = m.rows;
  if (n === 1) return m.entries[0]!;
  if (n === 2) return sub(mul(entryAt(m, 0, 0), entryAt(m, 1, 1)), mul(entryAt(m, 0, 1), entryAt(m, 1, 0)));
  let sum: Expr = N(0);
  for (let j = 0; j < n; j++) {
    const term = mul(entryAt(m, 0, j), determinant(minor(m, 0, j)));
    sum = j % 2 === 0 ? add(sum, term) : sub(sum, term);
  }
  return sum;
}

function minor(m: MatrixValue, row: number, col: number): MatrixValue {
  const entries: Expr[] = [];
  for (let i = 0; i < m.rows; i++) {
    if (i === row) continue;
    for (let j = 0; j < m.cols; j++) if (j !== col) entries.push(entryAt(m, i, j));
  }
  return matrix(m.rows - 1, m.cols - 1, entries);
}

/** Symbolic inverse through the adjugate, for matrices up to 3×3. */
export function symbolicInverse(m: MatrixValue): MatrixValue {
  requireSquare(m, "inv");
  const det = simplify(determinant(m));
  if (det.kind === "num" && det.value === 0) throw new ShapeError("This matrix is singular, so it has no inverse");
  const n = m.rows;
  if (n === 1) return matrix(1, 1, [div(N(1), m.entries[0]!)]);
  const entries: Expr[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      // The adjugate is the transposed cofactor matrix, hence minor(j, i).
      const cofactor = determinant(minor(m, j, i));
      entries.push(div((i + j) % 2 === 0 ? cofactor : neg(cofactor), det));
    }
  }
  return matrix(n, n, entries);
}

/** Joins entries into one matrix: each row side by side, then rows stacked. */
export function concatenate(rows: readonly (readonly Value[])[]): MatrixValue {
  const built = rows.map((row) => {
    const parts = row.map(asMatrix);
    const height = parts[0]!.rows;
    if (parts.some((p) => p.rows !== height)) {
      throw new ShapeError(`Entries side by side need the same height, but these are ${parts.map(dimensions).join(", ")}`);
    }
    const cols = parts.reduce((n, p) => n + p.cols, 0);
    const entries: Expr[] = [];
    for (let i = 0; i < height; i++) for (const p of parts) for (let j = 0; j < p.cols; j++) entries.push(entryAt(p, i, j));
    return matrix(height, cols, entries);
  });
  const width = built[0]!.cols;
  if (built.some((r) => r.cols !== width)) {
    throw new ShapeError(`Every row needs the same number of columns, but these have ${built.map((r) => r.cols).join(", ")}`);
  }
  return matrix(
    built.reduce((n, r) => n + r.rows, 0),
    width,
    built.flatMap((r) => [...r.entries]),
  );
}

export function power(m: MatrixValue, k: number, invert: (m: MatrixValue) => MatrixValue): MatrixValue {
  requireSquare(m, "A matrix power");
  if (k === 0) return identity(m.rows);
  let base = k < 0 ? invert(m) : m;
  let exponent = Math.abs(k);
  let result: MatrixValue | null = null;
  // Repeated squaring keeps A^16 to five products instead of fifteen.
  while (exponent > 0) {
    if (exponent & 1) result = result ? (multiply(result, base) as MatrixValue) : base;
    exponent >>= 1;
    if (exponent > 0) base = multiply(base, base) as MatrixValue;
  }
  return result!;
}

function requireVector(m: MatrixValue, what: string): void {
  if (!isVector(m)) throw new ShapeError(`${what} needs a vector, but this is ${dimensions(m)}`);
}

export function dot(u: MatrixValue, v: MatrixValue): Expr {
  requireVector(u, "dot");
  requireVector(v, "dot");
  if (u.entries.length !== v.entries.length) {
    throw new ShapeError(`dot needs vectors of the same length, but these have ${u.entries.length} and ${v.entries.length}`);
  }
  return u.entries.reduce<Expr>((sum, e, k) => add(sum, mul(e, v.entries[k]!)), N(0));
}

export function cross(u: MatrixValue, v: MatrixValue): MatrixValue {
  if (!isVector(u) || !isVector(v) || u.entries.length !== 3 || v.entries.length !== 3) {
    throw new ShapeError("cross needs two vectors of length 3");
  }
  const [a1, a2, a3] = u.entries as [Expr, Expr, Expr];
  const [b1, b2, b3] = v.entries as [Expr, Expr, Expr];
  const entries = [sub(mul(a2, b3), mul(a3, b2)), sub(mul(a3, b1), mul(a1, b3)), sub(mul(a1, b2), mul(a2, b1))];
  return matrix(u.rows, u.cols, entries);
}

export function vectorNorm(v: MatrixValue): Expr {
  return { kind: "call", name: "sqrt", args: [v.entries.reduce<Expr>((sum, e) => add(sum, pow(e, N(2))), N(0))] };
}

// Numeric operations, for entries that are already numbers.

export function toArray(m: MatrixValue, evaluate: (e: Expr) => number): number[][] {
  return Array.from({ length: m.rows }, (_, i) => Array.from({ length: m.cols }, (_, j) => evaluate(entryAt(m, i, j))));
}

export function fromArray(rows: readonly (readonly number[])[]): MatrixValue {
  return matrix(rows.length, rows[0]?.length ?? 0, rows.flat().map(N));
}

const finite = (rows: number[][]): boolean => rows.every((row) => row.every(Number.isFinite));

export function numericInverse(a: number[][]): number[][] {
  const det = numericDeterminantOf(new Matrix(a));
  if (!(Math.abs(det) > 1e-12)) throw new ShapeError("This matrix is singular, so it has no inverse");
  const result = numericInverseOf(new Matrix(a)).to2DArray();
  if (!finite(result)) throw new ShapeError("This matrix is singular, so it has no inverse");
  return result;
}

export const numericDeterminant = (a: number[][]): number => numericDeterminantOf(new Matrix(a));

export interface Complex {
  readonly re: number;
  readonly im: number;
}

/** Real eigenvalues in ascending order, and complex ones, both of each conjugate pair. */
export function eigenvalues(a: number[][]): { real: number[]; complex: Complex[] } {
  const decomposition = new EigenvalueDecomposition(new Matrix(a));
  const scale = Math.max(1, ...a.flat().map(Math.abs));
  // Round-off leaves 1e-17 where 0 belongs; it would show up in the readout.
  const clean = (x: number): number => (Math.abs(x) < 1e-12 * scale ? 0 : x);
  const re = decomposition.realEigenvalues;
  const im = decomposition.imaginaryEigenvalues;
  const complex: Complex[] = [];
  const real: number[] = [];
  re.forEach((r, i) => {
    const c = clean(im[i] ?? 0);
    if (c !== 0) complex.push({ re: clean(r), im: c });
    else real.push(clean(r));
  });
  return { real: real.sort((x, y) => x - y), complex: complex.sort((x, y) => x.re - y.re || y.im - x.im) };
}

/** Real eigenvalues with unit eigenvectors, for drawing a linear system's invariant lines. */
export function realEigenvectors(a: number[][]): { value: number; vector: number[] }[] {
  const decomposition = new EigenvalueDecomposition(new Matrix(a));
  const vectors = decomposition.eigenvectorMatrix;
  const im = decomposition.imaginaryEigenvalues;
  return decomposition.realEigenvalues.flatMap((value, i) => {
    if (Math.abs(im[i] ?? 0) > 1e-10 * Math.max(1, Math.abs(value))) return [];
    const column = vectors.getColumn(i);
    const length = Math.hypot(...column);
    return length > 0 ? [{ value, vector: column.map((c) => c / length) }] : [];
  });
}

/** The largest singular value: how far the matrix can stretch a unit vector. */
export const spectralNorm = (a: number[][]): number => Math.max(...new SingularValueDecomposition(new Matrix(a)).diagonal);

/**
 * e^A by scaling and squaring: halve A until it is small, sum its Taylor
 * series, then square the result back up.
 */
export function matrixExponential(a: number[][]): number[][] {
  const n = a.length;
  const A = new Matrix(a);
  const size = Math.max(...a.map((row) => row.reduce((s, v) => s + Math.abs(v), 0)));
  const halvings = Math.max(0, Math.ceil(Math.log2(Math.max(size, 1e-300))) + 1);
  const scaled = Matrix.mul(A, 1 / 2 ** halvings);
  let result = Matrix.eye(n);
  let term = Matrix.eye(n);
  for (let k = 1; k <= 24; k++) {
    term = Matrix.mul(term.mmul(scaled), 1 / k);
    result = Matrix.add(result, term);
  }
  for (let s = 0; s < halvings; s++) result = result.mmul(result);
  return result.to2DArray();
}
