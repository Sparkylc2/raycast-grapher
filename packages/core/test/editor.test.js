import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeDocument, formatHintParts, hintFor, lineColor, parseScene, SERIES_COLORS } from "../dist/index.js";

/** A hint context for a document made of `lines`, as the extension builds it. */
const context = (lines = []) => {
  const others = lines.map((source, i) => ({ id: String(i), source, color: "#8ba4b0" }));
  const analysis = analyzeDocument(others);
  return {
    analyze: (statement) => {
      const entries = analyzeDocument([...others, { id: "hint", source: statement, color: "#8ba4b0" }]).entries;
      return entries[entries.length - 1];
    },
    functions: analysis.functions,
  };
};

const hint = (source, lines) => hintFor(source, context(lines));
const ghost = (source, lines) => formatHintParts(hint(source, lines).parts);

/** Presses Tab before each value in `values`, typing it at the stop Tab reaches. */
const walk = (start, values, lines) => {
  let source = start;
  for (const value of values) source = hint(source, lines).next + value;
  return source;
};

// Hints for whole lines

test("a first-order equation offers its range, then a starting value", () => {
  assert.match(hint("y' = y").title, /first-order differential equation in y\(x\)/);
  assert.equal(ghost("y' = y"), " [‹x from›, ‹x to›] [y(0) = ‹y at 0›]");
  assert.equal(hint("y' = y").next, "y' = y [");
  assert.equal(walk("y' = y", ["-5", "5", "1"]), "y' = y [-5, 5] [y(0) = 1");
  assert.equal(hint("y' = y [-5, 5] [y(0) = 1").next, "y' = y [-5, 5] [y(0) = 1]");
});

test("inside a bracket only what is still to come is shown", () => {
  assert.equal(ghost("y' = y [-5"), ", ‹x to›]");
  assert.equal(ghost("y' = y [-5, 5] [y(0) = "), "‹y at 0›]");
});

test("a second-order equation asks for a value and a slope", () => {
  // The line has an error until both are given, but its shape is still known.
  assert.equal(ghost("y'' = -y"), " [‹x from›, ‹x to›] [y(0) = ‹y at 0›, y'(0) = ‹y' at 0›]");
  assert.equal(walk("y'' = -y", ["0", "10", "0", "1"]), "y'' = -y [0, 10] [y(0) = 0, y'(0) = 1");
});

test("starting values move to the range start when the range leaves out 0", () => {
  assert.equal(hint("y' = y [2, 6]").next, "y' = y [2, 6] [y(2) = ");
});

test("a PDE walks through space and time, then profile and edges from the typed range", () => {
  assert.equal(hint("u_t = u_xx").title, "PDE for u(x, t)");
  const typed = walk("u_t = u_xx", ["0", "pi", "0", "1", "sin(x)", "0", "0"]);
  assert.equal(typed, "u_t = u_xx [0, pi; 0, 1] [u(x, 0) = sin(x), u(0, t) = 0, u(pi, t) = 0");
  assert.equal(hint(typed).next, `${typed}]`);
});

test("a wave equation also asks for a starting velocity", () => {
  assert.match(ghost("u_tt = u_xx [0, 1; 0, 2] ["), /u_t\(x, 0\) = ‹starting velocity›/);
});

test("sliders, curves, surfaces and parametric plots get their own ranges", () => {
  assert.equal(ghost("a = 2"), " [‹low›, ‹high›, ‹step›]");
  assert.equal(ghost("y = sin(x)"), " [‹x from›, ‹x to›]");
  assert.equal(ghost("x^2 + y^2 = 9"), " [‹x from›, ‹x to›; ‹y from›, ‹y to›]");
  assert.equal(ghost("(cos(t), sin(t))"), " [‹t from›, ‹t to›]");
  assert.equal(ghost("z = x y"), " [‹x from›, ‹x to›; ‹y from›, ‹y to›]");
});

test("a finished line keeps its title, with nothing left for Tab", () => {
  const done = hint("y = sin(x) [0, 3]");
  assert.equal(done.title, "curve, y = f(x)");
  assert.equal(done.parts.length, 0);
  assert.equal(done.next, null);
});

// Hints while typing

test("ddx expands to a derivative operator", () => {
  assert.equal(hint("y = ddx").next, "y = d/dx(");
  assert.equal(hint("y = d2dt").next, "y = d^2/dt^2(");
  assert.equal(hint("y = d/dx(x^2").title, "d/dx(expression)");
  assert.equal(hint("y = d/dx(x^2").next, "y = d/dx(x^2)");
});

test("function arguments are stepped through one comma at a time", () => {
  assert.equal(hint("m = min").title, "min(expression, variable, low, high)");
  assert.equal(hint("m = min").next, "m = min(");
  assert.equal(ghost("m = min("), "‹expression›, ‹variable›, ‹low›, ‹high›)");
  assert.equal(ghost("m = min(x^2"), ", ‹variable›, ‹low›, ‹high›)");
  assert.equal(walk("m = min", ["x^2", "x", "-2", "2"]), "m = min(x^2, x, -2, 2");
  assert.equal(hint("m = min(x^2, x, -2, 2").next, "m = min(x^2, x, -2, 2)");
});

test("longer word prefixes complete to a function name", () => {
  assert.equal(hint("p = argmi").next, "p = argmin(");
  assert.equal(ghost("p = argmi"), "n(‹expression›, ‹variable›, ‹low›, ‹high›)");
  // Equal lengths go alphabetically, so argm is argmax.
  assert.equal(hint("p = argm").next, "p = argmax(");
  // Short words are left alone, since they are usually variables; the line's own hint shows instead.
  assert.equal(hint("y = co").next, "y = co [");
});

test("defined functions show their own parameter names", () => {
  const lines = ["g(a, b) = a b"];
  assert.equal(hint("y = g(", lines).title, "g(a, b)");
  assert.equal(hint("y = g(x", lines).next, "y = g(x, ");
});

test("int shows its arguments", () => {
  assert.equal(hint("I = int").title, "int(expression, variable, low, high)");
  assert.equal(hint("I = int(exp(-x^2)").next, "I = int(exp(-x^2), ");
});

test("an open matrix closes with Tab", () => {
  assert.equal(hint("A = [1, 2; 3, 4").next, "A = [1, 2; 3, 4]");
});

test("no hint for an empty line or text that doesn't lex", () => {
  assert.equal(hint("   "), null);
  assert.equal(hint("y = x $"), null);
});

// Functions of x and y

test("a function of x and y draws itself as a surface", () => {
  const [entry] = analyzeDocument([{ id: "0", source: "f(x, y) = x^2 - y^2 [-2, 2; -1, 1]", color: "#8ba4b0" }]).entries;
  assert.equal(entry.error, null);
  assert.equal(entry.kind, "function");
  assert.equal(entry.dimension, 3);
  const surface = entry.surfaces[0];
  assert.equal(surface.kind, "explicitSurface");
  assert.equal(surface.f(1, 2), -3);
  assert.deepEqual(surface.x, { lo: -2, hi: 2 });
  const [swapped] = analyzeDocument([{ id: "0", source: "g(y, x) = x - y", color: "#8ba4b0" }]).entries;
  assert.equal(swapped.surfaces[0].f(5, 2), 3);
});

// Colours

test("a chosen colour overrides the automatic one and survives a reload", () => {
  const scene = parseScene(
    JSON.stringify({
      expressions: [
        { id: "a", source: "y = x", color: "#111111", visible: true, colorIndex: 2 },
        { id: "b", source: "y = 2x", color: "#222222", visible: true },
        { id: "c", source: "y = 3x", color: "#333333", visible: true, colorIndex: 99 },
      ],
    }),
  );
  const [chosen, automatic, invalid] = scene.expressions;
  assert.equal(lineColor(chosen), SERIES_COLORS[2]);
  assert.equal(lineColor(automatic), "#222222");
  assert.equal(invalid.colorIndex, undefined);
  assert.equal(lineColor(invalid), "#333333");
});
