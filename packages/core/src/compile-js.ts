import type { Expr } from "./ast.js";
import { FUNCTIONS } from "./builtins.js";
import { type QuadratureOptions, quadrature, quadratureWhere } from "./integrate.js";
import { type Optimum, optimize } from "./optimize.js";
import { formatExpr } from "./symbolic.js";

/** Values for named parameters such as slider constants. */
export type ParamValues = Readonly<Record<string, number>>;

/** Evaluates a field at a point. `p` supplies any non-coordinate parameters. */
export type CompiledFn = (x: number, y: number, z: number, p?: Record<string, number>) => number;

/**
 * A compiled expression over named arguments. Call it with one number per
 * argument, in the order they were declared, followed by the parameter values.
 */
export type NumericFunction = (...args: [...number[], ParamValues]) => number;

type Reducer = (...values: (number | ParamValues)[]) => number;
type ReduceNode = Extract<Expr, { kind: "reduce" }>;
type IntegralNode = Extract<Expr, { kind: "integral" }>;
type NumericClosure = (...values: (number | ParamValues)[]) => number;

/**
 * Helpers shared by every compiled function. They are created once per compiled
 * function, outside the function that runs per sample; the first version built
 * them inside it, allocating three closures on every single evaluation.
 */
const PRELUDE = `
const __pow = (a, b) => {
  if (a >= 0 || Number.isInteger(b)) return Math.pow(a, b);
  const inv = 1 / b;
  const r = Math.round(inv);
  // Odd integer roots of negatives are real, e.g. (-8)^(1/3) = -2.
  if (Math.abs(inv - r) < 1e-9 && Math.abs(r % 2) === 1) return -Math.pow(-a, b);
  return NaN;
};
const __mod = (a, b) => a - b * Math.floor(a / b);
const __log = (a, b) => (b === undefined ? Math.log10(a) : Math.log(a) / Math.log(b));
`;

const fill = (template: string, args: string[]): string =>
  template.replace(/\$(\d+)/g, (_, i: string) => args[Number(i)] ?? "undefined");

const coordinateResolver = (name: string): string =>
  name === "x" || name === "y" || name === "z" ? name : `(p[${JSON.stringify(name)}] ?? NaN)`;

const noReductions = (): string => {
  throw new Error("min and max over a range need compileFunction");
};

/**
 * Renders an AST as a JavaScript expression string. `reduce` supplies the
 * call that stands in for a min or max over a range.
 */
export function toJsSource(
  expr: Expr,
  resolve: (name: string) => string = coordinateResolver,
  reduce: (node: ReduceNode | IntegralNode) => string = noReductions,
): string {
  const go = (e: Expr): string => {
    switch (e.kind) {
      case "num":
        if (Number.isNaN(e.value)) return "NaN";
        return Number.isFinite(e.value) ? `(${e.value})` : `(${e.value > 0 ? "Infinity" : "-Infinity"})`;
      case "var":
        return resolve(e.name);
      case "unary":
        return `(-${go(e.arg)})`;
      case "binary": {
        const l = go(e.left);
        const r = go(e.right);
        switch (e.op) {
          case "^":
          case ".^":
            return `__pow(${l}, ${r})`;
          case ".*":
            return `(${l} * ${r})`;
          case "./":
            return `(${l} / ${r})`;
          case "\\":
            return `(${r} / ${l})`;
          default:
            return `(${l} ${e.op} ${r})`;
        }
      }
      case "call":
        return fill(FUNCTIONS[e.name]!.js, e.args.map(go));
      case "reduce":
      case "integral":
        return reduce(e);
      case "apply":
      case "deriv":
      case "tuple":
      case "matrix":
        throw new Error("Resolve functions, derivatives, tuples and matrices before compiling");
    }
  };
  return go(expr);
}

function build<T>(params: string, body: string, reducers: readonly Reducer[] = []): T {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function("R", `${PRELUDE}\nreturn function (${params}) { return (${body}); };`)(reducers) as T;
}

/**
 * Builds a closure over x, y, z for CPU sampling. This is the original
 * single-graph entry point; `compileFunction` handles arbitrary argument names.
 */
export function compileJs(expr: Expr): CompiledFn {
  const fn = build<(x: number, y: number, z: number, p: Record<string, number>) => number>(
    "x, y, z, p",
    toJsSource(expr),
  );
  // Hoisted: a literal here would allocate once per evaluation, and the
  // rasteriser calls this a million times per frame.
  const noParams: Record<string, number> = {};
  return (x, y, z, p) => fn(x, y, z, p ?? noParams);
}

const cache = new Map<string, NumericFunction>();
const CACHE_LIMIT = 4000;

/**
 * Compiles an expression over the named arguments. Any other name is read from
 * the parameter object passed last, so a slider can change without recompiling
 * and V8 keeps the optimised code it has already built.
 *
 * Arguments are renamed to a0, a1... in the generated code, so user variables
 * can be called anything, including `p` or `Math`, without colliding.
 */
export function compileFunction(expr: Expr, args: readonly string[]): NumericFunction {
  // Neither separator can appear in a variable name.
  const key = `${args.join(",")}=>${formatExpr(expr)}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const index = new Map(args.map((name, i) => [name, i] as const));
  const resolve = (name: string): string => {
    const i = index.get(name);
    return i === undefined ? `P[${JSON.stringify(name)}]` : `a${i}`;
  };
  const passAlong = [...args.map((_, i) => `a${i}`), "P"].join(", ");
  const reducers: Reducer[] = [];
  const reduce = (node: ReduceNode | IntegralNode): string => {
    reducers.push(node.kind === "reduce" ? makeReducer(node, args) : makeIntegrator(node, args));
    return `R[${reducers.length - 1}](${passAlong})`;
  };
  const fn = build<NumericFunction>(passAlong, toJsSource(expr, resolve, reduce), reducers);

  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, fn);
  return fn;
}

/**
 * The runtime side of `min(expr, x, lo, hi)`: evaluates the bounds for the
 * current outer values, then optimises the inner expression over the box.
 * The last result is remembered, so the coordinates of an argmin over several
 * variables share one search.
 */
function makeReducer(node: ReduceNode, outer: readonly string[]): Reducer {
  const variables = node.bounds.map((b) => b.variable);
  const inner = compileFunction(node.expr, [...outer, ...variables]) as unknown as (...values: (number | ParamValues)[]) => number;
  const lows = node.bounds.map((b) => compileFunction(b.lo, outer) as unknown as (...values: (number | ParamValues)[]) => number);
  const highs = node.bounds.map((b) => compileFunction(b.hi, outer) as unknown as (...values: (number | ParamValues)[]) => number);
  const n = outer.length;
  const d = variables.length;
  const call: (number | ParamValues)[] = new Array(n + d + 1);
  const maximize = node.op === "max" || node.op === "argmax";

  let lastParams: ParamValues | null = null;
  let lastOuter: number[] = [];
  let last: Optimum | null = null;

  return (...values) => {
    const P = values[n] as ParamValues;
    const outerValues = values.slice(0, n) as number[];
    if (!(last && lastParams === P && outerValues.every((v, i) => v === lastOuter[i]))) {
      const box = node.bounds.map((_, k) => [lows[k]!(...values), highs[k]!(...values)] as const);
      for (let i = 0; i < n; i++) call[i] = outerValues[i]!;
      call[n + d] = P;
      last = optimize(
        (point) => {
          for (let k = 0; k < d; k++) call[n + k] = point[k]!;
          return inner(...call);
        },
        box,
        maximize,
        // Consecutive samples of a plot move a little at a time, so the last optimum is a good start.
        lastParams === P && last ? last.point : null,
      );
      lastParams = P;
      lastOuter = outerValues;
    }
    return node.op === "min" || node.op === "max" ? last.value : (last.point[node.component ?? 0] ?? Number.NaN);
  };
}

/** Tolerance and effort per level of a nested integral, innermost at k = 0. */
function quadratureBudget(depth: number, k: number): QuadratureOptions {
  if (depth === 1) return { tolerance: 1e-10, maxIntervals: 200 };
  if (k === 0) return { tolerance: 1e-9, maxIntervals: depth === 2 ? 60 : 20, fallback: false, regionSamples: depth === 2 ? 32 : 16 };
  return { tolerance: 1e-8, maxIntervals: depth === 2 ? 60 : k === depth - 1 ? 24 : 16, fallback: false };
}

/**
 * The runtime side of `int(expr, x, lo, hi, ...)`: nested one-dimensional
 * integrals, outermost first, where each level's bounds are evaluated with the
 * outer variables already fixed. A region restricts the innermost level.
 */
function makeIntegrator(node: IntegralNode, outer: readonly string[]): Reducer {
  const variables = node.bounds.map((b) => b.variable);
  const n = outer.length;
  const depth = variables.length;
  const all = [...outer, ...variables];
  const integrand = compileFunction(node.expr, all) as unknown as NumericClosure;
  const region = node.region ? (compileFunction(node.region, all) as unknown as NumericClosure) : null;
  // Level k's bounds read the outer arguments and the variables integrated outside it.
  const boundArgs = variables.map((_, k) => [...outer, ...variables.slice(k + 1)]);
  const lows = node.bounds.map((b, k) => compileFunction(b.lo, boundArgs[k]!) as unknown as NumericClosure);
  const highs = node.bounds.map((b, k) => compileFunction(b.hi, boundArgs[k]!) as unknown as NumericClosure);
  const call: (number | ParamValues)[] = new Array(n + depth + 1);

  let lastParams: ParamValues | null = null;
  let lastOuter: number[] = [];
  let lastValue = Number.NaN;

  return (...values) => {
    const P = values[n] as ParamValues;
    const outerValues = values.slice(0, n) as number[];
    if (lastParams === P && outerValues.every((v, i) => v === lastOuter[i])) return lastValue;
    for (let i = 0; i < n; i++) call[i] = outerValues[i]!;
    call[n + depth] = P;

    const bound = (k: number, f: NumericClosure): number => {
      const args: (number | ParamValues)[] = outerValues.slice();
      for (let j = k + 1; j < depth; j++) args.push(call[n + j]!);
      args.push(P);
      return f(...args);
    };
    const level = (k: number): number => {
      const lo = bound(k, lows[k]!);
      const hi = bound(k, highs[k]!);
      const budget = quadratureBudget(depth, k);
      const f = (x: number): number => {
        call[n + k] = x;
        return k === 0 ? integrand(...call) : level(k - 1);
      };
      if (k === 0 && region) {
        const inside = (x: number): number => {
          call[n] = x;
          return region(...call);
        };
        return quadratureWhere(f, inside, lo, hi, budget);
      }
      return quadrature(f, lo, hi, budget).value;
    };

    lastValue = level(depth - 1);
    lastParams = P;
    lastOuter = outerValues;
    return lastValue;
  };
}
