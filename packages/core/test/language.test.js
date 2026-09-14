import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compileFunction,
  differentiate,
  formatExpr,
  parseEntry,
  simplify,
} from "../dist/index.js";

const expr = (source) => {
  const { statement } = parseEntry(source);
  assert.equal(statement.kind, "expr");
  return statement.expr;
};

test("the user's differential equation line parses into all four parts", () => {
  const entry = parseEntry("p^2 + 3q^2 + dp/dq + p_0 = 0 [-5, 5; -5, 5] {q, p} [p0 = 5]");
  assert.equal(entry.statement.kind, "relation");
  assert.equal(entry.intervals.length, 2);
  assert.deepEqual(entry.axes, ["q", "p"]);
  assert.equal(entry.conditions.length, 1);
  assert.deepEqual(entry.conditions[0].left, { kind: "var", name: "p0" });
  // dp/dq survives as a derivative node, and p_0 stays an ordinary name.
  const text = formatExpr(entry.statement.left);
  assert.match(text, /dp\/dq/);
  assert.match(text, /p_0/);
});

test("suffix groups may come in any order", () => {
  const a = parseEntry("y' = y {x, y} [y(0) = 1] [-2, 2]");
  assert.deepEqual(a.axes, ["x", "y"]);
  assert.equal(a.intervals.length, 1);
  assert.equal(a.conditions.length, 1);
});

test("ranges carry an optional step", () => {
  const { intervals } = parseEntry("a = 2 [0, 10, 0.5]");
  assert.equal(intervals[0].step.value, 0.5);
});

test("Leibniz notation in all its forms", () => {
  assert.deepEqual(expr("dp/dq"), { kind: "deriv", expr: { kind: "var", name: "p" }, variable: "q", order: 1 });
  const second = expr("d^2y/dx^2");
  assert.equal(second.order, 2);
  assert.equal(second.variable, "x");
  assert.deepEqual(second.expr, { kind: "var", name: "y" });

  const operator = expr("d/dx x^2");
  assert.equal(operator.kind, "deriv");
  assert.equal(formatExpr(operator.expr), "x^2");

  const operator2 = expr("d^2/dt^2 sin(t)");
  assert.equal(operator2.order, 2);
  assert.equal(operator2.variable, "t");

  // Only the operator's operand is differentiated.
  assert.equal(expr("d/dx x^2 + 1").kind, "binary");
});

test("things that look like Leibniz but are arithmetic stay arithmetic", () => {
  assert.equal(expr("d^2 + 1").kind, "binary");
  assert.equal(expr("d/2").kind, "binary");
  // `dist` is a variable, not the derivative of "ist".
  assert.equal(expr("dist/dt").kind, "binary");
});

test("primes on names, user functions and built-ins", () => {
  assert.deepEqual(expr("p''"), { kind: "deriv", expr: { kind: "var", name: "p" }, variable: null, order: 2 });
  const f = expr("f'(x)");
  assert.equal(f.kind, "apply");
  assert.equal(f.primes, 1);
  const sin = expr("sin'(x)");
  assert.equal(sin.kind, "apply");
  assert.equal(sin.name, "sin");
});

test("tuples, points and function-style application", () => {
  const curve = expr("(cos(t), sin(t))");
  assert.equal(curve.kind, "tuple");
  assert.equal(curve.items.length, 2);
  assert.equal(expr("(1, 2, 3)").items.length, 3);
  assert.deepEqual(expr("f(x, y)").args.length, 2);
  // Plain parentheses are still grouping.
  assert.equal(expr("(x + 1)").kind, "binary");
});

test("bracket and axis mistakes report clearly", () => {
  assert.throws(() => parseEntry("y = x [0, 1, 2, 3]"), /separate axes with ;/);
  assert.throws(() => parseEntry("y = x [0, 1, p = 2]"), /separate brackets/);
  assert.throws(() => parseEntry("y = x {x}"), /two or three axes/);
  assert.throws(() => parseEntry("y = x {x, x}"), /listed twice/);
  assert.throws(() => parseEntry("y = x [0, 1] [2, 3]"), /one \[/);
  assert.throws(() => parseEntry("y = x []"), /Empty brackets/);
});

test("typographic operators and pi are understood", () => {
  const { statement } = parseEntry("y ≤ 2π − x");
  assert.equal(statement.op, "<=");
  // The parser records what was written; folding 2π is the simplifier's job.
  assert.match(formatExpr(statement.right), /3\.14159/);
  assert.match(formatExpr(simplify(statement.right)), /6\.28/);
});

/** Central difference, for checking exact derivatives numerically. */
const numeric = (f, x, h = 1e-5) => (f(x + h) - f(x - h)) / (2 * h);

test("exact derivatives agree with finite differences across built-ins", () => {
  const cases = [
    "sin(x^2)", "cos(3x) tan(x)", "asin(x/2)", "acos(x/3)", "atan(x)", "sinh(x) cosh(x)",
    "tanh(x)", "exp(-x^2)", "ln(x^2 + 1)", "log(x + 3)", "log(x + 3, 2)", "sqrt(x + 4)",
    "cbrt(x - 7)", "abs(x - 0.3)", "x^x", "2^x", "x^3 / (1 + x^2)", "hypot(x, 2)",
    "atan2(x, 2)", "mod(3x, 2)", "min(x, x^2)", "max(sin x, cos x)", "(x^2 + 1)^(1/3)",
  ];
  for (const source of cases) {
    const e = expr(source);
    const f = compileFunction(e, ["x"]);
    const d = compileFunction(differentiate(e, "x"), ["x"]);
    for (const x of [0.37, 1.21, 1.9]) {
      const exact = d(x, {});
      const approx = numeric((v) => f(v, {}), x);
      assert.ok(Math.abs(exact - approx) < 1e-4 * Math.max(1, Math.abs(approx)), `${source} at ${x}: ${exact} vs ${approx}`);
    }
  }
});

test("derivatives simplify to readable forms", () => {
  assert.equal(formatExpr(differentiate(expr("x^2"), "x")), "2x");
  assert.equal(formatExpr(differentiate(expr("3x + 5"), "x")), "3");
  assert.equal(formatExpr(differentiate(expr("a x^3"), "x")), "a * (3x^2)");
  // Other names are constants with respect to x.
  assert.equal(formatExpr(differentiate(expr("y^2 + k"), "x")), "0");
  assert.equal(formatExpr(simplify(expr("0 * x + 1 * y - 0"))), "y");
});

test("formatted expressions parse back to the same value", () => {
  for (const source of ["-x^2", "2^3^2", "(x + 1)(x - 2)", "x - (y - z)", "x / (y * z)", "(-2)^2", "sin(x)^2"]) {
    const e = expr(source);
    const again = expr(formatExpr(e));
    const f = compileFunction(e, ["x", "y", "z"]);
    const g = compileFunction(again, ["x", "y", "z"]);
    assert.equal(f(1.5, 0.5, 2, {}), g(1.5, 0.5, 2, {}), source);
  }
});

test("compiled functions accept any variable name and read other names from parameters", () => {
  const f = compileFunction(expr("p^2 + Math + k"), ["p", "Math"]);
  assert.equal(f(3, 1, { k: 10 }), 20);
  // The same expression and arguments reuse one compiled function.
  assert.equal(compileFunction(expr("p^2 + Math + k"), ["p", "Math"]), f);
});
