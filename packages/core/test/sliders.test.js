import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KANAGAWA_DRAGON,
  analyzeDocument,
  drawSliders,
  rewriteSliderValue,
  sliderTracks,
  snapSliderValue,
} from "../dist/index.js";

const analyse = (sources) =>
  analyzeDocument(sources.map((source, i) => ({ id: String(i), source, color: "#8ba4b0" })));

test("[0.1] after a slider sets only its step", () => {
  const { entries, sliders } = analyse(["a = 2 [0.1]"]);
  assert.equal(entries[0].error, null);
  assert.equal(sliders[0].step, 0.1);
  assert.equal(sliders[0].min, -10);
  assert.equal(sliders[0].max, 10);
});

test("a lone value elsewhere explains that it only sets a step", () => {
  const [entry] = analyse(["y = x [0.5]"]).entries;
  assert.match(entry.error, /only sets a slider's step/);
});

test("slider values snap to the step and stay in bounds", () => {
  const slider = { id: "0", name: "a", value: 2, min: 0, max: 10, step: 0.5, valueStart: 4, valueEnd: 5 };
  assert.equal(snapSliderValue(slider, 3.3), 3.5);
  assert.equal(snapSliderValue(slider, -4), 0);
  assert.equal(snapSliderValue(slider, 99), 10);
});

test("rewriting finds the number afresh, however long it has become", () => {
  const slider = { id: "0", name: "a", value: 2, min: 0, max: 10, step: 0.25, valueStart: 4, valueEnd: 5 };
  const once = rewriteSliderValue("a = 2 [0, 10, 0.25]", slider, 3.25);
  assert.equal(once, "a = 3.25 [0, 10, 0.25]");
  // The stored position still points at the old one-digit number.
  assert.equal(rewriteSliderValue(once, slider, 7.5), "a = 7.5 [0, 10, 0.25]");
});

test("tracks stack up from the bottom-left, first slider on top", () => {
  const tracks = sliderTracks([{ id: "a" }, { id: "b" }], 330);
  assert.equal(tracks.length, 2);
  assert.ok(tracks[0].y < tracks[1].y);
  assert.ok(tracks[1].y < 330);
  assert.ok(tracks[0].x1 > tracks[0].x0);
  assert.equal(sliderTracks([1, 2, 3, 4, 5, 6].map((i) => ({ id: String(i) })), 330).length, 4);
});

test("drawing sliders paints the frame without resizing it", () => {
  const width = 460;
  const height = 330;
  const blank = new Uint8ClampedArray(width * height * 4);
  const glyph = { id: "0", name: "a", valueText: "2", value: 2, min: 0, max: 10, active: true, color: "#c4746e" };
  const drawn = drawSliders(blank, width, height, 1, [glyph], KANAGAWA_DRAGON);
  assert.equal(drawn.length, blank.length);
  assert.ok(drawn.some((v) => v !== 0));
  assert.equal(drawSliders(blank, width, height, 1, [], KANAGAWA_DRAGON), blank);
});
