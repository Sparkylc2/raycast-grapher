import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeDocument } from "../dist/index.js";

const doc = (sources) =>
  analyzeDocument(sources.map((source, i) => ({ id: String(i), source, color: "#8ba4b0" }))).entries;

const near = (actual, expected, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `expected ${expected}, got ${actual}`);

const curve = (entry) => {
  assert.equal(entry.error, null);
  const plot = entry.plots.find((p) => p.kind === "explicit");
  assert.ok(plot, `no curve for ${entry.source}`);
  return plot.f;
};

test("complex constants, their parts and conjugates", () => {
  const [z, a, r, c] = doc(["z = 3 + 4i", "a = abs(z)", "r = re(z * i)", "c = conj(z)"]);
  assert.equal(z.description, "z = 3 + 4i");
  assert.deepEqual(z.axes, ["Re", "Im"]);
  assert.deepEqual([z.plots[0].x, z.plots[0].y], [3, 4]);
  assert.equal(a.description, "a = 5");
  assert.equal(r.description, "r = -4");
  assert.equal(c.description, "c = 3 - 4i");
});

test("complex arithmetic draws a point in the complex plane", () => {
  const [quotient] = doc(["(1 + 2i) / (3 - 4i)"]);
  assert.equal(quotient.error, null);
  near(quotient.plots[0].x, -0.2);
  near(quotient.plots[0].y, 0.4);
  assert.equal(quotient.resolved, "= -0.2 + 0.4i");
});

test("a result that turns out real plots like any real line", () => {
  const f = curve(doc(["y = i^2"])[0]);
  assert.equal(f(0), -1);
  near(curve(doc(["y = re(exp(i x))"])[0])(1), Math.cos(1));
  near(curve(doc(["y = d/dx re(exp(i x))"])[0])(1), -Math.sin(1));
});

test("a complex function of one variable is a curve in the complex plane", () => {
  const [entry] = doc(["exp(i t)"]);
  assert.equal(entry.error, null);
  assert.deepEqual(entry.axes, ["Re", "Im"]);
  const plot = entry.plots[0];
  assert.equal(plot.kind, "parametric");
  near(plot.x(Math.PI), -1);
  near(plot.y(Math.PI / 2), 1);
});

test("moduli of complex polynomials make surfaces, and functions take complex arguments", () => {
  const [surface, , value] = doc(["z = abs((x + i y)^2 - 1)", "f(w) = w^2 + 1", "y = abs(f(x + i))"]);
  assert.equal(surface.error, null);
  assert.equal(surface.surfaces[0].f(1, 0), 0);
  near(surface.surfaces[0].f(0, 1), 2);
  near(curve(value)(1), Math.sqrt(5));
});

test("a complex equation splits into real and imaginary parts", () => {
  const [entry] = doc(["(x + i y)^2 = i"]);
  assert.equal(entry.error, null);
  assert.equal(entry.description, "real and imaginary parts, drawn together");
  for (const plot of entry.plots) near(plot.F(Math.SQRT1_2, Math.SQRT1_2), 0, 1e-12);
});

test("i can still be defined, and complex misuse is explained", () => {
  const [, k] = doc(["i = 2", "k = i + 1"]);
  assert.equal(k.description, "k = 3");
  const [compare, entries, twoVariables] = doc(["sin(x) < i", "[1, i]", "exp(i x) + exp(i t)"]);
  assert.match(compare.error, /can't be compared/);
  assert.match(entries.error, /complex entries/);
  assert.match(twoVariables.error, /needs abs/);
});
