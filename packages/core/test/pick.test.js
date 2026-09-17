import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeDocument, pickPlot } from "../dist/index.js";

const targets = (sources) =>
  analyzeDocument(sources.map((source, i) => ({ id: String(i), source, color: "#8ba4b0" }))).entries.map((e) => ({ id: e.id, plots: e.plots }));

test("a click near a curve picks its line, measuring across a steep slope", () => {
  const lines = targets(["y = x^2", "y = -3"]);
  assert.equal(pickPlot(lines, 1, 1.05, 0.1), "0");
  // At x = 3 the parabola is steep, so a click a little to its side is still close.
  assert.equal(pickPlot(lines, 3.05, 9, 0.2), "0");
  assert.equal(pickPlot(lines, 0.5, -2.95, 0.1), "1");
  assert.equal(pickPlot(lines, 0, 5, 0.1), null);
});

test("implicit curves, points, arrows and parametric curves can be picked", () => {
  const lines = targets(["x^2 + y^2 = 4", "(3, 3)", "v = [-3; 0]", "(cos(t) - 4, sin(t))"]);
  assert.equal(pickPlot(lines, 2.05, 0, 0.1), "0");
  assert.equal(pickPlot(lines, 3.02, 2.98, 0.1), "1");
  assert.equal(pickPlot(lines, -1.5, 0.05, 0.1), "2");
  assert.equal(pickPlot(lines, -4, 1.04, 0.1), "3");
});

test("a curve wins over the shaded region it sits in", () => {
  const lines = targets(["y < x", "y = 0.5"]);
  assert.equal(pickPlot(lines, 2, 0.52, 0.1), "1");
  assert.equal(pickPlot(lines, 2, -1, 0.1), "0");
});
