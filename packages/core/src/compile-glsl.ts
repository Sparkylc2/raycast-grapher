import type { Expr } from "./ast.js";
import { FUNCTIONS } from "./builtins.js";

/**
 * Helper functions every generated shader links against. Kept in one string so
 * the viewer can paste it verbatim above whatever field function it builds.
 */
export const GLSL_PRELUDE = `
float gr_nan() { return uintBitsToFloat(0x7fc00000u); }

float gr_cbrt(float x) { return sign(x) * pow(abs(x), 1.0 / 3.0); }

// pow() is undefined for negative bases, but graphs need x^3 and x^(1/3) to
// behave, so integer powers and odd integer roots are handled explicitly.
float gr_pow(float a, float b) {
  if (a >= 0.0) return pow(a, b);
  float n = floor(b + 0.5);
  if (abs(b - n) < 1e-6) {
    float m = pow(-a, b);
    return mod(abs(n), 2.0) < 0.5 ? m : -m;
  }
  float inv = 1.0 / b;
  float k = floor(inv + 0.5);
  if (abs(inv - k) < 1e-6 && mod(abs(k), 2.0) > 0.5) return -pow(-a, b);
  return gr_nan();
}
`;

/** GLSL has no implicit int-to-float promotion, so every literal needs a point. */
export function glslFloat(value: number): string {
  if (Number.isNaN(value)) return "gr_nan()";
  if (!Number.isFinite(value)) return value > 0 ? "3.402823e+38" : "-3.402823e+38";
  if (Number.isInteger(value) && Math.abs(value) < 1e7) return `${value}.0`;
  const text = String(value);
  return /[.e]/.test(text) ? text : `${text}.0`;
}

const fill = (template: string, args: string[]): string =>
  template.replace(/\$(\d+)/g, (_, i: string) => args[Number(i)] ?? "0.0");

export interface GlslOptions {
  /** Names bound as uniforms rather than coordinates, e.g. slider parameters. */
  readonly uniformPrefix?: string;
}

/**
 * Renders an AST as a GLSL ES 3.00 expression.
 *
 * Coordinates `x`, `y`, `z` are emitted bare, so the caller decides whether
 * they are function arguments or varyings. Anything else becomes a uniform.
 */
export function toGlslSource(expr: Expr, options: GlslOptions = {}): string {
  const prefix = options.uniformPrefix ?? "u_";

  const go = (n: Expr): string => {
    switch (n.kind) {
      case "num":
        return glslFloat(n.value);
      case "var":
        return n.name === "x" || n.name === "y" || n.name === "z" ? n.name : `${prefix}${n.name}`;
      case "unary":
        return `(-${go(n.arg)})`;
      case "binary": {
        const l = go(n.left);
        const r = go(n.right);
        return n.op === "^" ? `gr_pow(${l}, ${r})` : `(${l} ${n.op} ${r})`;
      }
      case "call": {
        const args = n.args.map(go);
        // log is the one builtin whose meaning changes with arity, so it cannot
        // ride the shared template.
        if (n.name === "log") {
          return args.length === 1
            ? `(log(${args[0]}) / 2.302585092994046)`
            : `(log(${args[0]}) / log(${args[1]}))`;
        }
        const fn = FUNCTIONS[n.name]!;
        if (fn.glsl === null) {
          throw new Error(`${n.name} cannot be evaluated on the GPU`);
        }
        return fill(fn.glsl, args);
      }
    }
  };

  return go(expr);
}

/** Wraps an expression as a callable GLSL function, prelude included. */
export function toGlslFunction(
  expr: Expr,
  name: string,
  params: readonly string[],
  options: GlslOptions = {},
): string {
  const signature = params.map((p) => `float ${p}`).join(", ");
  return `float ${name}(${signature}) {\n  return ${toGlslSource(expr, options)};\n}`;
}
