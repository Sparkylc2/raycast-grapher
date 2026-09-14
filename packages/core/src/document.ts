import { type ConditionAst, type EntryAst, type Expr, type IntervalAst, freeVars, someNode } from "./ast.js";
import { CONSTANT_NAMES, FUNCTIONS, realPow } from "./builtins.js";
import { compileFunction } from "./compile-js.js";
import { type IvpSolution, type OdeSystem, highestRoots, solveIvp } from "./ode.js";
import { parseEntry } from "./parser.js";
import { type Boundary, DEFAULT_BOUNDARY, type PdeSolution, solvePde } from "./pde.js";
import type { Plot2D, Range, Surface3D } from "./plot.js";
import { differentiate, formatExpr, mapChildren, neg, simplify, sub, substitute } from "./symbolic.js";

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
}

export interface DocumentAnalysis {
  readonly entries: readonly EntryAnalysis[];
  readonly sliders: readonly SliderInfo[];
  readonly params: Readonly<Record<string, number>>;
}

class EntryError extends Error {}

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
/** What a name nobody has defined evaluates to, so a half-written document still draws. */
export const MISSING_VALUE = 1;

const V = (name: string): Expr => ({ kind: "var", name });
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

function definitionOf(ast: EntryAst): { kind: "function"; def: FunctionDef } | { kind: "constant"; def: ConstantDef } | null {
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
    return { kind: "function", def: { name: left.name, params, body: st.right } };
  }

  if (left.kind === "var" && !COORDINATES.has(left.name)) {
    const vars = freeVars(st.right, CONSTANT_NAMES);
    if ([...vars].some((v) => COORDINATES.has(v)) || vars.has(left.name)) return null;
    // u_t = u_xx and y_x = y relate derivatives of one unknown; they are not definitions.
    const base = SUBSCRIPT_DERIVATIVE.exec(left.name)?.[1];
    if (base && [...vars].some((v) => v === base || SUBSCRIPT_DERIVATIVE.exec(v)?.[1] === base)) return null;
    if (someNode(st.right, (n) => n.kind === "deriv" || n.kind === "tuple")) return null;
    return { kind: "constant", def: { name: left.name, expr: st.right, slider: st.right.kind === "num" } };
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

/** Formats a slider value with no more precision than its step implies. */
export function formatSliderValue(value: number, step: number): string {
  const decimals = Math.max(0, Math.min(10, -Math.floor(Math.log10(step) + 1e-9)));
  return String(Number(value.toFixed(decimals)));
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

  constructor(lines: readonly DocumentLine[]) {
    this.parsed = lines.map((line) => {
      try {
        return { line, ast: parseEntry(line.source), error: null };
      } catch (error) {
        return { line, ast: null, error: errorMessage(error) };
      }
    });

    for (const { line, ast } of this.parsed) {
      if (!ast) continue;
      const definition = definitionOf(ast);
      if (!definition) continue;
      const name = definition.def.name;
      if (this.functions.has(name) || this.constants.has(name)) {
        this.roles.set(line.id, { kind: "duplicate", message: `${name} is already defined` });
        continue;
      }
      if (definition.kind === "function") this.functions.set(name, definition.def);
      else this.constants.set(name, definition.def);
      this.roles.set(line.id, definition);
    }
  }

  run(): DocumentAnalysis {
    const entries = this.parsed.map((p) => this.analyzeLine(p.line, p.ast, p.error));
    return { entries, sliders: this.sliders, params: this.params };
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
      ...overrides,
    };
  }

  private analyzeLine(line: DocumentLine, ast: EntryAst | null, parseError: string | null): EntryAnalysis {
    if (!ast) return this.base(line, { kind: "error", error: parseError, description: "error" });
    const track: Tracker = { uses: new Set(), missing: new Set() };
    try {
      const role = this.roles.get(line.id);
      let result: EntryAnalysis;
      if (role?.kind === "duplicate") throw new EntryError(role.message);
      else if (role?.kind === "function") result = this.functionEntry(line, ast, role.def, track);
      else if (role?.kind === "constant") result = this.constantEntry(line, ast, role.def, track);
      else result = this.plotEntry(line, ast, track);
      return { ...result, uses: [...track.uses].sort(), missing: [...track.missing].sort() };
    } catch (error) {
      return this.base(line, {
        kind: "error",
        error: errorMessage(error),
        description: "error",
        uses: [...track.uses].sort(),
        missing: [...track.missing].sort(),
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
      default:
        throw new EntryError("Expected a number here");
    }
  }

  private range(interval: IntervalAst, track: Tracker): Range {
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

  /** Expands user functions and works out every derivative that can be worked out. */
  private resolve(e: Expr, stack: readonly string[] = []): Expr {
    switch (e.kind) {
      case "apply": {
        const args = e.args.map((a) => this.resolve(a, stack));
        const def = this.functions.get(e.name);
        if (def) {
          if (stack.includes(def.name)) throw new EntryError(`${def.name} is defined in terms of itself`);
          if (args.length !== def.params.length) {
            const n = def.params.length;
            throw new EntryError(`${def.name} takes ${n} argument${n === 1 ? "" : "s"}`);
          }
          let body = this.resolve(def.body, [...stack, def.name]);
          if (e.primes > 0) {
            if (def.params.length !== 1) throw new EntryError(`${def.name}' needs a function of one variable`);
            body = this.derivativeOf(body, def.params[0]!, e.primes);
          }
          return substitute(body, new Map(def.params.map((p, i) => [p, args[i]!] as const)));
        }
        if (FUNCTIONS[e.name]) {
          // Only primed built-ins reach here, such as sin'(x).
          if (args.length !== 1) throw new EntryError(`${e.name}' needs one argument`);
          const u = "#u";
          const body = this.derivativeOf({ kind: "call", name: e.name, args: [V(u)] }, u, e.primes);
          return substitute(body, new Map([[u, args[0]!]]));
        }
        if (e.primes > 0) {
          const only = args[0];
          if (args.length === 1 && only?.kind === "var") {
            return { kind: "deriv", expr: V(e.name), variable: only.name, order: e.primes };
          }
          throw new EntryError(`Put starting values in brackets, like [${e.name}(0) = 1]`);
        }
        if (args.length === 1) return { kind: "binary", op: "*", left: V(e.name), right: args[0]! };
        throw new EntryError(`${e.name} isn't defined; define it first, like ${e.name}(x, y) = ...`);
      }
      case "deriv": {
        const inner = this.resolve(e.expr, stack);
        if (inner.kind === "var") {
          if (this.constants.has(inner.name)) return ZERO;
          if (e.variable === inner.name) return { kind: "num", value: e.order === 1 ? 1 : 0 };
          return { ...e, expr: inner };
        }
        if (e.variable === null) throw new EntryError("Use d/dx(...) to differentiate an expression");
        return this.derivativeOf(inner, e.variable, e.order);
      }
      default:
        return mapChildren(e, (child) => this.resolve(child, stack));
    }
  }

  // Definitions

  private functionEntry(line: DocumentLine, ast: EntryAst, def: FunctionDef, track: Tracker): EntryAnalysis {
    const body = this.resolve(def.body, [def.name]);
    if (someNode(body, (n) => n.kind === "deriv" || n.kind === "tuple")) {
      throw new EntryError("A function's body can't contain unknown derivatives or tuples");
    }
    const resolved = someNode(def.body, (n) => n.kind === "apply" || n.kind === "deriv")
      ? `${def.name}(${def.params.join(", ")}) = ${formatExpr(simplify(body), { display: true })}`
      : null;
    const signature = `${def.name}(${def.params.join(", ")})`;

    // A function of x alone plots itself, the way y = f(x) would.
    if (def.params.length === 1 && def.params[0] === "x") {
      const plot = this.explicit(body, "x", line.color, ast.intervals, track);
      return this.base(line, { kind: "function", description: `function ${signature}`, plots: [plot.plot], fit: plot.fit, resolved });
    }
    this.bindParams(body, def.params, track);
    return this.base(line, { kind: "function", description: `function ${signature}`, resolved });
  }

  private constantEntry(line: DocumentLine, ast: EntryAst, def: ConstantDef, track: Tracker): EntryAnalysis {
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
    const bounds = interval
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

  // Plots

  private plotEntry(line: DocumentLine, ast: EntryAst, track: Tracker): EntryAnalysis {
    const st = ast.statement;
    const original = st.kind === "expr" ? [st.expr] : [st.left, st.right];
    const sides = original.map((s) => this.resolve(s));

    if (sides.some((s) => someNode(s, (n) => n.kind === "tuple"))) {
      return this.tupleEntry(line, ast, sides, track);
    }

    const converted = this.convertSubscripts(sides, ast);
    const partials = collectPartials(converted);
    if (partials.length > 0) {
      const bases = new Set(partials.map((p) => p.base));
      if (bases.size > 1) {
        throw new EntryError(`One unknown function per equation for now; this has ${[...bases].join(" and ")}`);
      }
      const dependent = [...bases][0]!;
      const variables = new Set(partials.flatMap((p) => [...p.orders.keys()]));
      if (variables.has(dependent)) throw new EntryError(`${dependent} can't be differentiated by itself`);
      if (variables.size >= 2) return this.pdeEntry(line, ast, converted, dependent, [...variables], partials, track);
      const independent = variables.size === 1 ? [...variables][0]! : this.defaultIndependent(ast, dependent, converted);
      return this.odeEntry(line, ast, converted, dependent, independent, partials, track);
    }

    if (ast.conditions) throw new EntryError("Conditions only apply to differential equations");
    const result = this.relationEntry(line, ast, sides, track);
    const rewritten = original.some((s) => someNode(s, (n) => n.kind === "apply" || n.kind === "deriv"));
    if (!rewritten) return result;
    const shown = sides.map((s) => formatExpr(simplify(s), { display: true }));
    const text = st.kind === "expr" ? shown[0]! : `${shown[0]} ${st.op} ${shown[1]}`;
    return { ...result, resolved: text };
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
      if (!match || this.constants.has(name)) continue;
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
      if (this.constants.has(base)) continue;
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

  private tupleEntry(line: DocumentLine, ast: EntryAst, sides: readonly Expr[], track: Tracker): EntryAnalysis {
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
    const resolved = null;

    if (params.length === 0) {
      const [x, y, z] = fns.map((f) => (f as (p: typeof P) => number)(P));
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
export function analyzeDocument(lines: readonly DocumentLine[]): DocumentAnalysis {
  return new Analyzer(lines).run();
}
