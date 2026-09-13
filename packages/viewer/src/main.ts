import {
  type Camera2D,
  type GraphTheme,
  type RGB,
  type Scene,
  KANAGAWA_DRAGON,
  KANAGAWA_LOTUS,
  bounds2D,
  classify,
  emptyScene,
  hexToRgbUnit,
  panBy,
  parse,
  parseScene,
  seriesColor,
  zoomAbout,
} from "@grapher/core";
import { VERTEX_SHADER, createProgram } from "./gl.js";
import { GRID_FRAGMENT, fragmentFor, gridStep } from "./shaders.js";

interface Layer {
  readonly source: string;
  readonly program: WebGLProgram;
  readonly color: RGB;
  readonly strict: boolean;
}

const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
const themeFor = (dark: boolean): GraphTheme => (dark ? KANAGAWA_DRAGON : KANAGAWA_LOTUS);
let theme = themeFor(prefersDark.matches);

const canvas = document.querySelector<HTMLCanvasElement>("#stage")!;
const hud = document.querySelector<HTMLDivElement>("#hud")!;
const gl = canvas.getContext("webgl2", { alpha: true, antialias: false, premultipliedAlpha: false });

if (!gl) {
  hud.innerHTML = `<span id="err">WebGL2 is unavailable in this window.</span>`;
  throw new Error("WebGL2 unavailable");
}

let scene: Scene = readScene();
let camera: Camera2D = scene.camera2d;
let layers: Layer[] = [];
let errors: string[] = [];
let cursor: { x: number; y: number } | null = null;
let needsDraw = true;

function readScene(): Scene {
  const hash = location.hash.slice(1);
  if (hash) return parseScene(decodeURIComponent(hash));
  // A standing demo so the window is never blank on first open.
  const demo = ["y = sin(x) + 0.4 x", "x^2 + y^2 = 9", "3x + 5 = 7", "y < 0.3 x^2 - 4"];
  return {
    ...emptyScene(),
    expressions: demo.map((source, i) => ({
      id: String(i),
      source,
      color: seriesColor(theme, i),
      visible: true,
    })),
  };
}

function rebuild(): void {
  for (const layer of layers) gl!.deleteProgram(layer.program);
  layers = [];
  errors = [];

  for (const entry of scene.expressions) {
    if (!entry.visible) continue;
    try {
      const { graph } = classify(parse(entry.source));
      const fragment = fragmentFor(graph);
      if (!fragment) {
        errors.push(`${entry.source} — 3D rendering is not wired up yet`);
        continue;
      }
      layers.push({
        source: entry.source,
        program: createProgram(gl!, VERTEX_SHADER, fragment),
        color: hexToRgbUnit(entry.color),
        strict: graph.type === "inequality2d" && graph.strict,
      });
    } catch (error) {
      errors.push(`${entry.source} — ${(error as Error).message}`);
    }
  }
  needsDraw = true;
}

const gridProgram = createProgram(gl, VERTEX_SHADER, GRID_FRAGMENT);

function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(canvas.clientWidth * dpr);
  const height = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    needsDraw = true;
  }
}

function draw(): void {
  resize();
  if (!needsDraw) return;
  needsDraw = false;

  const { width, height } = canvas;
  const aspect = width / height;
  const b = bounds2D(camera, aspect);
  const boundsVec = [b.minX, b.minY, b.maxX, b.maxY] as const;

  gl!.viewport(0, 0, width, height);
  gl!.clearColor(0, 0, 0, 0);
  gl!.clear(gl!.COLOR_BUFFER_BIT);
  gl!.enable(gl!.BLEND);
  gl!.blendFunc(gl!.SRC_ALPHA, gl!.ONE_MINUS_SRC_ALPHA);

  gl!.useProgram(gridProgram);
  setCommon(gridProgram, width, height, boundsVec);
  gl!.uniform1f(gl!.getUniformLocation(gridProgram, "u_step"), gridStep(camera.spanY, height));
  gl!.uniform3fv(gl!.getUniformLocation(gridProgram, "u_grid"), new Float32Array(hexToRgbUnit(theme.grid)));
  gl!.uniform3fv(gl!.getUniformLocation(gridProgram, "u_axis"), new Float32Array(hexToRgbUnit(theme.axis)));
  gl!.drawArrays(gl!.TRIANGLES, 0, 3);

  for (const layer of layers) {
    gl!.useProgram(layer.program);
    setCommon(layer.program, width, height, boundsVec);
    gl!.uniform3fv(gl!.getUniformLocation(layer.program, "u_color"), new Float32Array(layer.color));
    gl!.uniform1f(gl!.getUniformLocation(layer.program, "u_width"), 1.6);
    gl!.uniform1f(gl!.getUniformLocation(layer.program, "u_strict"), layer.strict ? 1 : 0);
    gl!.drawArrays(gl!.TRIANGLES, 0, 3);
  }

  updateHud();
}

function setCommon(program: WebGLProgram, width: number, height: number, bounds: readonly number[]): void {
  gl!.uniform2f(gl!.getUniformLocation(program, "u_resolution"), width, height);
  gl!.uniform4f(
    gl!.getUniformLocation(program, "u_bounds"),
    bounds[0]!,
    bounds[1]!,
    bounds[2]!,
    bounds[3]!,
  );
}

function updateHud(): void {
  const lines = layers.map((l) => l.source);
  if (cursor) lines.push(`(${cursor.x.toFixed(3)}, ${cursor.y.toFixed(3)})`);
  const errorHtml = errors.length
    ? `\n<span id="err">${errors.map(escapeHtml).join("\n")}</span>`
    : "";
  hud.innerHTML = escapeHtml(lines.join("\n")) + errorHtml;
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

/** Screen pixel to world coordinate, accounting for the flipped y axis. */
function toWorld(clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const b = bounds2D(camera, rect.width / rect.height);
  return {
    x: b.minX + ((clientX - rect.left) / rect.width) * (b.maxX - b.minX),
    y: b.maxY - ((clientY - rect.top) / rect.height) * (b.maxY - b.minY),
  };
}

let dragging: { x: number; y: number } | null = null;

canvas.addEventListener("pointerdown", (event) => {
  dragging = toWorld(event.clientX, event.clientY);
  canvas.classList.add("dragging");
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener("pointermove", (event) => {
  cursor = toWorld(event.clientX, event.clientY);
  if (dragging) {
    // Pan by the world-space delta so the grabbed point tracks the pointer.
    camera = panBy(camera, cursor.x - dragging.x, cursor.y - dragging.y);
    dragging = toWorld(event.clientX, event.clientY);
    persist();
  }
  needsDraw = true;
});

for (const type of ["pointerup", "pointercancel"] as const) {
  canvas.addEventListener(type, () => {
    dragging = null;
    canvas.classList.remove("dragging");
  });
}

canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const anchor = toWorld(event.clientX, event.clientY);
    camera = zoomAbout(camera, Math.exp(event.deltaY * 0.002), anchor.x, anchor.y);
    needsDraw = true;
    persist();
  },
  { passive: false },
);

let persistTimer = 0;
function persist(): void {
  clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    scene = { ...scene, camera2d: camera };
    history.replaceState(null, "", `#${encodeURIComponent(JSON.stringify(scene))}`);
  }, 250);
}

window.addEventListener("hashchange", () => {
  scene = readScene();
  camera = scene.camera2d;
  rebuild();
});

prefersDark.addEventListener("change", (event) => {
  theme = themeFor(event.matches);
  applyThemeToPage();
  needsDraw = true;
});

/** The page chrome reads the same palette as the plot, via CSS custom properties. */
function applyThemeToPage(): void {
  const root = document.documentElement.style;
  root.setProperty("--ground", theme.background);
  root.setProperty("--panel", theme.surface);
  root.setProperty("--ink", theme.text);
  root.setProperty("--error", theme.error);
}

applyThemeToPage();

rebuild();
(function loop(): void {
  draw();
  requestAnimationFrame(loop);
})();
