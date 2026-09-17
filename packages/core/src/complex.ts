import type { Expr } from "./ast.js";
import { add, div, mul, neg, pow, simplify, sub } from "./symbolic.js";

/**
 * Complex numbers as pairs of real expressions.
 *
 * Like matrices, complex values exist only while a line is resolved: (x + i y)^2
 * becomes x^2 - y^2 and 2xy before anything is compiled, so the compilers,
 * derivatives and renderers stay real, and an expression that ends up real
 * plots as usual.
 */

export interface ComplexValue {
  readonly kind: "complexValue";
  readonly re: Expr;
  readonly im: Expr;
}

const N = (value: number): Expr => ({ kind: "num", value });
const call = (name: string, ...args: Expr[]): Expr => ({ kind: "call", name, args });

export const complex = (re: Expr, im: Expr): ComplexValue => ({ kind: "complexValue", re, im });
export const isComplex = (v: { readonly kind: string }): v is ComplexValue => v.kind === "complexValue";
export const IMAGINARY_UNIT: ComplexValue = complex(N(0), N(1));
export const toComplex = (v: Expr | ComplexValue): ComplexValue => (isComplex(v) ? v : complex(v, N(0)));

/** A real expression again when the imaginary part is exactly zero. */
export function settle(z: ComplexValue): Expr | ComplexValue {
  const im = simplify(z.im);
  return im.kind === "num" && im.value === 0 ? simplify(z.re) : complex(simplify(z.re), im);
}

export const cadd = (a: ComplexValue, b: ComplexValue): ComplexValue => complex(add(a.re, b.re), add(a.im, b.im));
export const csub = (a: ComplexValue, b: ComplexValue): ComplexValue => complex(sub(a.re, b.re), sub(a.im, b.im));
export const cneg = (a: ComplexValue): ComplexValue => complex(neg(a.re), neg(a.im));
export const cmul = (a: ComplexValue, b: ComplexValue): ComplexValue =>
  complex(sub(mul(a.re, b.re), mul(a.im, b.im)), add(mul(a.re, b.im), mul(a.im, b.re)));

export function cdiv(a: ComplexValue, b: ComplexValue): ComplexValue {
  const size = add(pow(b.re, N(2)), pow(b.im, N(2)));
  return complex(div(add(mul(a.re, b.re), mul(a.im, b.im)), size), div(sub(mul(a.im, b.re), mul(a.re, b.im)), size));
}

export const modulus = (z: ComplexValue): Expr => call("hypot", z.re, z.im);
export const argument = (z: ComplexValue): Expr => call("atan2", z.im, z.re);
export const conjugate = (z: ComplexValue): ComplexValue => complex(z.re, neg(z.im));

export function cexp(z: ComplexValue): ComplexValue {
  const scale = call("exp", z.re);
  return complex(mul(scale, call("cos", z.im)), mul(scale, call("sin", z.im)));
}

export const clog = (z: ComplexValue): ComplexValue => complex(call("ln", modulus(z)), argument(z));

/** z^n for a whole n, by repeated squaring, which keeps polynomials exact. */
export function cpowInteger(z: ComplexValue, n: number): ComplexValue {
  let base = z;
  let exponent = Math.abs(n);
  let result: ComplexValue = complex(N(1), N(0));
  while (exponent > 0) {
    if (exponent & 1) result = cmul(result, base);
    exponent >>= 1;
    if (exponent > 0) base = cmul(base, base);
  }
  return n < 0 ? cdiv(complex(N(1), N(0)), result) : result;
}

/** The principal value of z^w, as exp(w log z). */
export const cpow = (z: ComplexValue, w: ComplexValue): ComplexValue => cexp(cmul(w, clog(z)));

export function csqrt(z: ComplexValue): ComplexValue {
  const root = call("sqrt", modulus(z));
  const half = div(argument(z), N(2));
  return complex(mul(root, call("cos", half)), mul(root, call("sin", half)));
}

const csin = (z: ComplexValue): ComplexValue =>
  complex(mul(call("sin", z.re), call("cosh", z.im)), mul(call("cos", z.re), call("sinh", z.im)));
const ccos = (z: ComplexValue): ComplexValue =>
  complex(mul(call("cos", z.re), call("cosh", z.im)), neg(mul(call("sin", z.re), call("sinh", z.im))));
const csinh = (z: ComplexValue): ComplexValue =>
  complex(mul(call("sinh", z.re), call("cos", z.im)), mul(call("cosh", z.re), call("sin", z.im)));
const ccosh = (z: ComplexValue): ComplexValue =>
  complex(mul(call("cosh", z.re), call("cos", z.im)), mul(call("sinh", z.re), call("sin", z.im)));

/** A built-in applied to a complex argument, or null when it has no complex meaning here. */
export function applyComplex(name: string, z: ComplexValue): Expr | ComplexValue | null {
  switch (name) {
    case "exp":
      return cexp(z);
    case "ln":
      return clog(z);
    case "log": {
      const natural = clog(z);
      return complex(div(natural.re, N(Math.LN10)), div(natural.im, N(Math.LN10)));
    }
    case "sqrt":
      return csqrt(z);
    case "sin":
      return csin(z);
    case "cos":
      return ccos(z);
    case "tan":
      return cdiv(csin(z), ccos(z));
    case "sinh":
      return csinh(z);
    case "cosh":
      return ccosh(z);
    case "tanh":
      return cdiv(csinh(z), ccosh(z));
    case "abs":
      return modulus(z);
    default:
      return null;
  }
}
