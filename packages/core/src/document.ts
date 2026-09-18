import { type BinaryOp, type ConditionAst, type EntryAst, type Expr, type IntervalAst, freeVars, someNode } from "./ast.js";
import { CONSTANT_NAMES, FUNCTIONS, realPow } from "./builtins.js";
import { type ParamValues, compileFunction } from "./compile-js.js";
import {
  type ComplexValue,
  IMAGINARY_UNIT,
  applyComplex,
  argument,
  cadd,
  cdiv,
  cmul,
  cneg,
  complex,
  conjugate,
  cpow,
  cpowInteger,
  csub,
  isComplex,
  settle,
  toComplex,
} from "./complex.js";
import {
  type Complex,
  type MatrixValue,
  type Value as LinalgValue,
  asMatrix,
  concatenate,
  cross,
  describe,
  determinant,
  dot,
  eigenvalues,
  elementwise,
  entryAt,
  filled,
  fromArray,
  isScalarMatrix,
  isVector,
  mapEntries,
  matrix,
  matrixExponential,
  multiply,
  numericInverse,
  power,
  realEigenvectors,
  requireSquare,
  simplifyMatrix,
  spectralNorm,
  symbolicInverse,
  toArray,
  trace,
  transpose,
  vectorNorm,
} from "./linalg.js";
import { type IvpSolution, type OdeSystem, highestRoots, solveIvp } from "./ode.js";
import { type FaceCondition, type FieldInfo, fieldPlots, fieldSurfaces, solveField } from "./field.js";
import { PERIODIC, parseEntry } from "./parser.js";
import { type Boundary, DEFAULT_BOUNDARY, type PdeSolution, solvePde } from "./pde.js";
import type { Plot2D, Range, Surface3D } from "./plot.js";
import type { TransformInfo, TransformStep } from "./transform.js";
import { type StateSystem, type SystemInfo, findEquilibria, orbitSurfaces, solveOrbit, stateRates } from "./state-space.js";
import { add, differentiate, div, formatExpr, mapChildren, mul, neg, simplify, sub, substitute } from "./symbolic.js";

/**
 * Turns a list of lines into things to draw.
 *
 * A line's meaning depends on the others: `f(x) = x^2` elsewhere makes `f(3)` a
 * call rather than f times 3, `a = 2 [0, 10]` makes `a` a slider, and `dp/dq`
 * is an unknown only when p is not defined. So every line is parsed first,
 * definitions are collected, and only then is each line resolved and classified.
 */

export interface DocumentLine {
  readonly id: string;
  readonly source: string;
  readonly color: string;
  readonly visible?: boolean;
}

export type EntryKind = "plot" | "function" | "constant" | "slider" | "error";

/**
 * What kind of differential equation a line is, known as soon as its
 * derivatives are read and kept even when the line has an error, such as a
 * missing starting value. The input hints need it most exactly then.
 */
export type LineShape =
  | { readonly kind: "ode"; readonly dependent: string; readonly independent: string; readonly order: number }
  | { readonly kind: "pde"; readonly dependent: string; readonly space: string; readonly time: string; readonly timeOrder: number };

export interface SliderInfo {
  readonly id: string;
  readonly name: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** Where the value literal sits in the line, for rewriting it in place. */
  readonly valueStart: number;
  readonly valueEnd: number;
}

export interface OdeInfo {
  readonly dependent: string;
  readonly independent: string;
  readonly order: number;
  readonly linear: boolean;
  readonly span: Range;
  readonly solutions: readonly IvpSolution[];
}

export interface PdeInfo {
  readonly dependent: string;
  readonly space: string;
  readonly time: string;
  readonly solution: PdeSolution;
  readonly display: "heatmap" | "surface";
}

export interface EntryAnalysis {
  readonly id: string;
  readonly source: string;
  readonly color: string;
  readonly visible: boolean;
  readonly kind: EntryKind;
  readonly error: string | null;
  /** Something worth knowing that is not an error, such as an assumed starting value. */
  readonly note: string | null;
  readonly description: string;
  readonly dimension: 2 | 3;
  /** Horizontal, vertical and, in 3D, depth axis names. */
  readonly axes: readonly string[];
  /** Defined constants and sliders this line reads. */
  readonly uses: readonly string[];
  /** Names this line reads that nothing defines; they evaluate as 1 until defined. */
  readonly missing: readonly string[];
  readonly plots: readonly Plot2D[];
  readonly surfaces: readonly Surface3D[];
  readonly ode: OdeInfo | null;
  readonly pde: PdeInfo | null;
  /** Span of the time axis, for lines that can be played back. */
  readonly timeRange: Range | null;
  /** The window the line's own ranges describe, for zooming to fit. */
  readonly fit: { readonly h: Range | null; readonly v: Range | null } | null;
  /** The line with functions expanded and derivatives worked out, when that changed it. */
  readonly resolved: string | null;
  readonly shape: LineShape | null;
  /** Numeric matrices this line applies, step by step, for the transformation view. */
  readonly transform: TransformInfo | null;
  /** A system of first-order equations and its solved orbits. */
  readonly system: SystemInfo | null;
  /** A PDE in two or three space dimensions. */
  readonly field: FieldInfo | null;
}

export interface AnalyzeOptions {
  /** Only defined functions can be called, so name(...) never means multiplication. */
  readonly strictCalls?: boolean;
}

export interface DocumentAnalysis {
  readonly entries: readonly EntryAnalysis[];
  readonly sliders: readonly SliderInfo[];
  readonly params: Readonly<Record<string, number>>;
  /** Defined functions and their parameter names. */
  readonly functions: Readonly<Record<string, readonly string[]>>;
}

class EntryError extends Error {}

const formatComplex = ({ re, im }: Complex): string =>
  im === 0 ? fmtNumber(re) : `${fmtNumber(re)} ${im < 0 ? "-" : "+"} ${fmtNumber(Math.abs(im))}i`;
const fmtNumber = (value: number): string => String(Number(value.toPrecision(6)));
const isEigCall = (e: Expr): boolean => e.kind === "apply" && e.name === "eig";

/** Complex eigenvalues can't be a vector of numbers, but a line of their own draws them. */
class ComplexEigenvalues extends EntryError {
  constructor(readonly values: readonly Complex[]) {
    super(`eig found complex eigenvalues, ${values.map(formatComplex).join(", ")}; on a line of its own, eig draws them as points`);
  }
}

const COORDINATES: ReadonlySet<string> = new Set(["x", "y", "z"]);
/** A one-letter name with a letters-only subscript, the shape of u_t or u_xx. */
const SUBSCRIPT_DERIVATIVE = /^([A-Za-zͰ-Ͽ])_([A-Za-z]+)$/;
const TWO_PI = 2 * Math.PI;
const DEFAULT_PARAMETER_RANGE: Range = { lo: 0, hi: TWO_PI };
const DEFAULT_BOX: Range = { lo: -5, hi: 5 };
const DEFAULT_ODE_SPAN: Range = { lo: -10, hi: 10 };
const DEFAULT_PDE_SPACE: Range = { lo: -5, hi: 5 };
const DEFAULT_PDE_TIME: Range = { lo: 0, hi: 5 };
const DEFAULT_SLIDER: Range = { lo: -10, hi: 10 };
const DEFAULT_SYSTEM_SPAN: Range = { lo: 0, hi: 20 };
const DEFAULT_FACE: FaceCondition = { kind: "neumann", value: () => 0 };
/** Nullclines and invariant lines sit behind a system's orbits, in the grid's colour. */
const GUIDE_COLOR = "#625e5a";
/** What a name nobody has defined evaluates to, so a half-written document still draws. */
export const MISSING_VALUE = 1;

const V = (name: string): Expr => ({ kind: "var", name });
const N = (value: number): Expr => ({ kind: "num", value });
const NO_UNKNOWNS: ReadonlySet<string> = new Set();

/** What a resolved expression can be: a number-valued expression, a matrix of them, or a complex pair. */
type Value = LinalgValue | ComplexValue;
const isMatrix = (v: Value): v is MatrixValue => v.kind === "matrixValue";
/** Functions of a complex number that aren't scalar built-ins. */
const COMPLEX_FUNCTIONS: ReadonlySet<string> = new Set(["re", "im", "conj", "arg"]);

/** Names bound while resolving: a function's parameters, or the variables a min or max ranges over. */
type Env = ReadonlyMap<string, Value>;
const EMPTY_ENV: Env = new Map();
const shadow = (names: readonly string[]): Env => new Map(names.map((name) => [name, V(name)] as const));
/** A 1×1 matrix is just a number, as in MATLAB. */
const unwrap = (v: Value): Value => (isMatrix(v) && isScalarMatrix(v) ? v.entries[0]! : v);
const matrixNode = (m: MatrixValue, entries: readonly Expr[] = m.entries): Expr => ({
  kind: "matrix",
  rows: Array.from({ length: m.rows }, (_, i) => entries.slice(i * m.cols, (i + 1) * m.cols)),
});

/** Matrix functions that aren't scalar built-ins; a user function of the same name wins. */
const MATRIX_FUNCTIONS: ReadonlySet<string> = new Set([
  "eye", "zeros", "ones", "transpose", "trace", "det", "inv", "norm", "dot", "cross", "eig", "expm",
]);
const ZERO: Expr = { kind: "num", value: 0 };
const isZero = (e: Expr): boolean => e.kind === "num" && e.value === 0;
const ordinal = (n: number): string => ["zeroth", "first", "second", "third", "fourth"][n] ?? `${n}th`;
const fmt = (value: number): string => String(Number(value.toPrecision(6)));

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface FunctionDef {
  readonly name: string;
  readonly params: readonly string[];
  readonly body: Expr;
}

interface ConstantDef {
  readonly name: string;
  readonly expr: Expr;
  readonly slider: boolean;
}

type Role =
  | { readonly kind: "function"; readonly def: FunctionDef }
  | { readonly kind: "constant"; readonly def: ConstantDef }
  | { readonly kind: "duplicate"; readonly message: string };

interface Tracker {
  readonly uses: Set<string>;
  readonly missing: Set<string>;
}

/** A derivative of a bare name: which name, how many primes and per-variable orders. */
interface Partial {
  readonly base: string;
  readonly primes: number;
  readonly orders: ReadonlyMap<string, number>;
}

type Definition =
  | { kind: "function"; def: FunctionDef; needs: readonly string[] }
  | { kind: "constant"; def: ConstantDef; needs: readonly string[] };

/**
 * `needs` lists names written with primes on the right, as in B = A'. Those
 * are transposes only if the names are constants too, which is known once
 * every other definition has been collected.
 */
/** True for a line like z = 3 + 4i, which names a complex number rather than drawing a surface. */
function namesComplexZ(ast: EntryAst): boolean {
  const st = ast.statement;
  return st.kind === "relation" && st.op === "=" && st.left.kind === "var" && st.left.name === "z" && freeVars(st.right, CONSTANT_NAMES).has("i");
}

function definitionOf(ast: EntryAst, zIsName = false): Definition | null {
  const st = ast.statement;
  if (st.kind !== "relation" || st.op !== "=" || ast.conditions || ast.axes) return null;
  const left = st.left;

  if (
    left.kind === "apply" &&
    left.primes === 0 &&
    !COORDINATES.has(left.name) &&
    left.args.every((a) => a.kind === "var")
  ) {
    const params = left.args.map((a) => (a as { name: string }).name);
    if (new Set(params).size !== params.length) return null;
    return { kind: "function", def: { name: left.name, params, body: st.right }, needs: [] };
  }

  // z is the 3D axis, but z = 3 + 4i names a complex number, and then z is a name on every line.
  const coordinate = (v: string): boolean => COORDINATES.has(v) && !(v === "z" && zIsName);
  if (left.kind === "var" && (!coordinate(left.name) || namesComplexZ(ast))) {
    const vars = freeVars(st.right, CONSTANT_NAMES);
    if ([...vars].some(coordinate) || vars.has(left.name)) return null;
    // u_t = u_xx and y_x = y relate derivatives of one unknown; they are not definitions.
    const base = SUBSCRIPT_DERIVATIVE.exec(left.name)?.[1];
    if (base && [...vars].some((v) => v === base || SUBSCRIPT_DERIVATIVE.exec(v)?.[1] === base)) return null;
    if (someNode(st.right, (n) => n.kind === "tuple")) return null;
    const needs: string[] = [];
    if (someNode(st.right, (n) => n.kind === "deriv" && n.variable !== null)) return null;
    someNode(st.right, (n) => {
      if (n.kind === "deriv" && n.expr.kind === "var") needs.push(n.expr.name);
      return false;
    });
    return { kind: "constant", def: { name: left.name, expr: st.right, slider: st.right.kind === "num" }, needs };
  }
  return null;
}

/** Walks a chain of derivative nodes down to the name being differentiated. */
function partialOf(e: Expr): Partial | null {
  let primes = 0;
  const orders = new Map<string, number>();
  let cur = e;
  while (cur.kind === "deriv") {
    if (cur.variable === null) primes += cur.order;
    else orders.set(cur.variable, (orders.get(cur.variable) ?? 0) + cur.order);
    cur = cur.expr;
  }
  return cur.kind === "var" ? { base: cur.name, primes, orders } : null;
}

function collectPartials(sides: readonly Expr[]): Partial[] {
  const out: Partial[] = [];
  const walk = (e: Expr): void => {
    if (e.kind === "deriv") {
      const partial = partialOf(e);
      if (!partial) throw new EntryError("Can't take that derivative");
      out.push(partial);
      return;
    }
    mapChildren(e, (child) => {
      walk(child);
      return child;
    });
  };
  for (const side of sides) walk(side);
  return out;
}

function niceStep(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(x));
  const n = x / magnitude;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * magnitude;
}

function locateValue(source: string, name: string): [number, number] | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^(\\s*${escaped}\\s*=\\s*)(-?\\s*(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?)`).exec(source);
  if (!match) return null;
  return [match[1]!.length, match[1]!.length + match[2]!.length];
}

/** Formats a slider value with as many decimals as its step has, so 0.25 steps show 3.25, not 3.3. */
export function formatSliderValue(value: number, step: number): string {
  let decimals = 0;
  while (decimals < 10 && Math.abs(Math.round(step * 10 ** decimals) - step * 10 ** decimals) > 1e-9 * 10 ** decimals) decimals++;
  return String(Number(value.toFixed(decimals)));
}

/** Any value snapped to the slider's step grid and clamped to its bounds. */
export function snapSliderValue(slider: SliderInfo, value: number): number {
  const snapped = slider.min + Math.round((value - slider.min) / slider.step) * slider.step;
  return Math.min(slider.max, Math.max(slider.min, snapped));
}

/**
 * Rewrites a slider line's value, finding the number afresh in `source`. A drag
 * sends several values before the document is analysed again, so the stored
 * position of the number can be stale by then.
 */
export function rewriteSliderValue(source: string, slider: SliderInfo, value: number): string {
  const span = locateValue(source, slider.name);
  return span ? source.slice(0, span[0]) + formatSliderValue(value, slider.step) + source.slice(span[1]) : source;
}

/** The value one step up or down, snapped to the step grid and clamped to the bounds. */
export function stepSlider(slider: SliderInfo, direction: 1 | -1): number {
  const raw = slider.value + direction * slider.step;
  const snapped = slider.min + Math.round((raw - slider.min) / slider.step) * slider.step;
  return Math.min(slider.max, Math.max(slider.min, snapped));
}

/** Rewrites a slider line with a new value, leaving the rest of it as typed. */
export function setSliderValue(source: string, slider: SliderInfo, value: number): string {
  return source.slice(0, slider.valueStart) + formatSliderValue(value, slider.step) + source.slice(slider.valueEnd);
}

const solveCache = new Map<string, unknown>();
function cached<T>(key: string, compute: () => T): T {
  if (solveCache.has(key)) return solveCache.get(key) as T;
  const value = compute();
  if (solveCache.size > 64) solveCache.clear();
  solveCache.set(key, value);
  return value;
}

class Analyzer {
  private readonly parsed: { line: DocumentLine; ast: EntryAst | null; error: string | null }[];
  private readonly functions = new Map<string, FunctionDef>();
  private readonly constants = new Map<string, ConstantDef>();
  private readonly roles = new Map<string, Role>();
  private readonly params: Record<string, number> = {};
  private readonly evaluating = new Set<string>();
  private readonly constantErrors = new Map<string, string>();
  private readonly sliders: SliderInfo[] = [];
  private readonly matrixConstants = new Map<string, MatrixValue | ComplexValue | null>();
  private readonly matrixFailures = new Map<string, string>();
  private readonly resolvingMatrices = new Set<string>();

  private readonly strictCalls: boolean;
  /** The shape of the line being analysed, once its derivatives are known. */
  private shape: LineShape | null = null;
  /** The line being analysed, for lap(u), which needs its space variables. */
  private currentAst: EntryAst | null = null;
  /** Names the current line treats as unknown functions even though another line defines them. */
  private lineUnknowns: ReadonlySet<string> = new Set();

  constructor(lines: readonly DocumentLine[], options: AnalyzeOptions = {}) {
    this.strictCalls = options.strictCalls ?? false;
    this.parsed = lines.map((line) => {
      try {
        return { line, ast: parseEntry(line.source), error: null };
      } catch (error) {
        return { line, ast: null, error: errorMessage(error) };
      }
    });

    const pending: { line: DocumentLine; definition: Definition }[] = [];
    const zIsName = this.parsed.some((p) => p.ast !== null && namesComplexZ(p.ast));
    for (const { line, ast } of this.parsed) {
      if (!ast) continue;
      const definition = definitionOf(ast, zIsName);
      if (!definition) continue;
      if (definition.needs.length > 0) pending.push({ line, definition });
      else this.define(line, definition);
    }
    // B = A' is a definition once A is one; chains like C = B' settle over a few rounds.
    for (let progress = true; progress && pending.length > 0; ) {
      progress = false;
      for (let i = 0; i < pending.length; i++) {
        const { line, definition } = pending[i]!;
        if (!definition.needs.every((name) => this.constants.has(name))) continue;
        this.define(line, definition);
        pending.splice(i--, 1);
        progress = true;
      }
    }
  }

  private define(line: DocumentLine, definition: Definition): void {
    const name = definition.def.name;
    if (this.functions.has(name) || this.constants.has(name)) {
      this.roles.set(line.id, { kind: "duplicate", message: `${name} is already defined` });
      return;
    }
    if (definition.kind === "function") this.functions.set(name, definition.def);
    else this.constants.set(name, definition.def);
    this.roles.set(line.id, definition);
  }

  run(): DocumentAnalysis {
    const entries = this.parsed.map((p) => this.analyzeLine(p.line, p.ast, p.error));
    const functions = Object.fromEntries([...this.functions].map(([name, def]) => [name, def.params] as const));
    return { entries, sliders: this.sliders, params: this.params, functions };
  }

  private base(line: DocumentLine, overrides: Partial_<EntryAnalysis>): EntryAnalysis {
    return {
      id: line.id,
      source: line.source,
      color: line.color,
      visible: line.visible ?? true,
      kind: "plot",
      error: null,
      note: null,
      description: "",
      dimension: 2,
      axes: ["x", "y"],
      uses: [],
      missing: [],
      plots: [],
      surfaces: [],
      ode: null,
      pde: null,
      timeRange: null,
      fit: null,
      resolved: null,
      shape: null,
      transform: null,
      system: null,
      field: null,
      ...overrides,
    };
  }

  private analyzeLine(line: DocumentLine, ast: EntryAst | null, parseError: string | null): EntryAnalysis {
    if (!ast) return this.base(line, { kind: "error", error: parseError, description: "error" });
    const track: Tracker = { uses: new Set(), missing: new Set() };
    this.shape = null;
    this.currentAst = ast;
    this.lineUnknowns = new Set();
    try {
      const role = this.roles.get(line.id);
      let result: EntryAnalysis;
      if (role?.kind === "duplicate") throw new EntryError(role.message);
      else if (role?.kind === "function") result = this.functionEntry(line, ast, role.def, track);
      else if (role?.kind === "constant") result = this.constantEntry(line, ast, role.def, track);
      else result = this.plotEntry(line, ast, track);
      return { ...result, uses: [...track.uses].sort(), missing: [...track.missing].sort(), shape: this.shape };
    } catch (error) {
      return this.base(line, {
        kind: "error",
        error: errorMessage(error),
        description: "error",
        uses: [...track.uses].sort(),
        missing: [...track.missing].sort(),
        shape: this.shape,
      });
    }
  }

  // Values and resolution

  private valueOf(name: string, track: Tracker): number {
    const def = this.constants.get(name);
    if (def) track.uses.add(name);
    else track.missing.add(name);
    if (Object.hasOwn(this.params, name)) return this.params[name]!;
    if (!def) {
      this.params[name] = MISSING_VALUE;
      return MISSING_VALUE;
    }
    if (this.evaluating.has(name)) throw new EntryError(`${name} is defined in terms of itself`);
    this.evaluating.add(name);
    let value: number;
    try {
      // Dependencies of a constant are not the reading line's business.
      const inner: Tracker = { uses: new Set(), missing: new Set() };
      value = this.evaluate(this.resolve(def.expr), inner);
      // A cycle is detected at one link but is every member's problem.
      for (const dependency of inner.uses) {
        const failure = this.constantErrors.get(dependency);
        if (failure?.includes("in terms of itself")) throw new EntryError(`${name} is defined in terms of itself`);
        if (failure) throw new EntryError(`${name} depends on ${dependency}, which has an error`);
      }
    } catch (error) {
      this.constantErrors.set(name, errorMessage(error));
      value = Number.NaN;
    } finally {
      this.evaluating.delete(name);
    }
    this.params[name] = value;
    return value;
  }

  /** Makes sure every name in `e` other than `args` has a parameter value. */
  private bindParams(e: Expr, args: readonly string[], track: Tracker): void {
    for (const name of freeVars(e, CONSTANT_NAMES)) {
      if (!args.includes(name)) this.valueOf(name, track);
    }
  }

  private evaluate(e: Expr, track: Tracker): number {
    switch (e.kind) {
      case "num":
        return e.value;
      case "var":
        return this.valueOf(e.name, track);
      case "unary":
        return -this.evaluate(e.arg, track);
      case "binary": {
        const l = this.evaluate(e.left, track);
        const r = this.evaluate(e.right, track);
        switch (e.op) {
          case "+":
            return l + r;
          case "-":
            return l - r;
          case "*":
            return l * r;
          case "/":
            return l / r;
          case "^":
            return realPow(l, r);
        }
        return Number.NaN;
      }
      case "call":
        return FUNCTIONS[e.name]!.fn(...e.args.map((a) => this.evaluate(a, track)));
      case "reduce":
      case "integral":
        this.bindParams(e, [], track);
        return (compileFunction(e, []) as unknown as (p: ParamValues) => number)(this.params);
      default:
        throw new EntryError("Expected a number here");
    }
  }

  private range(interval: IntervalAst, track: Tracker): Range {
    if (!interval.lo || !interval.hi) {
      throw new EntryError("A single value like [0.1] only sets a slider's step; a range is [low, high]");
    }
    const lo = this.evaluate(this.resolve(interval.lo), track);
    const hi = this.evaluate(this.resolve(interval.hi), track);
    if (!(Number.isFinite(lo) && Number.isFinite(hi) && lo < hi)) {
      throw new EntryError("A range goes from low to high, like [-5, 5]");
    }
    return { lo, hi };
  }

  private derivativeOf(e: Expr, variable: string, order: number): Expr {
    if (someNode(e, (n) => n.kind === "deriv")) {
      throw new EntryError("Can't differentiate something that already contains an unknown derivative");
    }
    let result = e;
    for (let i = 0; i < order; i++) result = simplify(differentiate(result, variable));
    return result;
  }

  /**
   * Expands user functions and works out every derivative that can be worked
   * out, for places that need a single number-valued expression.
   *
   * `unknowns` are names that depend on whatever a derivative is taken with
   * respect to, so differentiating through them applies the chain rule. Function
   * bodies are always resolved without any: inside a definition, derivatives are
   * partial.
   */
  private resolve(e: Expr, stack: readonly string[] = [], unknowns: ReadonlySet<string> = NO_UNKNOWNS): Expr {
    return this.scalar(this.resolveValue(e, stack, unknowns));
  }

  private scalar(v: Value): Expr {
    const value = unwrap(v);
    if (isMatrix(value)) throw new EntryError(`Expected a number here, but this is a ${describe(value)}`);
    if (isComplex(value)) throw new EntryError("Expected a real number here, but this is complex; take re(...), im(...) or abs(...)");
    return value;
  }

  private realOrMatrix(v: Value): LinalgValue {
    if (isComplex(v)) throw new EntryError("Matrices with complex entries aren't supported yet");
    return v;
  }

  /**
   * Resolves to a number-valued expression or a matrix of them. Matrix
   * arithmetic happens here, entry by entry, so nothing after this point has
   * to know matrices exist.
   */
  private resolveValue(
    e: Expr,
    stack: readonly string[] = [],
    unknowns: ReadonlySet<string> = NO_UNKNOWNS,
    env: Env = EMPTY_ENV,
  ): Value {
    const go = (n: Expr): Value => this.resolveValue(n, stack, unknowns, env);
    switch (e.kind) {
      case "num":
        return e;
      case "var":
        return this.lookup(e.name, env) ?? e;
      case "unary": {
        const arg = go(e.arg);
        return isMatrix(arg) ? mapEntries(arg, neg) : isComplex(arg) ? cneg(arg) : { kind: "unary", op: e.op, arg };
      }
      case "binary":
        return this.binaryValue(e.op, go(e.left), go(e.right));
      case "call": {
        const args = e.args.map(go).map(unwrap);
        const call = (items: Expr[]): Expr => ({ kind: "call", name: e.name, args: items });
        if (args.some(isComplex)) {
          const result = args.length === 1 ? applyComplex(e.name, args[0] as ComplexValue) : null;
          if (!result) throw new EntryError(`${e.name} doesn't take complex numbers yet`);
          return isComplex(result) ? settle(result) : result;
        }
        if (!args.some(isMatrix)) return call(args as Expr[]);
        // Scalar functions apply to each entry.
        if (args.length === 1) return mapEntries(args[0] as MatrixValue, (x) => call([x]));
        return elementwise(args[0] as LinalgValue, args[1] as LinalgValue, (x, y) => call([x, y]), e.name);
      }
      case "matrix":
        return concatenate(e.rows.map((row) => row.map((item) => this.realOrMatrix(go(item)))));
      case "tuple":
        return { kind: "tuple", items: e.items.map((item) => this.scalar(go(item))) };
      case "reduce":
        return this.reduceValue(e, stack, unknowns, env);
      case "integral":
        return this.integralValue(e, stack, unknowns, env);
      case "apply":
        return this.applyValue(e, stack, unknowns, env);
      case "deriv":
        return this.derivValue(e, stack, unknowns, env);
    }
  }

  /** A bound name's value, or a constant's matrix; null leaves the name as it is. */
  private lookup(name: string, env: Env): Value | null {
    if (env.has(name)) return env.get(name)!;
    if (this.functions.has(name)) return null;
    // i is the imaginary unit unless the document defines it.
    if (name === "i" && !this.constants.has("i")) return IMAGINARY_UNIT;
    return this.structuredConstant(name);
  }

  /** A constant's value when it is a matrix; null otherwise. */
  private matrixConstant(name: string): MatrixValue | null {
    const value = this.structuredConstant(name);
    return value && isMatrix(value) ? value : null;
  }

  /** The value of a constant defined as a matrix or a complex number, or null when it is real. */
  private structuredConstant(name: string): MatrixValue | ComplexValue | null {
    const failure = this.matrixFailures.get(name);
    if (failure) throw new EntryError(`${name} has an error: ${failure}`);
    if (this.matrixConstants.has(name)) return this.matrixConstants.get(name)!;
    const def = this.constants.get(name);
    // A cycle reads as a number here; valueOf reports it.
    if (!def || this.resolvingMatrices.has(name)) return null;
    this.resolvingMatrices.add(name);
    try {
      const value = unwrap(this.resolveValue(def.expr));
      const result = isMatrix(value) ? simplifyMatrix(value) : isComplex(value) ? value : null;
      this.matrixConstants.set(name, result);
      return result;
    } catch (error) {
      this.matrixFailures.set(name, errorMessage(error));
      throw new EntryError(`${name} has an error: ${errorMessage(error)}`);
    } finally {
      this.resolvingMatrices.delete(name);
    }
  }

  private binaryValue(op: BinaryOp, left: Value, right: Value): Value {
    const node =
      (o: "+" | "-" | "*" | "/" | "^") =>
      (a: Expr, b: Expr): Expr => ({ kind: "binary", op: o, left: a, right: b });
    const l = unwrap(left);
    const r = unwrap(right);
    if (isComplex(l) || isComplex(r)) {
      if (isMatrix(l) || isMatrix(r)) throw new EntryError("Matrices with complex entries aren't supported yet");
      return this.complexBinary(op, toComplex(l), toComplex(r));
    }
    if (!isMatrix(l) && !isMatrix(r)) {
      switch (op) {
        case ".*":
          return node("*")(l, r);
        case "./":
          return node("/")(l, r);
        case ".^":
          return node("^")(l, r);
        case "\\":
          return node("/")(r, l);
        default:
          return node(op)(l, r);
      }
    }
    switch (op) {
      case "+":
      case "-":
        return elementwise(l, r, node(op), op);
      case ".*":
        return elementwise(l, r, node("*"), op);
      case "./":
        return elementwise(l, r, node("/"), op);
      case ".^":
        return elementwise(l, r, node("^"), op);
      case "*":
        return multiply(l, r);
      case "/":
        return isMatrix(r) ? multiply(l, this.inverse(r)) : elementwise(l, r, node("/"), op);
      case "\\":
        return isMatrix(l) ? multiply(this.inverse(l), r) : elementwise(r, l, node("/"), op);
      case "^": {
        if (isMatrix(r) || !isMatrix(l)) {
          throw new EntryError("A matrix can only be raised to a whole number; use .^ for each entry, or expm(A) for e^A");
        }
        const k = this.constantNumber(r, "A matrix power");
        if (!Number.isInteger(k) || Math.abs(k) > 64) {
          throw new EntryError("A matrix power needs a whole number up to 64; use .^ to raise each entry");
        }
        return power(l, k, (m) => this.inverse(m));
      }
    }
  }

  private complexBinary(op: BinaryOp, a: ComplexValue, b: ComplexValue): Value {
    switch (op) {
      case "+":
        return settle(cadd(a, b));
      case "-":
        return settle(csub(a, b));
      case "*":
      case ".*":
        return settle(cmul(a, b));
      case "/":
      case "./":
        return settle(cdiv(a, b));
      case "\\":
        return settle(cdiv(b, a));
      case "^":
      case ".^": {
        const exponent = settle(b);
        if (!isComplex(exponent) && [...freeVars(exponent, CONSTANT_NAMES)].every((n) => this.constants.has(n))) {
          const k = this.evaluate(exponent, { uses: new Set(), missing: new Set() });
          // Whole powers multiply out exactly, so (x + i y)^2 stays a polynomial.
          if (Number.isInteger(k) && Math.abs(k) <= 64) return settle(cpowInteger(a, k));
        }
        return settle(cpow(a, b));
      }
    }
  }

  private inverse(m: MatrixValue): MatrixValue {
    requireSquare(m, "inv");
    if (m.rows <= 3) return symbolicInverse(m);
    return fromArray(numericInverse(this.numericMatrix(m, "The inverse of a matrix larger than 3×3")));
  }

  /** Evaluates an expression that may only read defined constants. */
  private constantNumber(e: Expr, what: string): number {
    const free = [...freeVars(e, CONSTANT_NAMES)].filter((name) => !this.constants.has(name));
    if (free.length > 0) throw new EntryError(`${what} needs a fixed number, but this depends on ${free.join(", ")}`);
    return this.evaluate(e, { uses: new Set(), missing: new Set() });
  }

  private numericMatrix(m: MatrixValue, what: string): number[][] {
    const rows = toArray(m, (e) => this.constantNumber(e, what));
    if (!rows.every((row) => row.every(Number.isFinite))) throw new EntryError(`${what} needs every entry to be a number`);
    return rows;
  }

  private applyValue(e: Expr & { kind: "apply" }, stack: readonly string[], unknowns: ReadonlySet<string>, env: Env): Value {
    const go = (n: Expr): Value => this.resolveValue(n, stack, unknowns, env);
    const target = this.lookup(e.name, env);
    if (target && isMatrix(target)) return this.index(e, target, go);
    const bound = env.has(e.name);

    const def = bound ? undefined : this.functions.get(e.name);
    if (def) {
      if (stack.includes(def.name)) throw new EntryError(`${def.name} is defined in terms of itself`);
      if (e.args.length !== def.params.length) {
        const n = def.params.length;
        throw new EntryError(`${def.name} takes ${n} argument${n === 1 ? "" : "s"}`);
      }
      const args = e.args.map(go).map(unwrap);
      const inner = [...stack, def.name];
      if (args.some((a) => isMatrix(a) || isComplex(a))) {
        if (e.primes > 0) throw new EntryError(`${def.name}' needs a number, not a matrix`);
        // The body sees its parameters bound to the values, and none of the caller's names.
        return this.resolveValue(def.body, inner, NO_UNKNOWNS, new Map(def.params.map((p, i) => [p, args[i]!] as const)));
      }
      const each = (v: Value, f: (x: Expr) => Expr): Value =>
        isMatrix(v) ? mapEntries(v, f) : isComplex(v) ? settle(complex(f(v.re), f(v.im))) : f(v);
      let body = this.resolveValue(def.body, inner, NO_UNKNOWNS, shadow(def.params));
      if (e.primes > 0) {
        if (def.params.length !== 1) throw new EntryError(`${def.name}' needs a function of one variable`);
        const p = def.params[0]!;
        body = each(body, (x) => this.derivativeOf(x, p, e.primes));
      }
      const bindings = new Map(def.params.map((p, i) => [p, args[i] as Expr] as const));
      return each(body, (x) => substitute(x, bindings));
    }

    if (!bound && FUNCTIONS[e.name]) {
      // Only primed built-ins reach here, such as sin'(x).
      const args = e.args.map((a) => this.scalar(go(a)));
      if (args.length !== 1) throw new EntryError(`${e.name}' needs one argument`);
      const u = "#u";
      const body = this.derivativeOf({ kind: "call", name: e.name, args: [V(u)] }, u, e.primes);
      return substitute(body, new Map([[u, args[0]!]]));
    }

    if (!bound && e.primes === 0 && COMPLEX_FUNCTIONS.has(e.name) && e.args.length === 1) {
      const z = unwrap(go(e.args[0]!));
      if (isMatrix(z)) throw new EntryError(`${e.name} takes a number, not a matrix`);
      const w = toComplex(z);
      if (e.name === "re") return simplify(w.re);
      if (e.name === "im") return simplify(w.im);
      if (e.name === "conj") return settle(conjugate(w));
      return simplify(argument(w));
    }
    if (!bound && e.primes === 0 && e.name === "lap" && e.args.length === 1) {
      const target = unwrap(go(e.args[0]!));
      if (isMatrix(target) || isComplex(target)) {
        const name = e.args[0]!.kind === "var" ? e.args[0]!.name : null;
        throw new EntryError(name ? `lap(${name}) needs ${name} to be unknown, but another line defines ${name}; give it starting values here, or rename one` : "lap takes a function, like lap(u)");
      }
      const space = this.laplacianSpace(target.kind === "var" ? target.name : null);
      return space.map((a): Expr => ({ kind: "deriv", expr: target, variable: a, order: 2 })).reduce((sum, term) => add(sum, term));
    }
    if (!bound && e.primes === 0 && MATRIX_FUNCTIONS.has(e.name)) return this.matrixFunction(e.name, e.args.map(go));

    const args = e.args.map(go).map(unwrap);
    if (e.primes > 0) {
      const only = args[0];
      if (args.length === 1 && only && !isMatrix(only) && only.kind === "var") {
        return { kind: "deriv", expr: V(e.name), variable: only.name, order: e.primes };
      }
      throw new EntryError(`Put starting values in brackets, like [${e.name}(0) = 1]`);
    }
    if (args.length === 1) {
      if (this.strictCalls && !bound) {
        throw new EntryError(`${e.name} isn't a defined function. Define it, or write ${e.name} * (...) to multiply`);
      }
      return this.binaryValue("*", go(V(e.name)), args[0]!);
    }
    throw new EntryError(`${e.name} isn't defined; define it first, like ${e.name}(x, y) = ...`);
  }

  /** A(i, j), or A(k) counting down each column in turn, from 1 as in MATLAB. */
  private index(e: Expr & { kind: "apply" }, m: MatrixValue, go: (n: Expr) => Value): Expr {
    if (e.primes > 0) throw new EntryError(`Transpose first, like transpose(${e.name})(1, 2)`);
    const at = e.args.map((a) => {
      const i = this.constantNumber(this.scalar(go(a)), "A matrix index");
      if (!Number.isInteger(i) || i < 1) throw new EntryError(`Matrix indices are whole numbers from 1, like ${e.name}(1, 2)`);
      return i;
    });
    const outside = new EntryError(`${e.name}(${at.join(", ")}) is outside a ${describe(m)}`);
    if (at.length === 1) {
      const k = at[0]! - 1;
      if (k >= m.entries.length) throw outside;
      return entryAt(m, k % m.rows, Math.floor(k / m.rows));
    }
    if (at.length === 2) {
      const [i, j] = at as [number, number];
      if (i > m.rows || j > m.cols) throw outside;
      return entryAt(m, i - 1, j - 1);
    }
    throw new EntryError(`Index a matrix with one or two numbers, like ${e.name}(2) or ${e.name}(1, 2)`);
  }

  private matrixFunction(name: string, args: readonly Value[]): Value {
    const count = (lo: number, hi = lo): void => {
      if (args.length >= lo && args.length <= hi) return;
      const want = lo === hi ? `${lo}` : `${lo} or ${hi}`;
      throw new EntryError(`${name} takes ${want} argument${hi === 1 ? "" : "s"}`);
    };
    const size = (v: Value): number => {
      const n = this.constantNumber(this.scalar(v), `${name}'s size`);
      if (!Number.isInteger(n) || n < 1 || n > 32) throw new EntryError(`${name} needs a whole-number size from 1 to 32`);
      return n;
    };
    const first = (): MatrixValue => asMatrix(this.realOrMatrix(unwrap(args[0]!)));
    const second = (): MatrixValue => asMatrix(this.realOrMatrix(unwrap(args[1]!)));

    switch (name) {
      case "eye":
      case "zeros":
      case "ones": {
        count(1, 2);
        const rows = size(args[0]!);
        const cols = args[1] ? size(args[1]) : rows;
        if (name !== "eye") return filled(rows, cols, name === "ones" ? 1 : 0);
        return matrix(rows, cols, Array.from({ length: rows * cols }, (_, k) => N(Math.floor(k / cols) === k % cols ? 1 : 0)));
      }
      case "transpose":
        count(1);
        return transpose(first());
      case "trace":
        count(1);
        return trace(first());
      case "det":
        count(1);
        return determinant(first());
      case "inv": {
        count(1);
        const m = first();
        return isScalarMatrix(m) ? div(N(1), m.entries[0]!) : this.inverse(m);
      }
      case "norm": {
        count(1);
        const m = first();
        return isVector(m) ? vectorNorm(m) : N(spectralNorm(this.numericMatrix(m, "The norm of a matrix")));
      }
      case "dot":
        count(2);
        return dot(first(), second());
      case "cross":
        count(2);
        return cross(first(), second());
      case "eig": {
        count(1);
        const m = first();
        requireSquare(m, "eig");
        const { real, complex } = eigenvalues(this.numericMatrix(m, "eig"));
        if (complex.length > 0) {
          throw new ComplexEigenvalues([...real.map((re) => ({ re, im: 0 })), ...complex].sort((x, y) => x.re - y.re || y.im - x.im));
        }
        return matrix(real.length, 1, real.map(N));
      }
      case "expm": {
        count(1);
        const m = first();
        requireSquare(m, "expm");
        return fromArray(matrixExponential(this.numericMatrix(m, "expm")));
      }
    }
    throw new EntryError(`${name} isn't a matrix function`);
  }

  /**
   * min, max, argmin and argmax over a box. The variables they range over are
   * their own, so they hide any constant or unknown of the same name inside.
   */
  private reduceValue(e: Expr & { kind: "reduce" }, stack: readonly string[], unknowns: ReadonlySet<string>, env: Env): Value {
    const names = new Set(e.bounds.map((b) => b.variable));
    const bounds = e.bounds.map((b) => {
      const lo = this.scalar(this.resolveValue(b.lo, stack, unknowns, env));
      const hi = this.scalar(this.resolveValue(b.hi, stack, unknowns, env));
      for (const name of [...freeVars(lo, CONSTANT_NAMES), ...freeVars(hi, CONSTANT_NAMES)]) {
        if (names.has(name)) throw new EntryError(`The range of ${b.variable} can't depend on ${name}`);
      }
      return { variable: b.variable, lo, hi };
    });
    const inner = new Map(env);
    for (const name of names) inner.set(name, V(name));
    const innerUnknowns = new Set([...unknowns].filter((name) => !names.has(name)));
    const body = this.scalar(this.resolveValue(e.expr, stack, innerUnknowns, inner));
    if (someNode(body, (n) => n.kind === "deriv" || n.kind === "tuple")) {
      throw new EntryError(`${e.op} needs something it can evaluate, without unknown derivatives or points`);
    }
    if ((e.op === "argmin" || e.op === "argmax") && bounds.length > 1) {
      // One coordinate per entry; they share a single search when evaluated.
      return matrix(
        bounds.length,
        1,
        bounds.map((_, k): Expr => ({ kind: "reduce", op: e.op, expr: body, bounds, component: k })),
      );
    }
    return { kind: "reduce", op: e.op, expr: body, bounds, component: null };
  }

  /**
   * Integrals. Bounds are innermost first, and each may use the variables
   * integrated outside it but not its own or those inside it.
   */
  private integralValue(e: Expr & { kind: "integral" }, stack: readonly string[], unknowns: ReadonlySet<string>, env: Env): Value {
    const names = e.bounds.map((b) => b.variable);
    const shadowing = (from: number): Env => {
      const scope = new Map(env);
      for (const name of names.slice(from)) scope.set(name, V(name));
      return scope;
    };
    const bounds = e.bounds.map((b, k) => {
      const scope = shadowing(k + 1);
      const lo = this.scalar(this.resolveValue(b.lo, stack, unknowns, scope));
      const hi = this.scalar(this.resolveValue(b.hi, stack, unknowns, scope));
      for (const name of [...freeVars(lo, CONSTANT_NAMES), ...freeVars(hi, CONSTANT_NAMES)]) {
        const index = names.indexOf(name);
        if (index >= 0 && index < k) {
          throw new EntryError(`The range of ${b.variable} can't depend on ${name}, which is integrated inside it; list bounds innermost first`);
        }
      }
      return { variable: b.variable, lo, hi };
    });
    const inner = shadowing(0);
    const innerUnknowns = new Set([...unknowns].filter((name) => !names.includes(name)));
    const body = this.scalar(this.resolveValue(e.expr, stack, innerUnknowns, inner));
    const region = e.region ? this.scalar(this.resolveValue(e.region, stack, innerUnknowns, inner)) : null;
    if ([body, ...(region ? [region] : [])].some((x) => someNode(x, (n) => n.kind === "deriv" || n.kind === "tuple"))) {
      throw new EntryError("int needs something it can evaluate, without unknown derivatives or points");
    }
    return { kind: "integral", expr: body, bounds, region };
  }

  private derivValue(e: Expr & { kind: "deriv" }, stack: readonly string[], unknowns: ReadonlySet<string>, env: Env): Value {
    // A derivative of a bare name, or a chain like d/dx(d/dx(y)) or u_xt, stays for the solvers.
    const chain = partialOf(e);
    if (chain) {
      const target = this.lookup(chain.base, env);
      if (target && isMatrix(target)) {
        if (chain.orders.size === 0) return chain.primes % 2 === 1 ? transpose(target) : target;
        if (chain.primes > 0) throw new EntryError(`Write transpose(${chain.base}) rather than mixing ' with d/d${[...chain.orders.keys()][0]}`);
        return mapEntries(target, (x) => {
          let d = x;
          for (const [variable, order] of chain.orders) d = this.derivativeOf(d, variable, order);
          return d;
        });
      }
      const boundTo = env.get(chain.base);
      const selfBound = boundTo !== undefined && !isMatrix(boundTo) && boundTo.kind === "var" && boundTo.name === chain.base;
      if (boundTo === undefined || selfBound) {
        if (boundTo === undefined && this.constants.has(chain.base)) return ZERO;
        if (e.expr.kind === "var" && e.variable === chain.base) return N(e.order === 1 ? 1 : 0);
        return e;
      }
    }
    const inner = this.resolveValue(e.expr, stack, unknowns, env);
    if (isComplex(inner)) {
      if (e.variable === null) throw new EntryError("Use d/dx(...) to differentiate a complex expression");
      const v = e.variable;
      return settle(complex(this.totalDerivative(inner.re, v, e.order, unknowns), this.totalDerivative(inner.im, v, e.order, unknowns)));
    }
    if (isMatrix(inner)) {
      // A prime on a matrix is its transpose, as in MATLAB.
      if (e.variable === null) return e.order % 2 === 1 ? transpose(inner) : inner;
      return mapEntries(inner, (x) => this.totalDerivative(x, e.variable!, e.order, unknowns));
    }
    // Resolving can reveal a bare name, as with an identity function.
    if (inner.kind === "var" || partialOf(inner)) return this.resolveValue({ ...e, expr: inner }, stack, unknowns, EMPTY_ENV);
    if (e.variable === null) throw new EntryError("Use d/dx(...) to differentiate an expression");
    return this.totalDerivative(inner, e.variable, e.order, unknowns);
  }

  /**
   * d/dv of an expression that may contain unknown functions of v.
   *
   * Each unknown, and each derivative of one, stands in as a placeholder name.
   * The expression is differentiated as usual, and every placeholder then adds
   * its chain-rule term, the derivative with respect to it times its own next
   * derivative. So d/dx(y^2) becomes 2y y', and d/dx(x y') becomes y' + x y''.
   * Names that aren't unknowns stay constant, as in a partial derivative.
   */
  private totalDerivative(e: Expr, v: string, order: number, unknowns: ReadonlySet<string>): Expr {
    const placeholder = (base: string, k: number): Expr => V(`${base}#${k}`);
    const split = (name: string): [string, number] => {
      const at = name.lastIndexOf("#");
      return [name.slice(0, at), Number(name.slice(at + 1))];
    };
    let result = e;
    for (let step = 0; step < order; step++) {
      const flatten = (n: Expr): Expr => {
        if (n.kind === "deriv") {
          const p = partialOf(n);
          if (!p) throw new EntryError("Can't take that derivative");
          const other = [...p.orders.keys()].find((k) => k !== v);
          if (other) throw new EntryError(`Mixed derivatives like ${p.base}_${other}${v} aren't supported`);
          return placeholder(p.base, p.primes + (p.orders.get(v) ?? 0));
        }
        if (n.kind === "var" && n.name !== v && unknowns.has(n.name)) return placeholder(n.name, 0);
        return mapChildren(n, flatten);
      };
      const flat = flatten(result);
      const held = [...freeVars(flat, CONSTANT_NAMES)].filter((name) => name.includes("#"));
      let d = differentiate(flat, v);
      for (const name of held) {
        const [base, k] = split(name);
        d = add(d, mul(differentiate(flat, name), placeholder(base, k + 1)));
      }
      d = simplify(d);
      const back = new Map<string, Expr>();
      for (const name of freeVars(d, CONSTANT_NAMES)) {
        if (!name.includes("#")) continue;
        const [base, k] = split(name);
        back.set(name, k === 0 ? V(base) : { kind: "deriv", expr: V(base), variable: v, order: k });
      }
      result = substitute(d, back);
    }
    return result;
  }

  /**
   * Names that depend on whatever a derivative is taken with respect to:
   * anything already written with derivative notation or given conditions,
   * and in a 2D line the vertical axis, so d/dx(x^2 + y^2) = 0 differentiates
   * implicitly. In a 3D line the axes are independent and derivatives stay partial.
   */
  private unknownCandidates(sides: readonly Expr[], ast: EntryAst): Set<string> {
    const out = new Set<string>();
    const walk = (n: Expr): void => {
      if (n.kind === "deriv") {
        const p = partialOf(n);
        if (p) out.add(p.base);
      }
      if (n.kind === "apply" && n.primes > 0 && !FUNCTIONS[n.name]) out.add(n.name);
      mapChildren(n, (child) => {
        walk(child);
        return child;
      });
    };
    sides.forEach(walk);
    for (const c of ast.conditions ?? []) {
      if (c.left.kind === "apply") out.add(c.left.name.split("_")[0]!);
    }
    const threeD = ast.axes ? ast.axes.length === 3 : sides.some((side) => freeVars(side, CONSTANT_NAMES).has("z"));
    if (!threeD) out.add(ast.axes ? ast.axes[1]! : "y");
    for (const name of [...out]) {
      if ((this.constants.has(name) && !this.lineUnknowns.has(name)) || this.functions.has(name)) out.delete(name);
    }
    return out;
  }

  // Definitions

  private functionEntry(line: DocumentLine, ast: EntryAst, def: FunctionDef, track: Tracker): EntryAnalysis {
    const value = unwrap(this.resolveValue(def.body, [def.name], NO_UNKNOWNS, shadow(def.params)));
    if (isComplex(value)) {
      return this.base(line, { kind: "function", description: `function ${def.name}(${def.params.join(", ")}), complex valued` });
    }
    const entries = isMatrix(value) ? simplifyMatrix(value).entries : [value];
    if (entries.some((x) => someNode(x, (n) => n.kind === "deriv" || n.kind === "tuple"))) {
      throw new EntryError("A function's body can't contain unknown derivatives or tuples");
    }
    const signature = `${def.name}(${def.params.join(", ")})`;
    const expandedBody = someNode(def.body, (n) => n.kind === "apply" || n.kind === "deriv");
    if (isMatrix(value)) {
      for (const x of entries) this.bindParams(x, def.params, track);
      return this.base(line, {
        kind: "function",
        description: `function ${signature}, ${describe(value)}`,
        resolved: expandedBody ? `${signature} = ${formatExpr(matrixNode(value, entries), { display: true })}` : null,
      });
    }
    const body = value;
    const resolved = expandedBody ? `${signature} = ${formatExpr(simplify(body), { display: true })}` : null;

    // A function of x and y plots itself as a surface, the way z = f(x, y) would.
    if (def.params.length === 2 && def.params.includes("x") && def.params.includes("y")) {
      this.bindParams(body, def.params, track);
      const fn = compileFunction(body, def.params);
      const P = this.params;
      const r = (i: number): Range | null => (ast.intervals?.[i] ? this.range(ast.intervals[i]!, track) : null);
      const f = def.params[0] === "x" ? (a: number, b: number) => fn(a, b, P) : (a: number, b: number) => fn(b, a, P);
      return this.base(line, {
        kind: "function",
        description: `function ${signature}, drawn as z = ${signature}`,
        dimension: 3,
        axes: ["x", "y", "z"],
        surfaces: [{ kind: "explicitSurface", color: line.color, f, x: r(0) ?? DEFAULT_BOX, y: r(1) ?? DEFAULT_BOX, zClip: r(2) }],
        resolved,
      });
    }

    // A function of x alone plots itself, the way y = f(x) would.
    if (def.params.length === 1 && def.params[0] === "x") {
      const plot = this.explicit(body, "x", line.color, ast.intervals, track);
      return this.base(line, { kind: "function", description: `function ${signature}`, plots: [plot.plot], fit: plot.fit, resolved });
    }
    this.bindParams(body, def.params, track);
    return this.base(line, { kind: "function", description: `function ${signature}`, resolved });
  }

  private constantEntry(line: DocumentLine, ast: EntryAst, def: ConstantDef, track: Tracker): EntryAnalysis {
    let shape: Value;
    try {
      shape = unwrap(this.resolveValue(def.expr));
    } catch (error) {
      if (error instanceof ComplexEigenvalues && isEigCall(def.expr)) return this.eigenEntry(line, def.name, error.values);
      throw error;
    }
    if (isMatrix(shape)) return this.matrixConstantEntry(line, ast, def, simplifyMatrix(shape), track);
    if (isComplex(shape)) {
      if (ast.intervals) throw new EntryError("A complex number doesn't take a range");
      this.bindParams(shape.re, [], track);
      this.bindParams(shape.im, [], track);
      const numbers = this.numbersOf([simplify(shape.re), simplify(shape.im)]);
      return this.base(line, {
        kind: "constant",
        description: `${def.name} = ${numbers ? formatComplex({ re: numbers[0]!, im: numbers[1]! }) : "a complex number"}`,
        axes: ["Re", "Im"],
        plots: numbers ? [{ kind: "point", color: line.color, x: numbers[0]!, y: numbers[1]! }] : [],
      });
    }
    const value = this.valueOf(def.name, { uses: new Set(), missing: new Set() });
    const failure = this.constantErrors.get(def.name);
    if (failure) throw new EntryError(failure);
    // Record what the definition itself reads.
    this.bindParams(this.resolve(def.expr), [], track);

    if (!def.slider) {
      return this.base(line, { kind: "constant", description: `${def.name} = ${fmt(value)}` });
    }
    if (ast.intervals && ast.intervals.length > 1) throw new EntryError("A slider takes one range, like [0, 10]");
    const interval = ast.intervals?.[0];
    // [0.1] alone sets the step and keeps the default bounds.
    const bounds =
      interval && interval.lo && interval.hi
        ? this.range(interval, track)
        : { lo: Math.min(DEFAULT_SLIDER.lo, value), hi: Math.max(DEFAULT_SLIDER.hi, value) };
    const step = interval?.step
      ? this.evaluate(this.resolve(interval.step), track)
      : niceStep((bounds.hi - bounds.lo) / 40);
    if (!(step > 0)) throw new EntryError("A slider's step must be positive");

    const span = locateValue(line.source, def.name);
    if (span) {
      this.sliders.push({
        id: line.id,
        name: def.name,
        value,
        min: bounds.lo,
        max: bounds.hi,
        step,
        valueStart: span[0],
        valueEnd: span[1],
      });
    }
    return this.base(line, { kind: "slider", description: `slider ${fmt(bounds.lo)} to ${fmt(bounds.hi)}` });
  }

  private matrixConstantEntry(line: DocumentLine, ast: EntryAst, def: ConstantDef, m: MatrixValue, track: Tracker): EntryAnalysis {
    if (ast.intervals) throw new EntryError("A matrix doesn't take a range");
    for (const x of m.entries) this.bindParams(x, [], track);
    const numbers = this.numbersOf(m.entries);
    const shown = this.formatValue(m, numbers);
    const resolved = shown === formatExpr(def.expr, { display: true }) ? null : `${def.name} = ${shown}`;
    return this.base(line, {
      kind: "constant",
      description: `${def.name}, ${describe(m)}`,
      resolved,
      transform: this.transformOf(def.expr),
      ...(numbers && isVector(m) ? this.arrow(numbers, line.color) : {}),
    });
  }

  /** Every entry's value, or null when any depends on something other than defined constants. */
  private numbersOf(entries: readonly Expr[]): number[] | null {
    const out: number[] = [];
    for (const e of entries) {
      if ([...freeVars(e, CONSTANT_NAMES)].some((name) => !this.constants.has(name))) return null;
      const value = this.evaluate(e, { uses: new Set(), missing: new Set() });
      if (!Number.isFinite(value)) return null;
      out.push(value);
    }
    return out;
  }

  private formatValue(m: MatrixValue, numbers: readonly number[] | null): string {
    const entries = numbers ? numbers.map((value) => N(Number(value.toPrecision(6)))) : m.entries;
    return formatExpr(matrixNode(m, entries), { display: true });
  }

  /** A vector with two or three numeric entries, drawn from the origin. */
  private arrow(values: readonly number[], color: string): Partial_<EntryAnalysis> {
    if (values.length === 2) {
      return { plots: [{ kind: "arrow", color, x0: 0, y0: 0, x1: values[0]!, y1: values[1]! }] };
    }
    if (values.length === 3) {
      return {
        dimension: 3,
        axes: ["x", "y", "z"],
        surfaces: [{ kind: "arrow3d", color, x: values[0]!, y: values[1]!, z: values[2]! }],
      };
    }
    return {};
  }

  // Plots

  private plotEntry(line: DocumentLine, ast: EntryAst, track: Tracker): EntryAnalysis {
    const st = ast.statement;
    const system = this.systemOf(ast);
    if (system) return this.systemEntry(line, ast, system, track);
    const original = st.kind === "expr" ? [st.expr] : [st.left, st.right];
    // Subscripts become derivatives before resolving, so d/dx(k u_x) can apply the chain rule to u_x.
    this.lineUnknowns = this.claimedUnknowns(original, ast);
    const subscripted = this.convertSubscripts(original, ast);
    const unknowns = this.unknownCandidates(subscripted, ast);
    const claimed = shadow([...this.lineUnknowns]);
    let values: Value[];
    try {
      values = subscripted.map((s) => unwrap(this.resolveValue(s, [], unknowns, claimed)));
    } catch (error) {
      if (error instanceof ComplexEigenvalues && st.kind === "expr" && isEigCall(st.expr)) return this.eigenEntry(line, null, error.values);
      throw error;
    }
    if (values.some(isMatrix)) return this.matrixLine(line, ast, values, track);
    if (values.some(isComplex)) return this.complexLine(line, ast, values, track);
    const sides = values as Expr[];
    const expanded = original.some((s) =>
      someNode(s, (n) => n.kind === "apply" || (n.kind === "deriv" && partialOf(n) === null)),
    );
    const resolvedText = (): string => {
      const shown = sides.map((s) => formatExpr(simplify(s), { display: true }));
      return st.kind === "expr" ? shown[0]! : `${shown[0]} ${st.op} ${shown[1]}`;
    };

    if (sides.some((s) => someNode(s, (n) => n.kind === "tuple"))) {
      return this.tupleEntry(line, ast, sides, track);
    }

    const converted = sides;
    const partials = collectPartials(converted);
    if (partials.length > 0) {
      const bases = new Set(partials.map((p) => p.base));
      if (bases.size > 1) {
        throw new EntryError(`One unknown function per equation for now; this has ${[...bases].join(" and ")}`);
      }
      const dependent = [...bases][0]!;
      const variables = new Set(partials.flatMap((p) => [...p.orders.keys()]));
      if (variables.has(dependent)) throw new EntryError(`${dependent} can't be differentiated by itself`);
      let entry: EntryAnalysis;
      if (variables.size >= 2) {
        const names = [...variables];
        if (names.length === 2) {
          const axis = ast.axes?.[1];
          const time = names.includes("t") ? "t" : axis && names.includes(axis) ? axis : names[1]!;
          const space = names.find((n) => n !== time)!;
          const timeOrder = Math.max(...partials.map((p) => p.orders.get(time) ?? 0));
          this.shape = { kind: "pde", dependent, space, time, timeOrder };
        }
        const general = (ast.conditions ?? []).some(
          (c) => (c.right.kind === "var" && c.right.name === PERIODIC) || freeVars(c.right, CONSTANT_NAMES).has("boundary"),
        );
        entry =
          names.length === 2 && !general
            ? this.pdeEntry(line, ast, converted, dependent, names, partials, track)
            : this.fieldEntry(line, ast, converted, dependent, names, partials, track);
      } else {
        const independent = variables.size === 1 ? [...variables][0]! : this.defaultIndependent(ast, dependent, converted);
        const order = Math.max(...partials.map((p) => p.primes + (p.orders.get(independent) ?? 0)));
        this.shape = { kind: "ode", dependent, independent, order };
        entry = this.odeEntry(line, ast, converted, dependent, independent, partials, track);
      }
      return expanded ? { ...entry, resolved: resolvedText() } : entry;
    }

    if (ast.conditions) throw new EntryError("Conditions only apply to differential equations");
    const result = this.relationEntry(line, ast, sides, track);
    return expanded ? { ...result, resolved: resolvedText() } : result;
  }

  /** A line whose value is a vector or matrix: an arrow, a parametric curve, a system of equations, or just the result. */
  private matrixLine(line: DocumentLine, ast: EntryAst, values: readonly Value[], track: Tracker): EntryAnalysis {
    if (ast.conditions) throw new EntryError("Conditions only apply to differential equations");
    const st = ast.statement;
    if (st.kind === "relation") return this.matrixRelation(line, ast, st.op, values, track);
    const m = simplifyMatrix(values[0] as MatrixValue);
    const transform = this.transformOf(st.expr);
    if (isVector(m) && (m.entries.length === 2 || m.entries.length === 3)) {
      return { ...this.tupleEntry(line, ast, [{ kind: "tuple", items: [...m.entries] }], track, m), transform };
    }
    for (const x of m.entries) this.bindParams(x, [], track);
    return this.base(line, {
      kind: "constant",
      description: describe(m),
      resolved: `= ${this.formatValue(m, this.numbersOf(m.entries))}`,
      transform,
    });
  }

  /**
   * A complex value: a point in the complex plane when it's a number, a curve
   * when it varies with one parameter. An equation compares real and imaginary
   * parts, drawn together, so their crossings are the solutions.
   */
  private complexLine(line: DocumentLine, ast: EntryAst, values: readonly Value[], track: Tracker): EntryAnalysis {
    if (ast.conditions) throw new EntryError("Conditions only apply to differential equations");
    const st = ast.statement;
    if (st.kind === "relation") {
      if (st.op !== "=") throw new EntryError("Complex numbers can't be compared with < or >; compare abs(...) instead");
      const entry = this.matrixRelation(line, ast, "=", values, track);
      return entry.plots.length + entry.surfaces.length > 1 ? { ...entry, description: "real and imaginary parts, drawn together" } : entry;
    }
    const z = toComplex(values[0] as Expr | ComplexValue);
    const re = simplify(z.re);
    const im = simplify(z.im);
    const free = [...new Set([...freeVars(re, CONSTANT_NAMES), ...freeVars(im, CONSTANT_NAMES)])].filter((n) => !this.constants.has(n));
    if (free.length === 0) {
      this.bindParams(re, [], track);
      this.bindParams(im, [], track);
      const numbers = this.numbersOf([re, im]);
      const shown = numbers ? formatComplex({ re: numbers[0]!, im: numbers[1]! }) : "a complex number";
      return this.base(line, {
        description: `complex number ${shown}`,
        axes: ["Re", "Im"],
        plots: numbers ? [{ kind: "point", color: line.color, x: numbers[0]!, y: numbers[1]! }] : [],
        resolved: `= ${shown}`,
      });
    }
    if (free.length > 1) {
      throw new EntryError(`A complex value over ${free.join(" and ")} needs abs(...), re(...), im(...) or arg(...) to draw`);
    }
    const entry = this.tupleEntry(line, ast, [{ kind: "tuple", items: [re, im] }], track);
    return { ...entry, axes: ["Re", "Im"], description: `complex curve in ${free[0]}` };
  }

  /**
   * An equation between vectors or matrices is one equation per entry, all
   * drawn together, so their crossings are the solutions. Entries that always
   * hold are skipped; one that never holds is an error.
   */
  private matrixRelation(
    line: DocumentLine,
    ast: EntryAst,
    op: "=" | "<" | ">" | "<=" | ">=",
    values: readonly Value[],
    track: Tracker,
  ): EntryAnalysis {
    // Checks the shapes, with the usual message when they don't match.
    this.binaryValue("-", values[0]!, values[1]!);
    // A complex side is its real and imaginary parts.
    const grid = (v: Value): MatrixValue => (isComplex(v) ? matrix(2, 1, [v.re, v.im]) : asMatrix(v));
    const left = grid(values[0]!);
    const right = grid(values[1]!);
    const count = Math.max(left.entries.length, right.entries.length);
    const at = (m: MatrixValue, k: number): Expr => (isScalarMatrix(m) ? m.entries[0]! : m.entries[k]!);
    const parts: EntryAnalysis[] = [];
    for (let k = 0; k < count; k++) {
      const l = simplify(at(left, k));
      const r = simplify(at(right, k));
      if (someNode(l, (n) => n.kind === "deriv") || someNode(r, (n) => n.kind === "deriv")) {
        throw new EntryError("Systems of differential equations aren't supported yet");
      }
      const difference = simplify(sub(l, r));
      if (difference.kind === "num") {
        const d = difference.value;
        const holds = op === "=" ? d === 0 : op === "<" ? d < 0 : op === ">" ? d > 0 : op === "<=" ? d <= 0 : d >= 0;
        if (holds) continue;
        throw new EntryError(`Entry ${k + 1}, ${formatExpr(l, { display: true })} ${op} ${formatExpr(r, { display: true })}, never holds`);
      }
      try {
        parts.push(this.relationEntry(line, ast, [l, r], track));
      } catch (error) {
        throw new EntryError(`Entry ${k + 1}: ${errorMessage(error)}`);
      }
    }
    if (parts.length === 0) throw new EntryError("Every entry always holds, so there's nothing to draw");
    const dimension = parts[0]!.dimension;
    if (parts.some((p) => p.dimension !== dimension)) throw new EntryError("Some entries are 2D and some 3D; keep them to one");
    return this.base(line, {
      description: parts.length === 1 ? parts[0]!.description : `${parts.length} equations, drawn together`,
      dimension,
      axes: parts[0]!.axes,
      plots: parts.flatMap((p) => p.plots),
      surfaces: parts.flatMap((p) => p.surfaces),
      fit: parts[0]!.fit,
    });
  }

  /** Complex eigenvalues as points in the complex plane. */
  private eigenEntry(line: DocumentLine, name: string | null, values: readonly Complex[]): EntryAnalysis {
    const shown = values.map(formatComplex).join(", ");
    return this.base(line, {
      kind: name ? "constant" : "plot",
      description: `eigenvalues ${shown}`,
      axes: ["Re", "Im"],
      plots: values.map((v): Plot2D => ({ kind: "point", color: line.color, x: v.re, y: v.im })),
      resolved: `${name ? `${name} = ` : "= "}${shown}`,
    });
  }

  /**
   * The steps a product of numeric 2×2 or 3×3 matrices takes, rightmost first,
   * with a trailing vector as what they act on. Null for anything else.
   */
  private transformOf(e: Expr): TransformInfo | null {
    const factors: Expr[] = [];
    const flatten = (n: Expr): void => {
      if (n.kind === "binary" && n.op === "*") {
        flatten(n.left);
        flatten(n.right);
      } else {
        factors.push(n);
      }
    };
    flatten(e);
    try {
      const values = factors.map((f) => unwrap(this.resolveValue(f)));
      const square = values.find((v): v is MatrixValue => isMatrix(v) && v.rows === v.cols);
      const n = square?.rows;
      if (n !== 2 && n !== 3) return null;
      const steps: TransformStep[] = [];
      let vectors: number[][] = [];
      for (let i = factors.length - 1; i >= 0; i--) {
        const value = values[i]!;
        if (isComplex(value)) return null;
        const numbers = this.numbersOf(isMatrix(value) ? value.entries : [value]);
        if (!numbers) return null;
        const label = formatExpr(factors[i]!, { display: true });
        if (!isMatrix(value)) {
          // A number scales everything, like that multiple of the identity.
          steps.push({ label, matrix: Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => (r === c ? numbers[0]! : 0))) });
        } else if (value.rows === n && value.cols === n) {
          steps.push({ label, matrix: Array.from({ length: n }, (_, r) => numbers.slice(r * n, (r + 1) * n)) });
        } else if (i === factors.length - 1 && value.rows === n && value.cols === 1) {
          vectors = [numbers];
        } else {
          return null;
        }
      }
      return { dimension: n, steps, vectors };
    } catch {
      return null;
    }
  }

  /**
   * A line claims a name as its own unknown, even if another line defines it,
   * when it gives the name conditions, differentiates it by a named variable,
   * or takes its Laplacian. Primes alone don't claim, since A' is a transpose.
   */
  private claimedUnknowns(sides: readonly Expr[], ast: EntryAst): Set<string> {
    const out = new Set<string>();
    for (const c of ast.conditions ?? []) {
      if (c.left.kind === "apply" || c.left.kind === "var") out.add(c.left.name.split("_")[0]!);
    }
    for (const side of sides) {
      someNode(side, (n) => {
        const partial = n.kind === "deriv" && n.variable !== null ? partialOf(n) : null;
        if (partial) out.add(partial.base);
        if (n.kind === "apply" && n.name === "lap" && n.args[0]?.kind === "var") out.add(n.args[0].name);
        return false;
      });
    }
    return new Set([...out].filter((name) => this.constants.has(name)));
  }

  /** The space variables lap(u) sums over: from the axes, then a starting condition, else x and y. */
  private laplacianSpace(dependent: string | null): string[] {
    const ast = this.currentAst;
    if (ast?.axes) {
      const names = ast.axes.filter((a) => a !== dependent);
      return names.includes("t") ? names.filter((a) => a !== "t") : names.slice(0, -1);
    }
    for (const c of ast?.conditions ?? []) {
      if (c.left.kind !== "apply" || c.left.name.split("_")[0] !== dependent || c.left.args.length < 2) continue;
      const names = c.left.args.slice(0, -1).map((a) => (a.kind === "var" ? a.name : null));
      if (names.every((n) => n !== null)) return names as string[];
    }
    return ["x", "y"];
  }

  /**
   * PDEs on a box in one to three space dimensions, with Dirichlet, Neumann or
   * periodic faces. Shown as a heatmap over x and y, a surface when the
   * dependent variable is among the axes, or an isosurface in 3D.
   */
  private fieldEntry(
    line: DocumentLine,
    ast: EntryAst,
    sides: readonly Expr[],
    u: string,
    variables: readonly string[],
    partials: readonly Partial[],
    track: Tracker,
  ): EntryAnalysis {
    const axisOrder = ast.axes ?? [];
    const time = variables.includes("t") ? "t" : [...axisOrder].reverse().find((a) => variables.includes(a) && a !== u);
    if (!time) throw new EntryError("Call the time variable t, or list it after the space variables, like {x, y, s}");
    const natural = ["x", "y", "z"];
    const rank = (a: string): number => (axisOrder.includes(a) ? axisOrder.indexOf(a) : 100 + (natural.includes(a) ? natural.indexOf(a) : 5));
    const space = variables.filter((v) => v !== time).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    const d = space.length;
    if (d > 3) throw new EntryError("At most three space variables are supported");

    let timeOrder = 0;
    const mixed: [number, number][] = [];
    for (const p of partials) {
      if (p.primes > 0) throw new EntryError(`Use ${u}_${time} or d${u}/d${time} here, not primes`);
      const tk = p.orders.get(time) ?? 0;
      const orders = space.map((a) => p.orders.get(a) ?? 0);
      const total = orders.reduce((s, k) => s + k, 0);
      if (tk > 0 && total > 0) throw new EntryError("Mixed time and space derivatives aren't supported");
      if (total > 2) throw new EntryError("Up to second derivatives in space are supported here");
      const ones = orders.flatMap((k, a) => (k === 1 ? [a] : []));
      if (ones.length === 2 && !mixed.some(([a, b]) => a === ones[0] && b === ones[1])) mixed.push([ones[0]!, ones[1]!]);
      timeOrder = Math.max(timeOrder, tk);
    }
    if (timeOrder === 0) throw new EntryError(`Needs a time derivative, like ${u}_${time}`);
    if (timeOrder > 2) throw new EntryError("At most second order in time is supported");

    const slot = (name: string): string => `${u}#${name}`;
    const replace = (e: Expr): Expr => {
      const p = e.kind === "deriv" ? partialOf(e) : null;
      if (p) {
        const tk = p.orders.get(time) ?? 0;
        if (tk > 0) return V(tk === timeOrder ? slot("s") : slot("v"));
        const used = space.flatMap((a, i) => ((p.orders.get(a) ?? 0) > 0 ? [[i, p.orders.get(a)!] as const] : []));
        if (used.length === 1) return V(slot(`${used[0]![1] === 1 ? "d" : "dd"}${used[0]![0]}`));
        return V(slot(`m${mixed.findIndex(([a, b]) => a === used[0]![0] && b === used[1]![0])}`));
      }
      return mapChildren(e, replace);
    };
    const F = simplify(sub(replace(sides[0]!), sides[1] ? replace(sides[1]) : ZERO));
    const Fs = simplify(differentiate(F, slot("s")));
    const linear = isZero(simplify(differentiate(Fs, slot("s"))));
    if (isZero(Fs)) throw new EntryError(`The time derivative of ${u} cancels out`);
    const args = [
      ...space,
      time,
      u,
      ...space.map((_, i) => slot(`d${i}`)),
      ...space.map((_, i) => slot(`dd${i}`)),
      ...mixed.map((_, j) => slot(`m${j}`)),
      slot("v"),
      slot("s"),
    ];
    this.bindParams(F, args, track);

    const listed = [...space, time];
    const order = ast.axes ? ast.axes.filter((a) => a !== u) : listed;
    if (ast.axes && !listed.every((a) => order.includes(a))) throw new EntryError(`Name the axes {${listed.join(", ")}}`);
    const rangeOf = (name: string, fallback: Range): Range => {
      const interval = ast.intervals?.[order.indexOf(name)];
      return interval ? this.range(interval, track) : fallback;
    };
    const box = space.map((a) => rangeOf(a, DEFAULT_PDE_SPACE));
    const timeRange = rangeOf(time, DEFAULT_PDE_TIME);

    const P = this.params;
    type Closure = (...values: (number | typeof P)[]) => number;
    const usage = `Write conditions like ${u}(${space.join(", ")}, ${fmt(timeRange.lo)}) = ..., ${u} = 0 on boundary, or periodic`;
    const mentions = (e: Expr): boolean => [...freeVars(e, CONSTANT_NAMES)].some((n) => listed.includes(n));
    const onFace = (expr: Expr): ((point: readonly number[], t: number) => number) => {
      this.bindParams(expr, listed, track);
      const fn = compileFunction(expr, listed) as unknown as Closure;
      return (point, t) => fn(...point, t, P);
    };
    const periodicFace: FaceCondition = { kind: "periodic" };
    const faces: [FaceCondition, FaceCondition][] = space.map(() => [DEFAULT_FACE, DEFAULT_FACE]);
    let initial: ((point: readonly number[]) => number) | null = null;
    let velocity: ((point: readonly number[]) => number) | null = null;
    const keys: string[] = [];

    for (const c of ast.conditions ?? []) {
      keys.push(formatExpr(c.left), formatExpr(c.right));
      if (c.right.kind === "var" && c.right.name === PERIODIC) {
        const named = c.left.kind === "apply" ? c.left.args.map((a) => (a.kind === "var" ? a.name : "")) : space;
        for (const name of named) {
          const i = space.indexOf(name);
          if (i < 0) throw new EntryError("periodic takes space variables, like periodic(x)");
          faces[i] = [periodicFace, periodicFace];
        }
        continue;
      }
      if (c.left.kind === "var" && c.left.name === u) {
        const factors: Expr[] = [];
        const flatten = (n: Expr): void => {
          if (n.kind === "binary" && n.op === "*") {
            flatten(n.left);
            flatten(n.right);
          } else {
            factors.push(n);
          }
        };
        flatten(c.right);
        const n = factors.length;
        const isName = (e: Expr | undefined, name: string): boolean => e?.kind === "var" && e.name === name;
        if (n >= 3 && isName(factors[n - 2], "on") && isName(factors[n - 1], "boundary")) {
          const value = onFace(this.resolve(factors.slice(0, n - 2).reduce((a, b) => mul(a, b))));
          faces.forEach((pair, i) => {
            if (pair[0].kind !== "periodic") faces[i] = [{ kind: "dirichlet", value }, { kind: "dirichlet", value }];
          });
          continue;
        }
        throw new EntryError(usage);
      }
      if (c.left.kind !== "apply" || c.left.primes > 0 || c.left.args.length !== d + 1) throw new EntryError(usage);
      const [base, subscript = ""] = c.left.name.split("_");
      if (base !== u) throw new EntryError(usage);
      const spatial = c.left.args.slice(0, d);
      const at = c.left.args[d]!;
      const rhs = this.resolve(c.right);
      const named = (e: Expr, name: string): boolean => e.kind === "var" && e.name === name;

      if (spatial.every((a, i) => named(a, space[i]!)) && !mentions(at)) {
        if (Math.abs(this.evaluate(this.resolve(at), track) - timeRange.lo) > 1e-9) {
          throw new EntryError(`Starting values go at ${time} = ${fmt(timeRange.lo)}, where the time range starts`);
        }
        this.bindParams(rhs, space, track);
        const fn = compileFunction(rhs, space) as unknown as Closure;
        const profile = (point: readonly number[]): number => fn(...point, P);
        if (subscript === "") initial = profile;
        else if (subscript === time) velocity = profile;
        else throw new EntryError(usage);
        continue;
      }
      const fixed = spatial.flatMap((a, i) => (named(a, space[i]!) ? [] : [i]));
      const i = fixed[0];
      if (named(at, time) && fixed.length === 1 && i !== undefined && !mentions(spatial[i]!)) {
        const where = this.evaluate(this.resolve(spatial[i]!), track);
        const side = Math.abs(where - box[i]!.lo) < 1e-9 ? 0 : Math.abs(where - box[i]!.hi) < 1e-9 ? 1 : -1;
        if (side < 0) throw new EntryError(`Boundary conditions go at ${space[i]} = ${fmt(box[i]!.lo)} or ${fmt(box[i]!.hi)}`);
        const kind: "dirichlet" | "neumann" | null = subscript === "" ? "dirichlet" : subscript === space[i] ? "neumann" : null;
        if (!kind) throw new EntryError(usage);
        faces[i]![side as 0 | 1] = { kind, value: onFace(rhs) };
        continue;
      }
      throw new EntryError(usage);
    }
    if (!initial) {
      throw new EntryError(`Needs a starting profile, like [${u}(${space.join(", ")}, ${fmt(timeRange.lo)}) = ...]`);
    }

    const key = JSON.stringify(["field", formatExpr(F), args, Object.entries(P), keys, box, timeRange]);
    const start = initial;
    const solution = cached(key, () =>
      solveField({
        timeOrder: timeOrder as 1 | 2,
        F: compileFunction(F, args),
        Fs: compileFunction(Fs, args),
        linear,
        params: P,
        box,
        time: timeRange,
        initial: start,
        initialVelocity: velocity,
        faces,
        mixed,
      }),
    );
    const note = solution.blewUpAt !== null ? `The solution blew up at ${time} = ${fmt(solution.blewUpAt)}` : null;
    const description = `PDE for ${u}(${listed.join(", ")}), ${ordinal(timeOrder)} order in time`;

    if (d === 1) {
      // One space variable reads like the 1D solver's output, so it shows and plays the same way.
      const flat: PdeSolution = {
        space: box[0]!,
        time: timeRange,
        cols: solution.sizes[0]!,
        rows: solution.frames,
        values: solution.values,
        min: solution.min,
        max: solution.max,
        blewUpAt: solution.blewUpAt,
        steps: solution.steps,
      };
      const surface = ast.axes?.includes(u) ?? false;
      const shared = { note, description, pde: { dependent: u, space: space[0]!, time, solution: flat, display: surface ? "surface" : "heatmap" } as PdeInfo, timeRange, fit: { h: box[0]!, v: timeRange } };
      const grid = { values: flat.values, cols: flat.cols, rows: flat.rows, min: flat.min, max: flat.max };
      return surface
        ? this.base(line, { ...shared, dimension: 3, axes: [space[0]!, time, u], surfaces: [{ kind: "gridSurface", color: line.color, ...grid, x: box[0]!, y: timeRange }] })
        : this.base(line, { ...shared, axes: [space[0]!, time], plots: [{ kind: "heatmap", color: line.color, ...grid, h: box[0]!, v: timeRange }] });
    }

    const display = d === 3 ? "isosurface" : ast.axes?.includes(u) ? "surface" : "heatmap";
    const level = this.constants.has("level") ? this.valueOf("level", track) : (solution.min + solution.max) / 2;
    const info: FieldInfo = { dependent: u, space, time, solution, display, level };
    return this.base(line, {
      note,
      description,
      dimension: display === "heatmap" ? 2 : 3,
      axes: display === "surface" ? [...space, u] : space,
      plots: fieldPlots(info, timeRange.lo, line.color),
      surfaces: fieldSurfaces(info, timeRange.lo, line.color),
      field: info,
      timeRange,
      fit: display === "heatmap" ? { h: box[0]!, v: box[1]! } : null,
    });
  }

  private stateEnv(name: string, size: number): Env {
    return new Map([[name, matrix(size, 1, Array.from({ length: size }, (_, k) => V(`${name}#${k + 1}`)))]]);
  }

  /**
   * A line like X' = [X(2); -X(1)] or X' = A * X: a first-order system in a
   * vector unknown. Its size comes from a starting vector, the axes, or the
   * first size the right side makes sense at.
   */
  private systemOf(ast: EntryAst): { name: string; size: number; time: string } | null {
    const st = ast.statement;
    if (st.kind !== "relation" || st.op !== "=" || st.left.kind !== "deriv") return null;
    const partial = partialOf(st.left);
    if (!partial || this.constants.has(partial.base) || this.functions.has(partial.base)) return null;
    const orders = [...partial.orders];
    if (partial.primes + orders.reduce((sum, [, k]) => sum + k, 0) !== 1) return null;
    const name = partial.base;
    const time = orders[0]?.[0] ?? "t";
    const isMatrixName = (n: string): boolean => {
      try {
        return this.matrixConstant(n) !== null;
      } catch {
        return false;
      }
    };
    const lengthOf = (e: Expr): number | null => {
      if (e.kind === "matrix") return e.rows.flat().length > 1 ? e.rows.flat().length : null;
      if (e.kind === "var" && isMatrixName(e.name)) return this.matrixConstant(e.name)!.entries.length;
      return null;
    };
    const given = (ast.conditions ?? []).map((c) => lengthOf(c.right)).find((n) => n !== null) ?? null;
    const indexed = someNode(st.right, (n) => n.kind === "apply" && n.name === name);
    const matrixLike = someNode(st.right, (n) => n.kind === "matrix") || [...freeVars(st.right, CONSTANT_NAMES)].some(isMatrixName);
    if (given === null && !indexed && !matrixLike) return null;
    const sizes = given !== null ? [given] : ast.axes ? [ast.axes.length] : [2, 3, 4, 5, 6];
    for (const size of sizes) {
      try {
        const value = unwrap(this.resolveValue(st.right, [], NO_UNKNOWNS, this.stateEnv(name, size)));
        if (isMatrix(value) && isVector(value) && value.entries.length === size) return { name, size, time };
      } catch {
        // Try the next size.
      }
    }
    return given !== null || indexed ? { name, size: sizes[0]!, time } : null;
  }

  private systemEntry(line: DocumentLine, ast: EntryAst, spec: { name: string; size: number; time: string }, track: Tracker): EntryAnalysis {
    const { name, size, time } = spec;
    const st = ast.statement as Extract<EntryAst["statement"], { kind: "relation" }>;
    const components = Array.from({ length: size }, (_, k) => `${name}#${k + 1}`);
    const value = unwrap(this.resolveValue(st.right, [], NO_UNKNOWNS, this.stateEnv(name, size)));
    if (!isMatrix(value) || !isVector(value) || value.entries.length !== size) {
      throw new EntryError(`${name}' needs one rate per component, like ${name}' = [${name}(2); -${name}(1)]`);
    }
    const rates = value.entries.map((e) => simplify(e));
    if (rates.some((r) => someNode(r, (n) => n.kind === "deriv" || n.kind === "tuple"))) {
      throw new EntryError("A system's rates can't contain other derivatives; write higher orders as extra components");
    }
    const args = [time, ...components];
    for (const r of rates) this.bindParams(r, args, track);
    const P = this.params;
    const system: StateSystem = { size, rates: rates.map((r) => compileFunction(r, args)), params: P };
    const autonomous = rates.every((r) => !freeVars(r, CONSTANT_NAMES).has(time));
    if (ast.axes && ast.axes.length !== size && size <= 3) throw new EntryError(`Name ${size} axes, one per component`);
    const labels = ast.axes ?? components.map((_, k) => `${name}${k + 1}`);
    const range = (i: number, fallback: Range): Range => (ast.intervals?.[i] ? this.range(ast.intervals[i]!, track) : fallback);
    const span = range(0, DEFAULT_SYSTEM_SPAN);
    const window = components.map((_, k) => range(k + 1, DEFAULT_BOX));

    const starts = (ast.conditions ?? []).map((c) => {
      let t0 = 0;
      if (c.left.kind === "apply" && c.left.name === name && c.left.args.length === 1) {
        t0 = this.evaluate(this.resolve(c.left.args[0]!), track);
      } else if (!(c.left.kind === "var" && (c.left.name === `${name}0` || c.left.name === `${name}_0`))) {
        throw new EntryError(`Write starting values like ${name}(0) = [${Array(size).fill(1).join("; ")}]`);
      }
      const numbers = this.numbersOf(asMatrix(this.realOrMatrix(unwrap(this.resolveValue(c.right)))).entries);
      if (!numbers || numbers.length !== size) {
        throw new EntryError(`A starting value for ${name} needs ${size} numbers, like [${Array(size).fill(1).join("; ")}]`);
      }
      return { t0, start: numbers };
    });
    const paramKey = Object.entries(P).map(([k, v]) => `${k}=${v}`);
    const formatted = rates.map((r) => formatExpr(r));
    const orbits = starts.map((s) => cached(JSON.stringify(["system", formatted, args, paramKey, s, span]), () => solveOrbit(system, s.t0, s.start, span)));
    const info: SystemInfo = { name, time, size, span, orbits };
    const shared = {
      description: `system of ${size} equations in ${name}(${time})${autonomous ? "" : ", depending on time"}`,
      timeRange: orbits.length > 0 ? span : null,
      system: info,
    };

    // The Jacobian, exactly, for equilibria and their stability.
    let jacobian: { compiled: ReturnType<typeof compileFunction>[]; numbers: number[] | null } | null = null;
    if (autonomous) {
      try {
        const entries = rates.flatMap((r) => components.map((c) => simplify(differentiate(r, c))));
        for (const e of entries) this.bindParams(e, args, track);
        jacobian = { compiled: entries.map((e) => compileFunction(e, args)), numbers: this.numbersOf(entries) };
      } catch {
        jacobian = null;
      }
    }
    const equilibria = jacobian ? findEquilibria(system, jacobian.compiled, window, span.lo) : [];

    if (size === 2) {
      const rate = stateRates(system);
      const plots: Plot2D[] = [
        { kind: "vectors", color: line.color, field: (h, v, out) => rate(span.lo, [h, v], out), clipH: null, clipV: null },
      ];
      if (autonomous) {
        for (const compiled of system.rates) {
          plots.push({ kind: "field", color: GUIDE_COLOR, F: (a, b) => compiled(span.lo, a, b, P), region: null, clipH: null, clipV: null });
        }
        // A linear system through the origin also shows its eigenvector lines.
        const origin = [0, 0];
        rate(span.lo, [0, 0], origin);
        if (jacobian?.numbers && origin.every((r) => Math.abs(r) < 1e-12)) {
          const [a, b, c, d] = jacobian.numbers as [number, number, number, number];
          for (const { vector } of realEigenvectors([[a, b], [c, d]])) {
            plots.push({ kind: "parametric", color: GUIDE_COLOR, x: (s) => vector[0]! * s, y: (s) => vector[1]! * s, range: { lo: -100, hi: 100 } });
          }
        }
      }
      for (const e of equilibria) plots.push({ kind: "equilibrium", color: line.color, x: e.point[0]!, y: e.point[1]!, stable: e.stable });
      for (const o of orbits) {
        plots.push({ kind: "orbit", color: line.color, h: o.states[0]!, v: o.states[1]!, t: o.t, h0: o.start[0]!, v0: o.start[1]! });
      }
      return this.base(line, { ...shared, axes: labels.slice(0, 2), plots, fit: { h: window[0]!, v: window[1]! } });
    }

    if (size === 3) {
      const surfaces: Surface3D[] = orbitSurfaces(info, line.color, null);
      for (const e of equilibria) surfaces.push({ kind: "point3d", color: line.color, x: e.point[0]!, y: e.point[1]!, z: e.point[2]! });
      if (surfaces.length === 0) throw new EntryError(`Give a starting value, like [${name}(0) = [1; 0; 0]]`);
      return this.base(line, { ...shared, dimension: 3, axes: labels.slice(0, 3), surfaces });
    }

    if (orbits.length === 0) throw new EntryError(`Give a starting value, like [${name}(0) = [${Array(size).fill(1).join("; ")}]]`);
    const plots = orbits.flatMap((o) => o.states.map((values, k): Plot2D => ({ kind: "trajectory", color: line.color, h: o.t, v: values, t0: o.t0, v0: o.start[k]! })));
    return this.base(line, { ...shared, description: `${shared.description}, each component over ${time}`, axes: [time, name], plots, fit: { h: span, v: null } });
  }

  /**
   * Reads u_t and u_xx as derivatives when there is evidence u is an unknown
   * function: it appears bare, in conditions or axes, or with more than one
   * subscript. A lone k_B stays an ordinary name, and p_0 always does.
   */
  private convertSubscripts(sides: readonly Expr[], ast: EntryAst): readonly Expr[] {
    const names = new Set<string>();
    for (const side of sides) for (const n of freeVars(side, CONSTANT_NAMES)) names.add(n);
    const pattern = SUBSCRIPT_DERIVATIVE;

    const groups = new Map<string, string[]>();
    for (const name of names) {
      const match = pattern.exec(name);
      if (!match || (this.constants.has(name) && !this.lineUnknowns.has(match[1]!))) continue;
      const list = groups.get(match[1]!) ?? [];
      list.push(name);
      groups.set(match[1]!, list);
    }
    if (groups.size === 0) return sides;

    const conditionBases = new Set<string>();
    for (const c of ast.conditions ?? []) {
      if (c.left.kind === "apply" || c.left.kind === "var") conditionBases.add(c.left.name.split("_")[0]!);
    }

    const bindings = new Map<string, Expr>();
    for (const [base, list] of groups) {
      if (this.constants.has(base) && !this.lineUnknowns.has(base)) continue;
      const evidence = list.length >= 2 || names.has(base) || conditionBases.has(base) || ast.axes?.includes(base);
      if (!evidence) continue;
      for (const name of list) {
        let node: Expr = V(base);
        for (const letter of name.slice(2)) node = { kind: "deriv", expr: node, variable: letter, order: 1 };
        bindings.set(name, node);
      }
    }
    return bindings.size ? sides.map((s) => substitute(s, bindings)) : sides;
  }

  private defaultIndependent(ast: EntryAst, dependent: string, sides: readonly Expr[]): string {
    if (ast.axes) {
      const other = ast.axes.find((a) => a !== dependent);
      if (other) return other;
    }
    const names = new Set(sides.flatMap((s) => [...freeVars(s, CONSTANT_NAMES)]));
    if (names.has("t") && dependent !== "t") return "t";
    return dependent === "x" ? "t" : "x";
  }

  private explicit(
    e: Expr,
    h: string,
    color: string,
    intervals: readonly IntervalAst[] | null,
    track: Tracker,
  ): { plot: Plot2D; fit: EntryAnalysis["fit"] } {
    this.bindParams(e, [h], track);
    const fn = compileFunction(e, [h]);
    const P = this.params;
    const domain = intervals?.[0] ? this.range(intervals[0], track) : null;
    const clip = intervals?.[1] ? this.range(intervals[1], track) : null;
    return {
      plot: { kind: "explicit", color, f: (x) => fn(x, P), domain, clip },
      fit: domain || clip ? { h: domain, v: clip } : null,
    };
  }

  private relationEntry(line: DocumentLine, ast: EntryAst, sides: readonly Expr[], track: Tracker): EntryAnalysis {
    if (ast.axes && ast.axes.length > 3) throw new EntryError("Four axes are for PDEs over space and time, like {x, y, z, t}");
    const axes = ast.axes ?? ["x", "y", "z"];
    const h = axes[0]!;
    const v = axes[1]!;
    const w = axes[2] ?? null;
    const st = ast.statement;
    const has = (e: Expr, name: string | null): boolean => name !== null && freeVars(e, CONSTANT_NAMES).has(name);
    const intervals = ast.intervals ?? [];
    const r = (i: number): Range | null => (intervals[i] ? this.range(intervals[i]!, track) : null);
    const P = this.params;

    const explicit = (e: Expr): EntryAnalysis => {
      const { plot, fit } = this.explicit(e, h, line.color, ast.intervals, track);
      return this.base(line, { description: `curve, ${v} = f(${h})`, axes: [h, v], plots: [plot], fit });
    };
    const field = (F: Expr, region: { strict: boolean } | null): EntryAnalysis => {
      if (!has(F, h) && !has(F, v)) throw new EntryError(`Nothing to plot: there's no ${h} or ${v} here`);
      this.bindParams(F, [h, v], track);
      const fn = compileFunction(F, [h, v]);
      const clipH = r(0);
      const clipV = r(1);
      return this.base(line, {
        description: region ? "shaded region" : `implicit curve in ${h} and ${v}`,
        axes: [h, v],
        plots: [{ kind: "field", color: line.color, F: (a, b) => fn(a, b, P), region, clipH, clipV }],
        fit: clipH || clipV ? { h: clipH, v: clipV } : null,
      });
    };
    const surface = (e: Expr): EntryAnalysis => {
      this.bindParams(e, [h, v], track);
      const fn = compileFunction(e, [h, v]);
      return this.base(line, {
        description: `surface, ${w} = f(${h}, ${v})`,
        dimension: 3,
        axes: [h, v, w!],
        surfaces: [
          { kind: "explicitSurface", color: line.color, f: (a, b) => fn(a, b, P), x: r(0) ?? DEFAULT_BOX, y: r(1) ?? DEFAULT_BOX, zClip: r(2) },
        ],
      });
    };
    const implicit3d = (F: Expr): EntryAnalysis => {
      this.bindParams(F, [h, v, w!], track);
      const fn = compileFunction(F, [h, v, w!]);
      return this.base(line, {
        description: `implicit surface in ${h}, ${v} and ${w}`,
        dimension: 3,
        axes: [h, v, w!],
        surfaces: [
          {
            kind: "implicitSurface",
            color: line.color,
            F: (a, b, c) => fn(a, b, c, P),
            box: [r(0) ?? DEFAULT_BOX, r(1) ?? DEFAULT_BOX, r(2) ?? DEFAULT_BOX],
            fit: intervals.length === 0,
          },
        ],
      });
    };

    if (st.kind === "expr") {
      const e = sides[0]!;
      if (has(e, w)) return implicit3d(e);
      if (has(e, v)) return field(e, null);
      return explicit(e);
    }

    const left = sides[0]!;
    const right = sides[1]!;
    if (st.op === "=") {
      if (left.kind === "var" && left.name === v && !has(right, v) && !has(right, w)) return explicit(right);
      if (right.kind === "var" && right.name === v && !has(left, v) && !has(left, w)) return explicit(left);
      if (w && left.kind === "var" && left.name === w && !has(right, w)) return surface(right);
      if (w && right.kind === "var" && right.name === w && !has(left, w)) return surface(left);
      const F = simplify(sub(left, right));
      return has(F, w) ? implicit3d(F) : field(F, null);
    }

    // Inequalities normalise to F < 0 so the renderer tests one direction.
    const raw = simplify(sub(left, right));
    const F = st.op === "<" || st.op === "<=" ? raw : neg(raw);
    if (has(F, w)) throw new EntryError("3D inequalities aren't supported yet");
    return field(F, { strict: st.op === "<" || st.op === ">" });
  }

  private tupleEntry(
    line: DocumentLine,
    ast: EntryAst,
    sides: readonly Expr[],
    track: Tracker,
    vector: MatrixValue | null = null,
  ): EntryAnalysis {
    const st = ast.statement;
    const tuple = sides[0]!;
    if (st.kind !== "expr" || tuple.kind !== "tuple") {
      throw new EntryError("A point or parametric curve stands on its own, like (cos(t), sin(t))");
    }
    const items = tuple.items;
    if (items.some((i) => someNode(i, (n) => n.kind === "tuple" || n.kind === "deriv"))) {
      throw new EntryError("Coordinates can't contain tuples or unknown derivatives");
    }
    const dim = items.length;
    const free = [...new Set(items.flatMap((i) => [...freeVars(i, CONSTANT_NAMES)]))].filter((n) => !this.constants.has(n));

    let params: string[];
    if (dim === 2) {
      if (free.length === 0) params = [];
      else if (free.includes("t")) params = ["t"];
      else if (free.length === 1) params = [free[0]!];
      else throw new EntryError(`Use t as the parameter; any of ${free.join(", ")} could be it`);
    } else if (free.includes("u") && free.includes("v")) {
      params = ["u", "v"];
    } else if (free.includes("t")) {
      params = ["t"];
    } else if (free.length <= 2) {
      params = [...free].sort();
    } else {
      throw new EntryError("Use t for a 3D curve, or u and v for a surface");
    }

    const axes = ast.axes ?? (dim === 2 ? ["x", "y"] : ["x", "y", "z"]);
    if (ast.axes && ast.axes.length !== dim) throw new EntryError(`Name ${dim} axes for ${dim} coordinates`);
    for (const item of items) this.bindParams(item, params, track);
    const fns = items.map((item) => compileFunction(item, params));
    const P = this.params;
    const r = (i: number): Range => (ast.intervals?.[i] ? this.range(ast.intervals[i]!, track) : DEFAULT_PARAMETER_RANGE);

    if (params.length === 0) {
      const numbers = fns.map((f) => (f as (p: typeof P) => number)(P));
      const [x, y, z] = numbers;
      if (vector) {
        const shown = this.formatValue(vector, numbers.every(Number.isFinite) ? numbers : null);
        const resolved = shown === formatExpr(st.expr, { display: true }) ? null : `= ${shown}`;
        return this.base(line, { description: `vector, ${describe(vector)}`, axes, resolved, ...this.arrow(numbers, line.color) });
      }
      const resolved = null;
      if (dim === 2) {
        return this.base(line, { description: "point", axes, plots: [{ kind: "point", color: line.color, x: x!, y: y! }], resolved });
      }
      return this.base(line, {
        description: "point",
        dimension: 3,
        axes,
        surfaces: [{ kind: "point3d", color: line.color, x: x!, y: y!, z: z! }],
      });
    }

    const one = (i: number) => (t: number) => fns[i]!(t, P);
    const two = (i: number) => (a: number, b: number) => fns[i]!(a, b, P);
    if (dim === 2) {
      return this.base(line, {
        description: `parametric curve in ${params[0]}`,
        axes,
        plots: [{ kind: "parametric", color: line.color, x: one(0), y: one(1), range: r(0) }],
      });
    }
    if (params.length === 1) {
      return this.base(line, {
        description: `3D curve in ${params[0]}`,
        dimension: 3,
        axes,
        surfaces: [{ kind: "curve3d", color: line.color, x: one(0), y: one(1), z: one(2), range: r(0) }],
      });
    }
    return this.base(line, {
      description: `parametric surface in ${params[0]} and ${params[1]}`,
      dimension: 3,
      axes,
      surfaces: [{ kind: "parametricSurface", color: line.color, x: two(0), y: two(1), z: two(2), u: r(0), v: r(1) }],
    });
  }

  // Differential equations

  private odeEntry(
    line: DocumentLine,
    ast: EntryAst,
    sides: readonly Expr[],
    dependent: string,
    independent: string,
    partials: readonly Partial[],
    track: Tracker,
  ): EntryAnalysis {
    if (ast.axes && (ast.axes.length !== 2 || !ast.axes.includes(dependent) || !ast.axes.includes(independent))) {
      throw new EntryError(`Name the axes {${independent}, ${dependent}} for this equation`);
    }
    const st = ast.statement;
    if (st.kind === "relation" && st.op !== "=") throw new EntryError("Differential equations use =, not an inequality");

    const orderOf = (p: Partial): number => p.primes + (p.orders.get(independent) ?? 0);
    const order = Math.max(...partials.map(orderOf));
    const stateName = (k: number): string => (k === 0 ? dependent : `${dependent}#${k}`);
    const replace = (e: Expr): Expr => {
      if (e.kind === "deriv") {
        const partial = partialOf(e);
        if (partial) return V(stateName(orderOf(partial)));
      }
      return mapChildren(e, replace);
    };

    const F = simplify(sub(replace(sides[0]!), sides[1] ? replace(sides[1]) : ZERO));
    const s = stateName(order);
    const Fs = simplify(differentiate(F, s));
    const linear = isZero(simplify(differentiate(Fs, s)));
    if (isZero(Fs)) throw new EntryError(`The derivative of ${dependent} cancels out`);

    const args = [independent, ...Array.from({ length: order }, (_, k) => stateName(k)), s];
    this.bindParams(F, args, track);
    const system: OdeSystem = {
      order,
      F: compileFunction(F, args),
      Fs: compileFunction(Fs, args),
      linear,
      params: this.params,
    };

    const span = ast.intervals?.[0] ? this.range(ast.intervals[0], track) : DEFAULT_ODE_SPAN;
    const window = ast.intervals?.[1] ? this.range(ast.intervals[1], track) : null;
    const groups = this.odeConditions(ast.conditions ?? [], dependent, order, track);
    if (order > 1 && groups.length === 0) {
      const example = [`${dependent}(0) = 1`, ...Array.from({ length: order - 1 }, (_, k) => `${dependent}${"'".repeat(k + 1)}(0) = 0`)];
      throw new EntryError(`A ${ordinal(order)}-order equation needs starting values, like [${example.join(", ")}]`);
    }

    const paramKey = [...freeVars(F, CONSTANT_NAMES)].filter((n) => !args.includes(n)).map((n) => `${n}=${this.params[n]}`);
    const solutions = groups.map((g) => {
      const lo = Math.min(span.lo, g.t0);
      const hi = Math.max(span.hi, g.t0);
      const key = JSON.stringify(["ode", formatExpr(F), args, paramKey, g.t0, g.values, lo, hi]);
      return cached(key, () => solveIvp(system, g.t0, g.values, [lo, hi]));
    });

    const plots: Plot2D[] = [];
    if (order === 1) {
      const state = new Float64Array(1);
      plots.push({
        kind: "slopes",
        color: line.color,
        slopes: (h, v, out) => {
          state[0] = v;
          highestRoots(system, h, state, out);
        },
        clipH: ast.intervals?.[0] ? span : null,
        clipV: window,
      });
    }
    solutions.forEach((solution, i) => {
      plots.push({
        kind: "trajectory",
        color: line.color,
        h: solution.t,
        v: solution.y,
        t0: groups[i]!.t0,
        v0: groups[i]!.values[0]!,
      });
    });

    const assumed = groups.some((g) => g.defaulted);
    return this.base(line, {
      description: `${ordinal(order)}-order differential equation in ${dependent}(${independent})${linear ? "" : ", solved implicitly"}`,
      note: assumed ? "Missing starting derivatives are taken as 0" : null,
      axes: [independent, dependent],
      plots,
      ode: { dependent, independent, order, linear, span, solutions },
      timeRange: solutions.length ? span : null,
      fit: ast.intervals ? { h: span, v: window } : null,
    });
  }

  private odeConditions(
    conditions: readonly ConditionAst[],
    dependent: string,
    order: number,
    track: Tracker,
  ): { t0: number; values: number[]; defaulted: boolean }[] {
    const groups: { t0: number; values: (number | undefined)[] }[] = [];
    let current: { t0: number; values: (number | undefined)[] } | null = null;

    for (const c of conditions) {
      const left = c.left;
      let k: number;
      let at: number;
      if (left.kind === "apply" && left.name === dependent && left.args.length === 1) {
        k = left.primes;
        at = this.evaluate(this.resolve(left.args[0]!), track);
      } else if (left.kind === "var" && (left.name === `${dependent}0` || left.name === `${dependent}_0`)) {
        k = 0;
        at = 0;
      } else {
        throw new EntryError(`Write starting values like ${dependent}(0) = 1`);
      }
      if (k >= order) {
        throw new EntryError(`${dependent}${"'".repeat(k)} isn't a starting value for a ${ordinal(order)}-order equation`);
      }
      const value = this.evaluate(this.resolve(c.right), track);
      if (!current || current.values[k] !== undefined || current.t0 !== at) {
        current = { t0: at, values: new Array<number | undefined>(order).fill(undefined) };
        groups.push(current);
      }
      current.values[k] = value;
    }
    return groups.map((g) => ({
      t0: g.t0,
      values: g.values.map((v) => v ?? 0),
      defaulted: g.values.some((v) => v === undefined),
    }));
  }

  private pdeEntry(
    line: DocumentLine,
    ast: EntryAst,
    sides: readonly Expr[],
    dependent: string,
    variables: readonly string[],
    partials: readonly Partial[],
    track: Tracker,
  ): EntryAnalysis {
    if (variables.length > 2) throw new EntryError("Only one space variable is supported");
    let time: string;
    if (variables.includes("t")) time = "t";
    else if (ast.axes && ast.axes.length >= 2 && variables.includes(ast.axes[1]!)) time = ast.axes[1]!;
    else throw new EntryError("Call the time variable t, or list the axes like {x, t, u}");
    const space = variables.find((v) => v !== time)!;

    let timeOrder = 0;
    let spaceOrder = 0;
    for (const p of partials) {
      if (p.primes > 0) throw new EntryError(`Use ${dependent}_${time} or d${dependent}/d${time} here, not primes`);
      const tk = p.orders.get(time) ?? 0;
      const sk = p.orders.get(space) ?? 0;
      if (tk > 0 && sk > 0) throw new EntryError(`Mixed derivatives like ${dependent}_${space}${time} aren't supported`);
      timeOrder = Math.max(timeOrder, tk);
      spaceOrder = Math.max(spaceOrder, sk);
    }
    if (timeOrder === 0) throw new EntryError(`Needs a time derivative, like ${dependent}_${time}`);
    if (timeOrder > 2) throw new EntryError("At most second order in time is supported");
    if (spaceOrder > 4) throw new EntryError("At most fourth order in space is supported");
    if (ast.axes && (!ast.axes.includes(space) || !ast.axes.includes(time) || (ast.axes.length === 3 && !ast.axes.includes(dependent)))) {
      throw new EntryError(`Name the axes {${space}, ${time}} or {${space}, ${time}, ${dependent}}`);
    }

    const slot = (suffix: string): string => `${dependent}#${suffix}`;
    const replace = (e: Expr): Expr => {
      if (e.kind === "deriv") {
        const partial = partialOf(e);
        if (partial) {
          const tk = partial.orders.get(time) ?? 0;
          const sk = partial.orders.get(space) ?? 0;
          if (sk > 0) return V(slot(`x${sk}`));
          return V(tk === timeOrder ? slot("s") : slot("v"));
        }
      }
      return mapChildren(e, replace);
    };
    const F = simplify(sub(replace(sides[0]!), sides[1] ? replace(sides[1]) : ZERO));
    const s = slot("s");
    const Fs = simplify(differentiate(F, s));
    const linear = isZero(simplify(differentiate(Fs, s)));
    if (isZero(Fs)) throw new EntryError(`The time derivative of ${dependent} cancels out`);

    const args = [space, time, dependent, slot("x1"), slot("x2"), slot("x3"), slot("x4"), slot("v"), s];
    this.bindParams(F, args, track);

    const order = ast.axes ?? [space, time];
    const intervalFor = (name: string): IntervalAst | undefined => ast.intervals?.[order.indexOf(name)];
    const spaceInterval = intervalFor(space);
    const timeInterval = intervalFor(time);
    const spaceRange = spaceInterval ? this.range(spaceInterval, track) : DEFAULT_PDE_SPACE;
    const timeRange = timeInterval ? this.range(timeInterval, track) : DEFAULT_PDE_TIME;

    const P = this.params;
    let initial: ((x: number) => number) | null = null;
    let initialVelocity: ((x: number) => number) | null = null;
    let left: Boundary = DEFAULT_BOUNDARY;
    let right: Boundary = DEFAULT_BOUNDARY;
    const usage = `Write conditions like ${dependent}(${space}, ${fmt(timeRange.lo)}) = ... or ${dependent}(${fmt(spaceRange.lo)}, ${time}) = ...`;
    const mentions = (e: Expr): boolean => {
      const vars = freeVars(e, CONSTANT_NAMES);
      return vars.has(space) || vars.has(time);
    };
    const conditionKeys: string[] = [];

    for (const c of ast.conditions ?? []) {
      const l = c.left;
      if (l.kind !== "apply" || l.args.length !== 2 || l.primes > 0) throw new EntryError(usage);
      const [name, subscript = ""] = l.name.split("_");
      if (name !== dependent) throw new EntryError(usage);
      const [a0, a1] = l.args as [Expr, Expr];
      const rhs = this.resolve(c.right);
      conditionKeys.push(formatExpr(c.left), formatExpr(rhs));

      if (a0.kind === "var" && a0.name === space && !mentions(a1)) {
        const at = this.evaluate(this.resolve(a1), track);
        if (Math.abs(at - timeRange.lo) > 1e-9) {
          throw new EntryError(`Starting values go at ${time} = ${fmt(timeRange.lo)}, where the time range starts`);
        }
        this.bindParams(rhs, [space], track);
        const fn = compileFunction(rhs, [space]);
        if (subscript === "") initial = (x) => fn(x, P);
        else if (subscript === time) initialVelocity = (x) => fn(x, P);
        else throw new EntryError(usage);
      } else if (a1.kind === "var" && a1.name === time && !mentions(a0)) {
        const at = this.evaluate(this.resolve(a0), track);
        this.bindParams(rhs, [time], track);
        const fn = compileFunction(rhs, [time]);
        const kind = subscript === "" ? "dirichlet" : subscript === space ? "neumann" : null;
        if (!kind) throw new EntryError(usage);
        const boundary: Boundary = { kind, value: (t) => fn(t, P) };
        if (Math.abs(at - spaceRange.lo) < 1e-9) left = boundary;
        else if (Math.abs(at - spaceRange.hi) < 1e-9) right = boundary;
        else throw new EntryError(`Boundary conditions go at ${space} = ${fmt(spaceRange.lo)} or ${fmt(spaceRange.hi)}`);
      } else {
        throw new EntryError(usage);
      }
    }
    if (!initial) {
      throw new EntryError(`Needs a starting profile, like [${dependent}(${space}, ${fmt(timeRange.lo)}) = sin(${space})]`);
    }

    const paramKey = Object.entries(P).map(([k, value]) => `${k}=${value}`);
    const key = JSON.stringify(["pde", formatExpr(F), paramKey, conditionKeys, spaceRange, timeRange, left.kind, right.kind]);
    const problem = {
      timeOrder: timeOrder as 1 | 2,
      spaceOrder,
      F: compileFunction(F, args),
      Fs: compileFunction(Fs, args),
      linear,
      params: P,
      space: spaceRange,
      time: timeRange,
      initial,
      initialVelocity,
      left,
      right,
    };
    const solution = cached(key, () => solvePde(problem));

    const display = ast.axes?.length === 3 ? "surface" : "heatmap";
    const note = solution.blewUpAt !== null ? `The solution blew up at ${time} = ${fmt(solution.blewUpAt)}` : null;
    const shared = {
      note,
      description: `PDE for ${dependent}(${space}, ${time}), ${ordinal(timeOrder)} order in time`,
      pde: { dependent, space, time, solution, display } as PdeInfo,
      timeRange,
      fit: { h: spaceRange, v: timeRange },
    };
    if (display === "surface") {
      return this.base(line, {
        ...shared,
        dimension: 3,
        axes: [space, time, dependent],
        surfaces: [
          {
            kind: "gridSurface",
            color: line.color,
            values: solution.values,
            cols: solution.cols,
            rows: solution.rows,
            x: spaceRange,
            y: timeRange,
            min: solution.min,
            max: solution.max,
          },
        ],
      });
    }
    return this.base(line, {
      ...shared,
      axes: [space, time],
      plots: [
        {
          kind: "heatmap",
          color: line.color,
          values: solution.values,
          cols: solution.cols,
          rows: solution.rows,
          h: spaceRange,
          v: timeRange,
          min: solution.min,
          max: solution.max,
        },
      ],
    });
  }
}

type Partial_<T> = { [K in keyof T]?: T[K] };

/** Analyzes every line of a document together. */
export function analyzeDocument(lines: readonly DocumentLine[], options: AnalyzeOptions = {}): DocumentAnalysis {
  return new Analyzer(lines, options).run();
}
