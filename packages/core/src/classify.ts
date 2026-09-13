import { type Expr, type Statement, binary, freeVars, num } from "./ast.js";
import { CONSTANT_NAMES } from "./builtins.js";
import { ParseError } from "./lexer.js";

/**
 * What the renderers are actually asked to draw.
 *
 * Everything reduces to one of five shapes. The implicit forms are the general
 * case and the explicit ones are fast paths, so an expression that resists
 * solving still plots instead of erroring.
 */
export type Graph =
  /** y = f(x), sampled as a polyline. */
  | { type: "explicit2d"; fn: Expr }
  /** f(x, y) = 0, drawn as the zero contour. */
  | { type: "implicit2d"; field: Expr }
  /** f(x, y) < 0, drawn as a shaded region with an optional boundary. */
  | { type: "inequality2d"; field: Expr; strict: boolean }
  /** z = f(x, y), drawn as a height field. */
  | { type: "surface3d"; fn: Expr }
  /** f(x, y, z) = 0, drawn by raymarching the sign change. */
  | { type: "implicit3d"; field: Expr };

export interface Classified {
  readonly graph: Graph;
  readonly dimension: 2 | 3;
  /** Free variables that are not coordinates: future slider parameters. */
  readonly parameters: readonly string[];
}

const COORDS: ReadonlySet<string> = new Set(["x", "y", "z"]);

const subtract = (left: Expr, right: Expr): Expr =>
  right.kind === "num" && right.value === 0 ? left : binary("-", left, right);

const negate = (e: Expr): Expr => binary("-", num(0), e);

const isVar = (e: Expr, name: string): boolean => e.kind === "var" && e.name === name;

export function dimensionOf(graph: Graph): 2 | 3 {
  return graph.type === "surface3d" || graph.type === "implicit3d" ? 3 : 2;
}

/**
 * Decide how a parsed statement should be drawn.
 *
 * `solveFor` lets an explicit form win only when the target variable is
 * isolated on one side and absent from the other, which is what keeps
 * `y = x^2` on the fast path while `x^2 + y^2 = 1` falls through to implicit.
 */
export function classify(statement: Statement): Classified {
  const graph = toGraph(statement);
  const fieldExpr =
    graph.type === "explicit2d" || graph.type === "surface3d" ? graph.fn : graph.field;
  const vars = freeVars(fieldExpr, CONSTANT_NAMES);
  const parameters = [...vars].filter((v) => !COORDS.has(v)).sort();

  return { graph, dimension: dimensionOf(graph), parameters };
}

function toGraph(statement: Statement): Graph {
  if (statement.kind === "expr") {
    const vars = freeVars(statement.expr, CONSTANT_NAMES);
    if (vars.has("z")) return { type: "implicit3d", field: statement.expr };
    if (vars.has("y")) return { type: "implicit2d", field: statement.expr };
    // Bare `sin(x)` or a lone constant both mean y = that.
    return { type: "explicit2d", fn: statement.expr };
  }

  const { op, left, right } = statement;

  if (op === "=") {
    const explicit = solveFor(left, right);
    if (explicit) return explicit;

    const field = subtract(left, right);
    const vars = freeVars(field, CONSTANT_NAMES);
    return vars.has("z")
      ? { type: "implicit3d", field }
      : { type: "implicit2d", field };
  }

  // Inequalities normalise to `field < 0` (or <= 0) so the shader only ever
  // has to test one direction.
  const strict = op === "<" || op === ">";
  const raw = subtract(left, right);
  const field = op === "<" || op === "<=" ? raw : negate(raw);

  if (freeVars(field, CONSTANT_NAMES).has("z")) {
    throw new ParseError("3D inequalities are not supported yet", 0, 0);
  }
  return { type: "inequality2d", field, strict };
}

/** Returns an explicit graph when one side is a bare `y` or `z` and the other is free of it. */
function solveFor(left: Expr, right: Expr): Graph | null {
  for (const [a, b] of [
    [left, right],
    [right, left],
  ] as const) {
    const other = freeVars(b, CONSTANT_NAMES);

    if (isVar(a, "y") && !other.has("y") && !other.has("z")) {
      return { type: "explicit2d", fn: b };
    }
    if (isVar(a, "z") && !other.has("z")) {
      return { type: "surface3d", fn: b };
    }
  }
  return null;
}
