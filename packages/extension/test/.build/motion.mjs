// src/motion.ts
var EASE_MS = 80;
var FRAME_RATES = [15, 30, 45, 60];
var DEFAULT_FRAME_RATE = 30;
function parseFrameRate(value) {
  const rate = Number(value);
  return FRAME_RATES.includes(rate) ? rate : DEFAULT_FRAME_RATE;
}
function ease(from, to, elapsedMs) {
  const k = 1 - Math.exp(-Math.max(0, elapsedMs) / EASE_MS);
  const logSpan = Math.log(from.spanY) + (Math.log(to.spanY) - Math.log(from.spanY)) * k;
  const camera = {
    cx: from.cx + (to.cx - from.cx) * k,
    cy: from.cy + (to.cy - from.cy) * k,
    spanY: Math.exp(logSpan)
  };
  const tolerance = to.spanY * 2e-3;
  const settled = Math.abs(camera.cx - to.cx) < tolerance && Math.abs(camera.cy - to.cy) < tolerance && Math.abs(Math.log(camera.spanY / to.spanY)) < 2e-3;
  return { camera: settled ? to : camera, settled };
}
function ease3D(from, to, elapsedMs) {
  const k = 1 - Math.exp(-Math.max(0, elapsedMs) / EASE_MS);
  const logDistance = Math.log(from.distance) + (Math.log(to.distance) - Math.log(from.distance)) * k;
  const camera = {
    ...to,
    yaw: from.yaw + (to.yaw - from.yaw) * k,
    pitch: from.pitch + (to.pitch - from.pitch) * k,
    distance: Math.exp(logDistance)
  };
  const settled = Math.abs(camera.yaw - to.yaw) < 1e-3 && Math.abs(camera.pitch - to.pitch) < 1e-3 && Math.abs(Math.log(camera.distance / to.distance)) < 1e-3;
  return { camera: settled ? to : camera, settled };
}
function frameDelay(now, lastFrameAt, fps) {
  return Math.max(0, lastFrameAt + 1e3 / fps - now);
}
function imageMarkdown(png, width, height) {
  const base64 = Buffer.from(
    png.buffer,
    png.byteOffset,
    png.byteLength
  ).toString("base64");
  return `![Plot](data:image/png;base64,${base64}?raycast-width=${width}&raycast-height=${height})`;
}
export {
  DEFAULT_FRAME_RATE,
  EASE_MS,
  FRAME_RATES,
  ease,
  ease3D,
  frameDelay,
  imageMarkdown,
  parseFrameRate
};
