import type { Expr } from "./ast.js";
import { FUNCTIONS } from "./builtins.js";

/** Evaluates a field at a point. `p` supplies any non-coordinate parameters. */
export type CompiledFn = (x: number, y: number, z: number, p?: Record<string, number>) => number;

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

/** Renders an AST as a JavaScript expression string. */
export function toJsSource(expr: Expr): string {
  switch (expr.kind) {
    case "num":
      return Number.isFinite(expr.value) ? `(${expr.value})` : `(${expr.value > 0 ? "Infinity" : "-Infinity"})`;
    case "var":
      return expr.name === "x" || expr.name === "y" || expr.name === "z"
        ? expr.name
        : `(p.${expr.name} ?? NaN)`;
    case "unary":
      return `(-${toJsSource(expr.arg)})`;
    case "binary": {
      const l = toJsSource(expr.left);
      const r = toJsSource(expr.right);
      return expr.op === "^" ? `__pow(${l}, ${r})` : `(${l} ${expr.op} ${r})`;
    }
    case "call": {
      const fn = FUNCTIONS[expr.name]!;
      return fill(fn.js, expr.args.map(toJsSource));
    }
  }
}

/**
 * Builds a closure for CPU sampling.
 *
 * This is the path used for polyline sampling, root finding and the still
 * images Raycast shows inline; the GPU never runs it.
 */
export function compileJs(expr: Expr): CompiledFn {
  const body = `${PRELUDE}\nreturn (${toJsSource(expr)});`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function("x", "y", "z", "p", body) as CompiledFn;
  // Hoisted: a literal here would allocate once per evaluation, and the
  // rasteriser calls this a million times per frame.
  const noParams: Record<string, number> = {};
  return (x, y, z, p) => fn(x, y, z, p ?? noParams);
}
