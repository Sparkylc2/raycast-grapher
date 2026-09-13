/**
 * Expression AST. Deliberately tiny and backend-agnostic: every renderer
 * (JS closure, GLSL source, future WASM) consumes this same tree, so a graph
 * is parsed exactly once no matter how many surfaces draw it.
 */

export type BinaryOp = "+" | "-" | "*" | "/" | "^";
export type RelationOp = "=" | "<" | ">" | "<=" | ">=";

export type Expr =
  | { kind: "num"; value: number }
  | { kind: "var"; name: string }
  | { kind: "unary"; op: "-" | "+"; arg: Expr }
  | { kind: "binary"; op: BinaryOp; left: Expr; right: Expr }
  | { kind: "call"; name: string; args: Expr[] };

/** A full statement is either a bare expression or a relation between two. */
export type Statement =
  | { kind: "expr"; expr: Expr }
  | { kind: "relation"; op: RelationOp; left: Expr; right: Expr };

export const num = (value: number): Expr => ({ kind: "num", value });
export const variable = (name: string): Expr => ({ kind: "var", name });
export const call = (name: string, args: Expr[]): Expr => ({ kind: "call", name, args });
export const binary = (op: BinaryOp, left: Expr, right: Expr): Expr => ({
  kind: "binary",
  op,
  left,
  right,
});

/** Every free variable referenced by the tree, excluding named constants. */
export function freeVars(expr: Expr, constants: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const walk = (n: Expr): void => {
    switch (n.kind) {
      case "num":
        return;
      case "var":
        if (!constants.has(n.name)) out.add(n.name);
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
    }
  };
  walk(expr);
  return out;
}

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
      return a.op === o.op && exprEquals(a.left, o.left) && exprEquals(a.right, o.right);
    }
    case "call": {
      const o = b as typeof a;
      return (
        a.name === o.name &&
        a.args.length === o.args.length &&
        a.args.every((arg, i) => exprEquals(arg, o.args[i]!))
      );
    }
  }
}
