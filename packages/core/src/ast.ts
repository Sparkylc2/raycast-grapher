/**
 * Expression AST. Deliberately tiny and backend-agnostic: every renderer
 * (JS closure, GLSL source, future WASM) consumes this same tree, so a graph
 * is parsed exactly once no matter how many surfaces draw it.
 *
 * The parser only records what was written. Whether `f(x)` is a call or a
 * product, or whether `dp/dq` is an unknown in a differential equation, depends
 * on the other lines in the document, so `document.ts` decides that later.
 */

export type BinaryOp = "+" | "-" | "*" | "/" | "^";
export type RelationOp = "=" | "<" | ">" | "<=" | ">=";

export type Expr =
  | { kind: "num"; value: number }
  | { kind: "var"; name: string }
  | { kind: "unary"; op: "-" | "+"; arg: Expr }
  | { kind: "binary"; op: BinaryOp; left: Expr; right: Expr }
  /** A built-in function call, arity already checked. */
  | { kind: "call"; name: string; args: Expr[] }
  /**
   * `name(args)` where `name` is not built in, optionally with primes as in
   * `f'(x)`. Either a user function call or juxtaposed multiplication.
   */
  | { kind: "apply"; name: string; args: Expr[]; primes: number }
  /**
   * A derivative. `variable` is null for prime notation on a bare name, such
   * as `p''`, where the variable is whatever the equation's independent one is.
   */
  | { kind: "deriv"; expr: Expr; variable: string | null; order: number }
  /** `(a, b)` or `(a, b, c)`: a point or a parametric curve or surface. */
  | { kind: "tuple"; items: Expr[] };

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
 * and so does the variable a derivative is taken with respect to.
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
  }
}
