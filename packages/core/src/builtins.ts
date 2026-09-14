/**
 * Single source of truth for every name the language knows.
 *
 * Each entry carries its JS and GLSL spellings and a numeric implementation
 * side by side, so the compilers, the constant folder and the GPU shader can
 * never drift apart: adding a function here makes it available everywhere.
 */

export interface BuiltinFn {
  readonly arity: number | readonly [min: number, max: number];
  /** JS expression template; `$0`, `$1` are the compiled arguments. */
  readonly js: string;
  /** GLSL expression template, or null when the GPU cannot express it. */
  readonly glsl: string | null;
  /** Direct numeric implementation, used for constant folding and slider bounds. */
  readonly fn: (...args: number[]) => number;
}

export const CONSTANTS: Readonly<Record<string, number>> = {
  pi: Math.PI,
  "π": Math.PI,
  tau: Math.PI * 2,
  "τ": Math.PI * 2,
  e: Math.E,
  phi: (1 + Math.sqrt(5)) / 2,
  inf: Infinity,
};

export const CONSTANT_NAMES: ReadonlySet<string> = new Set(
  Object.keys(CONSTANTS),
);

/** Real power that keeps odd roots of negative numbers, e.g. (-8)^(1/3) = -2. */
export function realPow(a: number, b: number): number {
  if (a >= 0 || Number.isInteger(b)) return Math.pow(a, b);
  const inv = 1 / b;
  const r = Math.round(inv);
  if (Math.abs(inv - r) < 1e-9 && Math.abs(r % 2) === 1) return -Math.pow(-a, b);
  return NaN;
}

const floorMod = (a: number, b: number): number => a - b * Math.floor(a / b);

export const FUNCTIONS: Readonly<Record<string, BuiltinFn>> = {
  sin: { arity: 1, js: "Math.sin($0)", glsl: "sin($0)", fn: Math.sin },
  cos: { arity: 1, js: "Math.cos($0)", glsl: "cos($0)", fn: Math.cos },
  tan: { arity: 1, js: "Math.tan($0)", glsl: "tan($0)", fn: Math.tan },
  asin: { arity: 1, js: "Math.asin($0)", glsl: "asin($0)", fn: Math.asin },
  acos: { arity: 1, js: "Math.acos($0)", glsl: "acos($0)", fn: Math.acos },
  atan: { arity: 1, js: "Math.atan($0)", glsl: "atan($0)", fn: Math.atan },
  atan2: { arity: 2, js: "Math.atan2($0, $1)", glsl: "atan($0, $1)", fn: Math.atan2 },
  sinh: { arity: 1, js: "Math.sinh($0)", glsl: "sinh($0)", fn: Math.sinh },
  cosh: { arity: 1, js: "Math.cosh($0)", glsl: "cosh($0)", fn: Math.cosh },
  tanh: { arity: 1, js: "Math.tanh($0)", glsl: "tanh($0)", fn: Math.tanh },
  exp: { arity: 1, js: "Math.exp($0)", glsl: "exp($0)", fn: Math.exp },
  ln: { arity: 1, js: "Math.log($0)", glsl: "log($0)", fn: Math.log },
  log: {
    arity: [1, 2],
    js: "__log($0, $1)",
    glsl: "gr_log($0, $1)",
    fn: (a, b) => (b === undefined ? Math.log10(a) : Math.log(a) / Math.log(b)),
  },
  sqrt: { arity: 1, js: "Math.sqrt($0)", glsl: "sqrt($0)", fn: Math.sqrt },
  cbrt: { arity: 1, js: "Math.cbrt($0)", glsl: "gr_cbrt($0)", fn: Math.cbrt },
  abs: { arity: 1, js: "Math.abs($0)", glsl: "abs($0)", fn: Math.abs },
  sign: { arity: 1, js: "Math.sign($0)", glsl: "sign($0)", fn: Math.sign },
  floor: { arity: 1, js: "Math.floor($0)", glsl: "floor($0)", fn: Math.floor },
  ceil: { arity: 1, js: "Math.ceil($0)", glsl: "ceil($0)", fn: Math.ceil },
  round: { arity: 1, js: "Math.round($0)", glsl: "floor($0 + 0.5)", fn: Math.round },
  min: { arity: 2, js: "Math.min($0, $1)", glsl: "min($0, $1)", fn: Math.min },
  max: { arity: 2, js: "Math.max($0, $1)", glsl: "max($0, $1)", fn: Math.max },
  mod: { arity: 2, js: "__mod($0, $1)", glsl: "mod($0, $1)", fn: floorMod },
  hypot: { arity: 2, js: "Math.hypot($0, $1)", glsl: "length(vec2($0, $1))", fn: Math.hypot },
  pow: { arity: 2, js: "__pow($0, $1)", glsl: "gr_pow($0, $1)", fn: realPow },
};

export const FUNCTION_NAMES: ReadonlySet<string> = new Set(
  Object.keys(FUNCTIONS),
);

export function arityRange(fn: BuiltinFn): [number, number] {
  return typeof fn.arity === "number"
    ? [fn.arity, fn.arity]
    : [fn.arity[0], fn.arity[1]];
}
