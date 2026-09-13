import { GLSL_PRELUDE, type Graph, niceStep, toGlslSource } from "@grapher/core";

/**
 * Both 2D curve families collapse into one shader.
 *
 * `y = f(x)` is just the zero set of `y - f(x)`, so explicit and implicit
 * graphs share a single fragment program. The curve is found by dividing the
 * field value by its screen-space gradient, which gives the distance to the
 * zero set in pixels and therefore a constant line width at any zoom.
 */
const CURVE_BODY = `
  float v = field(p.x, p.y);
  if (isnan(v) || isinf(v)) discard;
  float g = length(vec2(dFdx(v), dFdy(v)));
  if (g < 1e-20) discard;
  float d = abs(v) / g;
  float a = 1.0 - smoothstep(u_width - 1.0, u_width + 1.0, d);
  if (a <= 0.0) discard;
  fragColor = vec4(u_color, a);
`;

const REGION_BODY = `
  float v = field(p.x, p.y);
  if (isnan(v)) discard;
  float g = length(vec2(dFdx(v), dFdy(v)));
  float d = g > 1e-20 ? v / g : (v < 0.0 ? -1e9 : 1e9);
  float inside = 1.0 - smoothstep(-1.0, 1.0, d);
  float edge = u_strict > 0.5 ? 0.0 : 1.0 - smoothstep(u_width - 1.0, u_width + 1.0, abs(d));
  float a = max(inside * 0.2, edge);
  if (a <= 0.0) discard;
  fragColor = vec4(u_color, a);
`;

function fragment(fieldSource: string, body: string): string {
  return `#version 300 es
precision highp float;
uniform vec2 u_resolution;
uniform vec4 u_bounds;
uniform vec3 u_color;
uniform float u_width;
uniform float u_strict;
out vec4 fragColor;
${GLSL_PRELUDE}
float field(float x, float y) {
  return ${fieldSource};
}
void main() {
  vec2 p = mix(u_bounds.xy, u_bounds.zw, gl_FragCoord.xy / u_resolution);
${body}
}`;
}

/** Builds the fragment shader for a 2D graph, or null when it is a 3D one. */
export function fragmentFor(graph: Graph): string | null {
  switch (graph.type) {
    case "explicit2d":
      // Re-expressed as an implicit field so it shares the curve shader.
      return fragment(`y - (${toGlslSource(graph.fn)})`, CURVE_BODY);
    case "implicit2d":
      return fragment(toGlslSource(graph.field), CURVE_BODY);
    case "inequality2d":
      return fragment(toGlslSource(graph.field), REGION_BODY);
    default:
      return null;
  }
}

export const GRID_FRAGMENT = `#version 300 es
precision highp float;
uniform vec2 u_resolution;
uniform vec4 u_bounds;
uniform float u_step;
uniform vec3 u_grid;
uniform vec3 u_axis;
out vec4 fragColor;

// Distance in pixels from p to the nearest multiple of the step on each axis.
vec2 gridDistance(vec2 p, vec2 unitsPerPixel, float step) {
  vec2 m = abs(mod(p + 0.5 * step, step) - 0.5 * step);
  return m / unitsPerPixel;
}

void main() {
  vec2 p = mix(u_bounds.xy, u_bounds.zw, gl_FragCoord.xy / u_resolution);
  vec2 unitsPerPixel = (u_bounds.zw - u_bounds.xy) / u_resolution;

  float minor = 1.0 - smoothstep(0.0, 1.0, min(gridDistance(p, unitsPerPixel, u_step).x,
                                               gridDistance(p, unitsPerPixel, u_step).y));
  vec2 major = gridDistance(p, unitsPerPixel, u_step * 5.0);
  float bold = 1.0 - smoothstep(0.0, 1.0, min(major.x, major.y));
  vec2 axisPx = abs(p) / unitsPerPixel;
  float axis = 1.0 - smoothstep(0.0, 1.4, min(axisPx.x, axisPx.y));

  // Kept in step with the CPU renderer's gridline alphas on purpose: the two
  // surfaces are meant to produce the same picture.
  float a = max(minor * 0.3, bold * 0.55);
  vec3 color = mix(u_grid, u_axis, axis);
  a = max(a, axis * 0.9);
  if (a <= 0.0) discard;
  fragColor = vec4(color, a);
}`;

/** Re-exported so the viewer and the Raycast still agree on gridline spacing. */
export const gridStep = niceStep;
