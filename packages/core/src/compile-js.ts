import type { Expr } from "./ast.js";
import { FUNCTIONS } from "./builtins.js";
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

/** Renders an AST as a JavaScript expression string. */
export function toJsSource(
  expr: Expr,
  resolve: (name: string) => string = coordinateResolver,
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
        return e.op === "^" ? `__pow(${l}, ${r})` : `(${l} ${e.op} ${r})`;
      }
      case "call":
        return fill(FUNCTIONS[e.name]!.js, e.args.map(go));
      case "apply":
      case "deriv":
      case "tuple":
        throw new Error("Resolve functions, derivatives and tuples before compiling");
    }
  };
  return go(expr);
}

function build<T>(params: string, body: string): T {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${PRELUDE}\nreturn function (${params}) { return (${body}); };`)() as T;
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
  const params = [...args.map((_, i) => `a${i}`), "P"].join(", ");
  const fn = build<NumericFunction>(params, toJsSource(expr, resolve));

  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, fn);
  return fn;
}
