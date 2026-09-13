/**
 * Single source of truth for every name the language knows.
 *
 * Each entry carries its JS and GLSL spellings side by side so the two
 * compilers can never drift apart: adding a function here makes it available
 * to the CPU sampler and the GPU shader at the same time.
 */

export interface BuiltinFn {
  readonly arity: number | readonly [min: number, max: number];
  /** JS expression template; `$0`, `$1` are the compiled arguments. */
  readonly js: string;
  /** GLSL expression template, or null when the GPU cannot express it. */
  readonly glsl: string | null;
}

export const CONSTANTS: Readonly<Record<string, number>> = {
  pi: Math.PI,
  tau: Math.PI * 2,
  e: Math.E,
  phi: (1 + Math.sqrt(5)) / 2,
  inf: Infinity,
};

export const CONSTANT_NAMES: ReadonlySet<string> = new Set(
  Object.keys(CONSTANTS),
);

export const FUNCTIONS: Readonly<Record<string, BuiltinFn>> = {
  sin: { arity: 1, js: "Math.sin($0)", glsl: "sin($0)" },
  cos: { arity: 1, js: "Math.cos($0)", glsl: "cos($0)" },
  tan: { arity: 1, js: "Math.tan($0)", glsl: "tan($0)" },
  asin: { arity: 1, js: "Math.asin($0)", glsl: "asin($0)" },
  acos: { arity: 1, js: "Math.acos($0)", glsl: "acos($0)" },
  atan: { arity: 1, js: "Math.atan($0)", glsl: "atan($0)" },
  atan2: { arity: 2, js: "Math.atan2($0, $1)", glsl: "atan($0, $1)" },
  sinh: { arity: 1, js: "Math.sinh($0)", glsl: "sinh($0)" },
  cosh: { arity: 1, js: "Math.cosh($0)", glsl: "cosh($0)" },
  tanh: { arity: 1, js: "Math.tanh($0)", glsl: "tanh($0)" },
  exp: { arity: 1, js: "Math.exp($0)", glsl: "exp($0)" },
  ln: { arity: 1, js: "Math.log($0)", glsl: "log($0)" },
  log: { arity: [1, 2], js: "__log($0, $1)", glsl: "gr_log($0, $1)" },
  sqrt: { arity: 1, js: "Math.sqrt($0)", glsl: "sqrt($0)" },
  cbrt: { arity: 1, js: "Math.cbrt($0)", glsl: "gr_cbrt($0)" },
  abs: { arity: 1, js: "Math.abs($0)", glsl: "abs($0)" },
  sign: { arity: 1, js: "Math.sign($0)", glsl: "sign($0)" },
  floor: { arity: 1, js: "Math.floor($0)", glsl: "floor($0)" },
  ceil: { arity: 1, js: "Math.ceil($0)", glsl: "ceil($0)" },
  round: { arity: 1, js: "Math.round($0)", glsl: "floor($0 + 0.5)" },
  min: { arity: 2, js: "Math.min($0, $1)", glsl: "min($0, $1)" },
  max: { arity: 2, js: "Math.max($0, $1)", glsl: "max($0, $1)" },
  mod: { arity: 2, js: "__mod($0, $1)", glsl: "mod($0, $1)" },
  hypot: { arity: 2, js: "Math.hypot($0, $1)", glsl: "length(vec2($0, $1))" },
  pow: { arity: 2, js: "__pow($0, $1)", glsl: "gr_pow($0, $1)" },
};

export const FUNCTION_NAMES: ReadonlySet<string> = new Set(
  Object.keys(FUNCTIONS),
);

export function arityRange(fn: BuiltinFn): [number, number] {
  return typeof fn.arity === "number"
    ? [fn.arity, fn.arity]
    : [fn.arity[0], fn.arity[1]];
}
