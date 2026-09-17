/**
 * Expression AST. Deliberately tiny and backend-agnostic: every renderer
 * (JS closure, GLSL source, future WASM) consumes this same tree, so a graph
 * is parsed exactly once no matter how many surfaces draw it.
 *
 * The parser only records what was written. Whether `f(x)` is a call or a
 * product, or whether `dp/dq` is an unknown in a differential equation, depends
 * on the other lines in the document, so `document.ts` decides that later.
 */

export type BinaryOp = "+" | "-" | "*" | "/" | "^" | ".*" | "./" | ".^" | "\\";
export type RelationOp = "=" | "<" | ">" | "<=" | ">=";
export type ReduceOp = "min" | "max" | "argmin" | "argmax";

export interface ReduceBound {
  readonly variable: string;
  readonly lo: Expr;
  readonly hi: Expr;
}

export type Expr =
  | { kind: "num"; value: number }
  | { kind: "var"; name: string }
  | { kind: "unary"; op: "-" | "+"; arg: Expr }
  | { kind: "binary"; op: BinaryOp; left: Expr; right: Expr }
  /** A built-in function call, arity already checked. */
  | { kind: "call"; name: string; args: Expr[] }
  /**
   * `name(args)` where `name` is not built in, optionally with primes as in
   * `f'(x)`. A user function call, a matrix index, or juxtaposed multiplication.
   */
  | { kind: "apply"; name: string; args: Expr[]; primes: number }
  /**
   * A derivative. `variable` is null for prime notation, as in `p''` or `A'`,
   * where the variable is the equation's independent one, or for a matrix, a
   * transpose.
   */
  | { kind: "deriv"; expr: Expr; variable: string | null; order: number }
  /** `(a, b)` or `(a, b, c)`: a point or a parametric curve or surface. */
  | { kind: "tuple"; items: Expr[] }
  /** `[a, b; c, d]`: rows of entries, where an entry may itself be a matrix. */
  | { kind: "matrix"; rows: Expr[][] }
  /**
   * `min(f(x), x, -2, 2)`: the extreme of `expr` as the bound variables range
   * over a box. `component` picks one coordinate of an argmin over several
   * variables; null means the value itself, or the only coordinate.
   */
  | { kind: "reduce"; op: ReduceOp; expr: Expr; bounds: ReduceBound[]; component: number | null }
  /**
   * `int(expr, x, lo, hi)`: a definite integral. Bounds are listed innermost
   * first, and each may use the variables integrated outside it. `region`,
   * when given, is F with the region where F <= 0, as in
   * `int(1, x^2 + y^2 < 1, x, -1, 1, y, -1, 1)`.
   */
  | { kind: "integral"; expr: Expr; bounds: ReduceBound[]; region: Expr | null };

/** A full statement is either a bare expression or a relation between two. */
export type Statement =
  | { kind: "expr"; expr: Expr }
  | { kind: "relation"; op: RelationOp; left: Expr; right: Expr };

export interface IntervalAst {
  readonly lo: Expr;
  readonly hi: Expr;
  readonly step: Expr | null;
}

export interface ConditionAst {
  readonly left: Expr;
  readonly right: Expr;
}

/**
 * One line of input: a statement plus the optional groups that may follow it,
 * `[lo, hi; lo, hi]` ranges, `[p(0) = 5]` conditions and `{q, p}` axes.
 */
export interface EntryAst {
  readonly statement: Statement;
  readonly intervals: readonly IntervalAst[] | null;
  readonly conditions: readonly ConditionAst[] | null;
  readonly axes: readonly string[] | null;
}

export const num = (value: number): Expr => ({ kind: "num", value });
export const variable = (name: string): Expr => ({ kind: "var", name });
export const call = (name: string, args: Expr[]): Expr => ({
  kind: "call",
  name,
  args,
});
export const binary = (op: BinaryOp, left: Expr, right: Expr): Expr => ({
  kind: "binary",
  op,
  left,
  right,
});

/**
 * Every free variable referenced by the tree, excluding named constants.
 * Names in `apply` nodes count, since they may turn out to be multiplications,
 * and so does the variable a derivative is taken with respect to. The
 * variables a `min` or `max` ranges over are bound inside it and don't count.
 */
export function freeVars(
  expr: Expr,
  constants: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  const add = (name: string): void => {
    if (!constants.has(name)) out.add(name);
  };
  const walk = (n: Expr): void => {
    switch (n.kind) {
      case "num":
        return;
      case "var":
        add(n.name);
        return;
      case "unary":
        walk(n.arg);
        return;
      case "binary":
        walk(n.left);
        walk(n.right);
        return;
      case "call":
        for (const a of n.args) walk(a);
        return;
      case "apply":
        add(n.name);
        for (const a of n.args) walk(a);
        return;
      case "deriv":
        walk(n.expr);
        if (n.variable) add(n.variable);
        return;
      case "tuple":
        for (const item of n.items) walk(item);
        return;
      case "matrix":
        for (const row of n.rows) for (const item of row) walk(item);
        return;
      case "integral": {
        const names = new Set(n.bounds.map((b) => b.variable));
        for (const part of [n.expr, ...(n.region ? [n.region] : [])]) {
          for (const name of freeVars(part, constants)) if (!names.has(name)) out.add(name);
        }
        // A bound sees only the variables integrated outside it, so in int(f(x), x, 0, x) the upper x is the outer one.
        n.bounds.forEach((b, k) => {
          const outer = new Set(n.bounds.slice(k + 1).map((o) => o.variable));
          for (const part of [b.lo, b.hi]) {
            for (const name of freeVars(part, constants)) if (!outer.has(name)) out.add(name);
          }
        });
        return;
      }
      case "reduce": {
        const inner = freeVars(n.expr, constants);
        for (const b of n.bounds) inner.delete(b.variable);
        for (const name of inner) out.add(name);
        for (const b of n.bounds) {
          walk(b.lo);
          walk(b.hi);
        }
        return;
      }
    }
  };
  walk(expr);
  return out;
}

/** True when any node satisfies `test`. */
export function someNode(expr: Expr, test: (node: Expr) => boolean): boolean {
  if (test(expr)) return true;
  switch (expr.kind) {
    case "num":
    case "var":
      return false;
    case "unary":
      return someNode(expr.arg, test);
    case "binary":
      return someNode(expr.left, test) || someNode(expr.right, test);
    case "call":
    case "apply":
      return expr.args.some((a) => someNode(a, test));
    case "deriv":
      return someNode(expr.expr, test);
    case "tuple":
      return expr.items.some((i) => someNode(i, test));
    case "matrix":
      return expr.rows.some((row) => row.some((i) => someNode(i, test)));
    case "integral":
      return (
        someNode(expr.expr, test) ||
        (expr.region !== null && someNode(expr.region, test)) ||
        expr.bounds.some((b) => someNode(b.lo, test) || someNode(b.hi, test))
      );
    case "reduce":
      return (
        someNode(expr.expr, test) ||
        expr.bounds.some((b) => someNode(b.lo, test) || someNode(b.hi, test))
      );
  }
}

const listEquals = (a: readonly Expr[], b: readonly Expr[]): boolean =>
  a.length === b.length && a.every((item, i) => exprEquals(item, b[i]!));

/** Structural equality, used by the simplifier and by render-cache keys. */
export function exprEquals(a: Expr, b: Expr): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "num":
      return a.value === (b as typeof a).value;
    case "var":
      return a.name === (b as typeof a).name;
    case "unary": {
      const o = b as typeof a;
      return a.op === o.op && exprEquals(a.arg, o.arg);
    }
    case "binary": {
      const o = b as typeof a;
      return (
        a.op === o.op &&
        exprEquals(a.left, o.left) &&
        exprEquals(a.right, o.right)
      );
    }
    case "call": {
      const o = b as typeof a;
      return a.name === o.name && listEquals(a.args, o.args);
    }
    case "apply": {
      const o = b as typeof a;
      return (
        a.name === o.name && a.primes === o.primes && listEquals(a.args, o.args)
      );
    }
    case "deriv": {
      const o = b as typeof a;
      return (
        a.variable === o.variable &&
        a.order === o.order &&
        exprEquals(a.expr, o.expr)
      );
    }
    case "tuple":
      return listEquals(a.items, (b as typeof a).items);
    case "matrix": {
      const o = b as typeof a;
      return (
        a.rows.length === o.rows.length &&
        a.rows.every((row, i) => listEquals(row, o.rows[i]!))
      );
    }
    case "integral": {
      const o = b as typeof a;
      return (
        exprEquals(a.expr, o.expr) &&
        (a.region === null ? o.region === null : o.region !== null && exprEquals(a.region, o.region)) &&
        a.bounds.length === o.bounds.length &&
        a.bounds.every(
          (bound, i) =>
            bound.variable === o.bounds[i]!.variable &&
            exprEquals(bound.lo, o.bounds[i]!.lo) &&
            exprEquals(bound.hi, o.bounds[i]!.hi),
        )
      );
    }
    case "reduce": {
      const o = b as typeof a;
      return (
        a.op === o.op &&
        a.component === o.component &&
        exprEquals(a.expr, o.expr) &&
        a.bounds.length === o.bounds.length &&
        a.bounds.every(
          (bound, i) =>
            bound.variable === o.bounds[i]!.variable &&
            exprEquals(bound.lo, o.bounds[i]!.lo) &&
            exprEquals(bound.hi, o.bounds[i]!.hi),
        )
      );
    }
  }
}
