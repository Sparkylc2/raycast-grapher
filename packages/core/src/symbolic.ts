import { type Expr, exprEquals } from "./ast.js";
import { FUNCTIONS, realPow } from "./builtins.js";

/**
 * Exact symbolic manipulation: substitution, simplification and
 * differentiation.
 *
 * Derivatives are computed on the tree rather than estimated numerically, so
 * `f'(x)` is exact at any zoom, and the differential-equation solver can ask
 * whether an equation is linear in its highest derivative by checking whether
 * the second derivative with respect to it simplifies to zero.
 */

export class SymbolicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SymbolicError";
  }
}

const N = (value: number): Expr => ({ kind: "num", value });
const isNum = (e: Expr): e is { kind: "num"; value: number } => e.kind === "num";
// Deliberately not a type guard: a false result must not rule out every number.
const isValue = (e: Expr, value: number): boolean => e.kind === "num" && e.value === value;

// Smart constructors simplify as they build, so derivative trees stay small.

export function neg(a: Expr): Expr {
  if (isNum(a)) return N(-a.value);
  if (a.kind === "unary" && a.op === "-") return a.arg;
  if (a.kind === "binary" && a.op === "-") return sub(a.right, a.left);
  return { kind: "unary", op: "-", arg: a };
}

export function add(a: Expr, b: Expr): Expr {
  if (isNum(a) && isNum(b)) return N(a.value + b.value);
  if (isValue(a, 0)) return b;
  if (isValue(b, 0)) return a;
  if (b.kind === "unary" && b.op === "-") return sub(a, b.arg);
  if (isNum(b) && b.value < 0) return sub(a, N(-b.value));
  if (exprEquals(a, b)) return mul(N(2), a);
  return { kind: "binary", op: "+", left: a, right: b };
}

export function sub(a: Expr, b: Expr): Expr {
  if (isNum(a) && isNum(b)) return N(a.value - b.value);
  if (isValue(b, 0)) return a;
  if (isValue(a, 0)) return neg(b);
  if (exprEquals(a, b)) return N(0);
  if (b.kind === "unary" && b.op === "-") return add(a, b.arg);
  if (isNum(b) && b.value < 0) return add(a, N(-b.value));
  return { kind: "binary", op: "-", left: a, right: b };
}

export function mul(a: Expr, b: Expr): Expr {
  if (isNum(a) && isNum(b)) return N(a.value * b.value);
  if (isValue(a, 0) || isValue(b, 0)) return N(0);
  if (isValue(a, 1)) return b;
  if (isValue(b, 1)) return a;
  if (isValue(a, -1)) return neg(b);
  if (isValue(b, -1)) return neg(a);
  if (a.kind === "unary" && a.op === "-") return neg(mul(a.arg, b));
  if (b.kind === "unary" && b.op === "-") return neg(mul(a, b.arg));
  // Numbers lead, and adjacent numbers merge: 2(3x) becomes 6x.
  if (isNum(b)) return mul(b, a);
  if (isNum(a) && b.kind === "binary" && b.op === "*" && isNum(b.left)) {
    return mul(N(a.value * b.left.value), b.right);
  }
  if (isNum(a) && b.kind === "binary" && b.op === "/" && isNum(b.left)) {
    return div(N(a.value * b.left.value), b.right);
  }
  if (exprEquals(a, b)) return pow(a, N(2));
  return { kind: "binary", op: "*", left: a, right: b };
}

export function div(a: Expr, b: Expr): Expr {
  if (isNum(a) && isNum(b) && b.value !== 0) return N(a.value / b.value);
  if (isValue(a, 0)) return N(0);
  if (isValue(b, 1)) return a;
  if (isValue(b, -1)) return neg(a);
  if (exprEquals(a, b)) return N(1);
  if (a.kind === "unary" && a.op === "-") return neg(div(a.arg, b));
  return { kind: "binary", op: "/", left: a, right: b };
}

export function pow(a: Expr, b: Expr): Expr {
  if (isNum(a) && isNum(b)) return N(realPow(a.value, b.value));
  if (isValue(b, 0)) return N(1);
  if (isValue(b, 1)) return a;
  if (isValue(a, 1)) return N(1);
  return { kind: "binary", op: "^", left: a, right: b };
}

export function callOf(name: string, args: Expr[]): Expr {
  const fn = FUNCTIONS[name];
  if (fn && args.every((a) => isNum(a))) {
    const value = fn.fn(...args.map((a) => (a as { value: number }).value));
    if (Number.isFinite(value)) return N(value);
  }
  return { kind: "call", name, args };
}

/** Rebuilds a tree through the smart constructors, folding what it can. */
export function simplify(e: Expr): Expr {
  switch (e.kind) {
    case "num":
    case "var":
      return e;
    case "unary":
      return e.op === "-" ? neg(simplify(e.arg)) : simplify(e.arg);
    case "binary": {
      const l = simplify(e.left);
      const r = simplify(e.right);
      switch (e.op) {
        case "+":
          return add(l, r);
        case "-":
          return sub(l, r);
        case "*":
          return mul(l, r);
        case "/":
          return div(l, r);
        case "^":
          return pow(l, r);
      }
      return e;
    }
    case "call":
      return callOf(e.name, e.args.map(simplify));
    case "apply":
      return { ...e, args: e.args.map(simplify) };
    case "deriv":
      return { ...e, expr: simplify(e.expr) };
    case "tuple":
      return { kind: "tuple", items: e.items.map(simplify) };
  }
}

/** Applies `f` to every direct child. */
export function mapChildren(e: Expr, f: (child: Expr) => Expr): Expr {
  switch (e.kind) {
    case "num":
    case "var":
      return e;
    case "unary":
      return { ...e, arg: f(e.arg) };
    case "binary":
      return { ...e, left: f(e.left), right: f(e.right) };
    case "call":
    case "apply":
      return { ...e, args: e.args.map(f) };
    case "deriv":
      return { ...e, expr: f(e.expr) };
    case "tuple":
      return { kind: "tuple", items: e.items.map(f) };
  }
}

/**
 * Replaces variables simultaneously. Substituted expressions are not scanned
 * again, so `f(x) = x + a` applied to `a` cannot capture its own argument.
 */
export function substitute(e: Expr, bindings: ReadonlyMap<string, Expr>): Expr {
  if (e.kind === "var") return bindings.get(e.name) ?? e;
  return mapChildren(e, (child) => substitute(child, bindings));
}

/** d/dv of an expression made only of numbers, variables, operators and built-in calls. */
export function differentiate(e: Expr, v: string): Expr {
  switch (e.kind) {
    case "num":
      return N(0);
    case "var":
      return N(e.name === v ? 1 : 0);
    case "unary":
      return e.op === "-" ? neg(differentiate(e.arg, v)) : differentiate(e.arg, v);
    case "binary": {
      const u = e.left;
      const w = e.right;
      const du = differentiate(u, v);
      const dw = differentiate(w, v);
      switch (e.op) {
        case "+":
          return add(du, dw);
        case "-":
          return sub(du, dw);
        case "*":
          return add(mul(du, w), mul(u, dw));
        case "/":
          return div(sub(mul(du, w), mul(u, dw)), pow(w, N(2)));
        case "^":
          return differentiatePower(u, w, du, dw);
      }
      return N(0);
    }
    case "call":
      return differentiateCall(e.name, e.args, v);
    case "apply":
    case "deriv":
    case "tuple":
      throw new SymbolicError("Resolve functions and derivatives before differentiating");
  }
}

function differentiatePower(u: Expr, w: Expr, du: Expr, dw: Expr): Expr {
  if (isValue(du, 0) && isValue(dw, 0)) return N(0);
  // Constant exponent: the power rule.
  if (isValue(dw, 0)) return mul(mul(w, pow(u, sub(w, N(1)))), du);
  // Constant base: a^w ln a.
  if (isValue(du, 0)) return mul(mul(pow(u, w), callOf("ln", [u])), dw);
  return mul(pow(u, w), add(mul(dw, callOf("ln", [u])), div(mul(w, du), u)));
}

function differentiateCall(name: string, args: Expr[], v: string): Expr {
  const a = args[0]!;
  const b = args[1];
  const da = differentiate(a, v);
  const db = b ? differentiate(b, v) : N(0);
  if (isValue(da, 0) && isValue(db, 0)) return N(0);

  const c = (fn: string, ...xs: Expr[]): Expr => callOf(fn, xs);
  switch (name) {
    case "sin":
      return mul(c("cos", a), da);
    case "cos":
      return neg(mul(c("sin", a), da));
    case "tan":
      return div(da, pow(c("cos", a), N(2)));
    case "asin":
      return div(da, c("sqrt", sub(N(1), pow(a, N(2)))));
    case "acos":
      return neg(div(da, c("sqrt", sub(N(1), pow(a, N(2))))));
    case "atan":
      return div(da, add(N(1), pow(a, N(2))));
    case "atan2":
      // atan2(y, x): (x y' - y x') / (x^2 + y^2)
      return div(sub(mul(b!, da), mul(a, db)), add(pow(a, N(2)), pow(b!, N(2))));
    case "sinh":
      return mul(c("cosh", a), da);
    case "cosh":
      return mul(c("sinh", a), da);
    case "tanh":
      return div(da, pow(c("cosh", a), N(2)));
    case "exp":
      return mul(c("exp", a), da);
    case "ln":
      return div(da, a);
    case "log":
      return b ? differentiate(div(c("ln", a), c("ln", b)), v) : div(da, mul(a, N(Math.LN10)));
    case "sqrt":
      return div(da, mul(N(2), c("sqrt", a)));
    case "cbrt":
      return div(da, mul(N(3), pow(c("cbrt", a), N(2))));
    case "abs":
      return mul(c("sign", a), da);
    case "sign":
    case "floor":
    case "ceil":
    case "round":
      return N(0);
    case "min":
    case "max": {
      // Picks the derivative of whichever argument is currently selected.
      const s = c("sign", sub(b!, a));
      const takeA = div(name === "min" ? add(N(1), s) : sub(N(1), s), N(2));
      const takeB = div(name === "min" ? sub(N(1), s) : add(N(1), s), N(2));
      return add(mul(takeA, da), mul(takeB, db));
    }
    case "mod":
      return sub(da, mul(c("floor", div(a, b!)), db));
    case "hypot":
      return div(add(mul(a, da), mul(b!, db)), c("hypot", a, b!));
    case "pow":
      return differentiatePower(a, b!, da, db);
  }
  throw new SymbolicError(`Can't differentiate ${name}`);
}

const PRECEDENCE = { add: 1, mul: 2, unary: 3, pow: 4, atom: 5 } as const;

function precedenceOf(e: Expr): number {
  switch (e.kind) {
    case "num":
      return e.value < 0 ? PRECEDENCE.unary : PRECEDENCE.atom;
    case "unary":
      return PRECEDENCE.unary;
    case "binary":
      if (e.op === "+" || e.op === "-") return PRECEDENCE.add;
      return e.op === "^" ? PRECEDENCE.pow : PRECEDENCE.mul;
    default:
      return PRECEDENCE.atom;
  }
}

export interface FormatOptions {
  /** Round numbers for reading; the default keeps full precision, for cache keys. */
  readonly display?: boolean;
}

/** Prints an expression in syntax the parser reads back. */
export function formatExpr(e: Expr, options: FormatOptions = {}): string {
  const number = (value: number): string => {
    if (!options.display || Number.isInteger(value)) return String(value);
    return String(Number(value.toPrecision(6)));
  };
  const wrap = (child: Expr, min: number): string => {
    const text = go(child);
    return precedenceOf(child) < min ? `(${text})` : text;
  };
  const go = (n: Expr): string => {
    switch (n.kind) {
      case "num":
        return number(n.value);
      case "var":
        return n.name;
      case "unary":
        return `-${wrap(n.arg, PRECEDENCE.unary)}`;
      case "binary":
        switch (n.op) {
          case "+":
            return `${wrap(n.left, PRECEDENCE.add)} + ${wrap(n.right, PRECEDENCE.add)}`;
          case "-":
            return `${wrap(n.left, PRECEDENCE.add)} - ${wrap(n.right, PRECEDENCE.add + 1)}`;
          case "*": {
            const left = wrap(n.left, PRECEDENCE.mul);
            const right = wrap(n.right, PRECEDENCE.mul + 1);
            // 2x and 3sin(x) read naturally and parse back the same way.
            const r = n.right;
            const juxtapose =
              n.left.kind === "num" &&
              n.left.value >= 0 &&
              (r.kind === "var" || r.kind === "call" || (r.kind === "binary" && r.op === "^" && r.left.kind === "var"));
            return juxtapose ? `${left}${right}` : `${left} * ${right}`;
          }
          case "/":
            return `${wrap(n.left, PRECEDENCE.mul)} / ${wrap(n.right, PRECEDENCE.mul + 1)}`;
          case "^":
            return `${wrap(n.left, PRECEDENCE.atom)}^${wrap(n.right, PRECEDENCE.pow)}`;
        }
        return "?";
      case "call":
        return `${n.name}(${n.args.map(go).join(", ")})`;
      case "apply":
        return `${n.name}${"'".repeat(n.primes)}(${n.args.map(go).join(", ")})`;
      case "deriv": {
        if (n.variable === null && n.expr.kind === "var") return `${n.expr.name}${"'".repeat(n.order)}`;
        const power = n.order > 1 ? `^${n.order}` : "";
        if (n.expr.kind === "var") return `d${power}${n.expr.name}/d${n.variable}${power}`;
        return `d${power}/d${n.variable}${power}(${go(n.expr)})`;
      }
      case "tuple":
        return `(${n.items.map(go).join(", ")})`;
    }
  };
  return go(e);
}
