import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FRAME_RATE, ease, frameDelay, imageMarkdown, parseFrameRate } from "./.build/motion.mjs";

const view = (cx, cy, spanY) => ({ cx, cy, spanY });

test("easing depends on elapsed time, not on how many frames were drawn", () => {
  const from = view(0, 0, 10);
  const to = view(4, -2, 5);
  const oneStep = ease(from, to, 60).camera;
  const twoSteps = ease(ease(from, to, 30).camera, to, 30).camera;
  assert.ok(Math.abs(oneStep.cx - twoSteps.cx) < 1e-9);
  assert.ok(Math.abs(oneStep.cy - twoSteps.cy) < 1e-9);
  assert.ok(Math.abs(oneStep.spanY - twoSteps.spanY) < 1e-9);
});

test("easing settles exactly on the target", () => {
  const to = view(1, 2, 3);
  let camera = view(-5, 5, 20);
  let settled = false;
  for (let i = 0; i < 200 && !settled; i++) ({ camera, settled } = ease(camera, to, 33));
  assert.ok(settled);
  assert.deepEqual(camera, to);
});

test("frame cap measures from the last frame drawn", () => {
  assert.ok(Math.abs(frameDelay(1010, 1000, 30) - 1000 / 30 + 10) < 1e-9);
  assert.equal(frameDelay(2000, 1000, 30), 0);
});

test("unexpected frame-rate preferences fall back to the default", () => {
  assert.equal(parseFrameRate("60"), 60);
  assert.equal(parseFrameRate("7"), DEFAULT_FRAME_RATE);
  assert.equal(parseFrameRate(undefined), DEFAULT_FRAME_RATE);
});

// Mirrors how Raycast 2.3 reads a markdown image: size hints come from the
// query, get stripped, and only non-http, non-data sources are treated as
// assets that fade in on every change.
test("frame markdown survives Raycast's image handling as a plain data image", () => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 255, 254]);
  const markdown = imageMarkdown(png, 460, 345);
  const src = markdown.slice(markdown.indexOf("](") + 2, -1);

  const url = URL.parse(src) ?? URL.parse(src.replace(/^.*\?/, "https://example.com?"));
  assert.equal(url.searchParams.get("raycast-width"), "460");
  assert.equal(url.searchParams.get("raycast-height"), "345");

  const loaded = src.replace(/\?.*$/, "");
  assert.ok(loaded.startsWith("data:image/png;base64,"));
  assert.deepEqual([...Buffer.from(loaded.split(",")[1], "base64")], [...png]);

  const isAsset = !src.startsWith("http://") && !src.startsWith("https://") && !src.startsWith("data:");
  assert.equal(isAsset, false);
  assert.ok(!/[()\s]/.test(src), "markdown link targets cannot contain parentheses or spaces");
});
