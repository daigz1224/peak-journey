import type maplibregl from 'maplibre-gl';
import type { PlacedRace } from '../data/load.js';

/**
 * Sheikah-style visual effects rendered as MapLibre CustomLayerInterface
 * layers — i.e., on the same WebGL2 canvas as the map. This sidesteps
 * the cross-canvas compositing issues we hit when using a separate WebGPU
 * canvas (Chromium puts WebGPU canvases on hardware-overlay layers that
 * don't blend with HTML siblings).
 *
 * Two layers:
 *   • FogLayer   — multiply-blend dim outside soft reveal circles around races
 *   • ScanLayer  — additive amber radial wave triggered on tier transitions
 *
 * Both render full-screen quads via a shared single-triangle vertex pass.
 */

const MAX_RACES = 64;

// Full-screen triangle in clip space — covers (-1,-1) to (1,1) once after
// rasterizer clipping.
const FULLSCREEN_VS = `#version 300 es
in vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FOG_FS = `#version 300 es
precision highp float;
uniform vec2 u_resolution;
uniform float u_fogStrength;
uniform float u_revealRadius;
uniform int u_raceCount;
uniform vec2 u_racePositions[${MAX_RACES}];
out vec4 fragColor;

void main() {
  // gl_FragCoord origin is bottom-left; flip to top-left so coords match
  // MapLibre's map.project() output.
  vec2 frag = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);

  float minD = 1e9;
  for (int i = 0; i < ${MAX_RACES}; i++) {
    if (i >= u_raceCount) break;
    minD = min(minD, distance(frag, u_racePositions[i]) / u_revealRadius);
  }

  float mask = smoothstep(0.65, 1.45, minD);

  // Sheikah grid: faint hatch every 24px, slightly darker than baseline.
  float g = step(0.965, fract(frag.x / 24.0)) + step(0.965, fract(frag.y / 24.0));

  float dimLevel = 0.22;
  float baseDim = mix(1.0, dimLevel, mask * u_fogStrength);
  float gridDim = mix(baseDim, baseDim * 0.65, g * mask * u_fogStrength);

  // Multiply blend: shader RGB * destination RGB. White preserves map,
  // small values darken it. The slight blue-shift on B channel adds the
  // Sheikah cool tint to the dimmed areas.
  fragColor = vec4(gridDim, gridDim, gridDim * 1.06, 1.0);
}
`;

const SCAN_FS = `#version 300 es
precision highp float;
uniform vec2 u_resolution;
uniform vec2 u_center;
uniform float u_progress;        // 0..1 over the scan duration
uniform float u_maxRadius;
out vec4 fragColor;

// Hairline radar ping. The ring is so thin it reads as a quiet UI flourish
// rather than a flash effect — closer to a Sheikah Slate's idle pulse than
// a "scanning the world" beam. The animation also disappears halfway through
// the scan duration so it's a glance, not a sweep.
void main() {
  vec2 frag = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);

  float d = distance(frag, u_center);
  float waveCenter = u_maxRadius * u_progress;
  // ~2.5 logical px line — thicker so the wave reads as a deliberate
  // "scanner sweep" rather than a hairline you have to hunt for.
  float widthPx = 2.5;
  float dist = abs(d - waveCenter) / widthPx;
  float ring = exp(-dist * dist * 1.0);

  // Quick in, slightly longer out — the ring is gone before the flyTo
  // settles but lingers long enough to be felt.
  float envIn = smoothstep(0.0, 0.10, u_progress);
  float envOut = 1.0 - smoothstep(0.40, 0.65, u_progress);
  float envelope = envIn * envOut;

  float intensity = ring * envelope * 0.55;
  if (intensity < 0.0025) discard;

  // Soft cream, much less saturated than amber. Reads as light, not paint.
  vec3 cream = vec3(0.95, 0.88, 0.74);
  fragColor = vec4(cream * intensity, intensity * 0.8);
}
`;

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('createShader failed');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed: ${info}\n${source}`);
  }
  return shader;
}

function linkProgram(gl: WebGL2RenderingContext, vsSource: string, fsSource: string): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error('createProgram failed');
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, 'a_pos');
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link failed: ${info}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return program;
}

function createQuadVAO(gl: WebGL2RenderingContext): { vao: WebGLVertexArrayObject; vbo: WebGLBuffer } {
  const vao = gl.createVertexArray()!;
  const vbo = gl.createBuffer()!;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  // Single-triangle covering full clip space.
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return { vao, vbo };
}

const REVEAL_RADIUS_LOGICAL_PX = 110;
const BASE_FOG_STRENGTH = 0.85;
const FOG_FADE_ZOOM_LO = 8;
const FOG_FADE_ZOOM_HI = 12;

function smoothstepJS(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export type FogLayer = maplibregl.CustomLayerInterface & {
  setRaces(races: PlacedRace[]): void;
  setFogVisible(v: boolean): void;
};

export function createFogLayer(races: PlacedRace[]): FogLayer {
  let program: WebGLProgram | null = null;
  let vao: WebGLVertexArrayObject | null = null;
  let vbo: WebGLBuffer | null = null;
  let mapRef: maplibregl.Map | null = null;
  let racesRef = races;
  let fogVisible = true;
  let u: Record<string, WebGLUniformLocation | null> = {};

  // Per-frame uniform scratch — hoisted out of render() so we don't churn
  // a fresh Float32Array each frame (60-90/sec would otherwise pile on GC).
  const positionsScratch = new Float32Array(MAX_RACES * 2);

  return {
    id: 'pj-fog',
    type: 'custom',
    renderingMode: '2d',
    onAdd(map, glOrig) {
      mapRef = map;
      const gl = glOrig as WebGL2RenderingContext;
      program = linkProgram(gl, FULLSCREEN_VS, FOG_FS);
      const q = createQuadVAO(gl);
      vao = q.vao;
      vbo = q.vbo;
      u = {
        resolution: gl.getUniformLocation(program, 'u_resolution'),
        fogStrength: gl.getUniformLocation(program, 'u_fogStrength'),
        revealRadius: gl.getUniformLocation(program, 'u_revealRadius'),
        raceCount: gl.getUniformLocation(program, 'u_raceCount'),
        racePositions: gl.getUniformLocation(program, 'u_racePositions'),
      };
    },
    render(glOrig, _args) {
      if (!program || !vao || !mapRef) return;
      const gl = glOrig as WebGL2RenderingContext;

      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const dpr = w / mapRef.getContainer().clientWidth;

      // Project race lat/lng to canvas pixel coords (top-left origin).
      const positions = positionsScratch;
      const count = Math.min(racesRef.length, MAX_RACES);
      for (let i = 0; i < count; i++) {
        const r = racesRef[i]!;
        const p = mapRef.project([r.lon, r.lat]);
        positions[i * 2] = p.x * dpr;
        positions[i * 2 + 1] = p.y * dpr;
      }

      const zoom = mapRef.getZoom();
      const tierFade = 1 - smoothstepJS(FOG_FADE_ZOOM_LO, FOG_FADE_ZOOM_HI, zoom);
      const fogStrength = fogVisible ? BASE_FOG_STRENGTH * tierFade : 0;

      gl.useProgram(program);
      gl.bindVertexArray(vao);

      // Multiply blend so shader RGB scales the framebuffer RGB beneath.
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.DST_COLOR, gl.ZERO, gl.ONE, gl.ZERO);
      gl.disable(gl.DEPTH_TEST);

      gl.uniform2f(u.resolution!, w, h);
      gl.uniform1f(u.fogStrength!, fogStrength);
      gl.uniform1f(u.revealRadius!, REVEAL_RADIUS_LOGICAL_PX * dpr);
      gl.uniform1i(u.raceCount!, count);
      gl.uniform2fv(u.racePositions!, positions);

      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.bindVertexArray(null);
    },
    onRemove(_map, glOrig) {
      const gl = glOrig as WebGL2RenderingContext;
      if (program) gl.deleteProgram(program);
      if (vbo) gl.deleteBuffer(vbo);
      if (vao) gl.deleteVertexArray(vao);
      program = null;
      vao = null;
      vbo = null;
    },
    setRaces(rs) {
      racesRef = rs;
    },
    setFogVisible(v) {
      fogVisible = v;
    },
  };
}

// Drifting amber motes — full-screen particle field that breathes life into
// the static overview camera. Strength fades along the same zoom curve as
// the fog so particles disappear by the time you're at race tier (where
// they'd just be visual noise on a city street).
const PARTICLE_FS = `#version 300 es
precision highp float;
uniform vec2 u_resolution;
uniform float u_time;        // seconds
uniform float u_strength;    // 0..1, fades with zoom
out vec4 fragColor;

#define N_PARTICLES 28

vec2 hash22(float i) {
  vec2 p = vec2(i * 0.1031, i * 0.0973);
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract(vec2(p.x * p.y, (p.x + p.y) * p.x));
}

void main() {
  vec2 frag = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);
  float total = 0.0;

  for (int i = 0; i < N_PARTICLES; i++) {
    float fi = float(i);
    vec2 seedA = hash22(fi);
    vec2 seedB = hash22(fi + 47.0);

    // Slow horizontal-biased drift; angle clusters near horizontal so it
    // reads as wind, not chaos.
    float speed = 6.0 + seedA.x * 10.0;            // logical px/sec
    float angle = (seedB.x - 0.5) * 1.2;           // ±~70°
    vec2 dir = vec2(cos(angle), sin(angle) * 0.6);

    vec2 origin = seedA * u_resolution;
    vec2 pos = origin + dir * u_time * speed;
    pos = mod(pos, u_resolution);

    // Cheap distance-squared early-out: skip the exp() for pixels far away.
    // 6 px radius means ~10x10 = 100 px contribute per particle, vs.
    // exp() on every one of the millions of pixels.
    float radius = 1.6 + seedB.y * 1.2;
    vec2 delta = frag - pos;
    float d2 = dot(delta, delta);
    float r2 = radius * radius;
    if (d2 > r2 * 9.0) continue;
    total += exp(-d2 / (r2 * 1.6));
  }

  if (total < 0.0025) discard;

  vec3 amber = vec3(0.95, 0.74, 0.40);
  float scaled = total * u_strength;
  // Premultiplied alpha — additive on top of the fog/dim.
  fragColor = vec4(amber * scaled * 0.95, scaled * 0.95);
}
`;

export type ParticleLayer = maplibregl.CustomLayerInterface;

export function createParticleLayer(): ParticleLayer {
  let program: WebGLProgram | null = null;
  let vao: WebGLVertexArrayObject | null = null;
  let vbo: WebGLBuffer | null = null;
  let mapRef: maplibregl.Map | null = null;
  let u: Record<string, WebGLUniformLocation | null> = {};
  const start = performance.now();

  return {
    id: 'pj-particles',
    type: 'custom',
    renderingMode: '2d',
    onAdd(map, glOrig) {
      mapRef = map;
      const gl = glOrig as WebGL2RenderingContext;
      program = linkProgram(gl, FULLSCREEN_VS, PARTICLE_FS);
      const q = createQuadVAO(gl);
      vao = q.vao;
      vbo = q.vbo;
      u = {
        resolution: gl.getUniformLocation(program, 'u_resolution'),
        time: gl.getUniformLocation(program, 'u_time'),
        strength: gl.getUniformLocation(program, 'u_strength'),
      };
    },
    render(glOrig, _args) {
      if (!program || !vao || !mapRef) return;

      const zoom = mapRef.getZoom();
      // Same fade curve as fog: full at overview, none past zoom 12.
      const tierFade = 1 - smoothstepJS(FOG_FADE_ZOOM_LO, FOG_FADE_ZOOM_HI, zoom);
      if (tierFade < 0.001) return;

      const gl = glOrig as WebGL2RenderingContext;
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;

      gl.useProgram(program);
      gl.bindVertexArray(vao);

      // Premultiplied additive — add to whatever's underneath.
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.disable(gl.DEPTH_TEST);

      gl.uniform2f(u.resolution!, w, h);
      gl.uniform1f(u.time!, (performance.now() - start) / 1000);
      gl.uniform1f(u.strength!, tierFade);

      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);

      // Wobble already pumps the canvas at ~30fps which is plenty for slow
      // particle drift — and triggering a repaint here would force the
      // browser compositor to recomposite the entire stack every frame
      // (huge fixed cost on high-DPR displays), so we deliberately don't.
    },
    onRemove(_map, glOrig) {
      const gl = glOrig as WebGL2RenderingContext;
      if (program) gl.deleteProgram(program);
      if (vbo) gl.deleteBuffer(vbo);
      if (vao) gl.deleteVertexArray(vao);
      program = null;
      vao = null;
      vbo = null;
    },
  };
}

export type ScanLayer = maplibregl.CustomLayerInterface & {
  trigger(centerLogical?: [number, number], durationMs?: number): void;
};

export function createScanLayer(): ScanLayer {
  let program: WebGLProgram | null = null;
  let vao: WebGLVertexArrayObject | null = null;
  let vbo: WebGLBuffer | null = null;
  let mapRef: maplibregl.Map | null = null;
  let u: Record<string, WebGLUniformLocation | null> = {};
  let scanStart = 0;
  let scanDuration = 1100;
  let scanCenterLogical: [number, number] = [0, 0];
  let scanMaxRadiusLogical = 0;

  return {
    id: 'pj-scan',
    type: 'custom',
    renderingMode: '2d',
    onAdd(map, glOrig) {
      mapRef = map;
      const gl = glOrig as WebGL2RenderingContext;
      program = linkProgram(gl, FULLSCREEN_VS, SCAN_FS);
      const q = createQuadVAO(gl);
      vao = q.vao;
      vbo = q.vbo;
      u = {
        resolution: gl.getUniformLocation(program, 'u_resolution'),
        center: gl.getUniformLocation(program, 'u_center'),
        progress: gl.getUniformLocation(program, 'u_progress'),
        maxRadius: gl.getUniformLocation(program, 'u_maxRadius'),
      };
    },
    render(glOrig, _args) {
      if (!program || !vao || !mapRef) return;
      const now = performance.now();
      if (scanStart === 0) return;
      const elapsed = now - scanStart;
      if (elapsed >= scanDuration) {
        scanStart = 0;
        return;
      }
      const progress = elapsed / scanDuration;

      const gl = glOrig as WebGL2RenderingContext;
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const dpr = w / mapRef.getContainer().clientWidth;

      gl.useProgram(program);
      gl.bindVertexArray(vao);

      // Additive premultiplied: out.rgb = src.rgb + dst.rgb * (1 - src.a)
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.disable(gl.DEPTH_TEST);

      gl.uniform2f(u.resolution!, w, h);
      gl.uniform2f(u.center!, scanCenterLogical[0] * dpr, scanCenterLogical[1] * dpr);
      gl.uniform1f(u.progress!, progress);
      gl.uniform1f(u.maxRadius!, scanMaxRadiusLogical * dpr);

      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.bindVertexArray(null);

      // Keep MapLibre rendering each frame while a scan is active.
      mapRef.triggerRepaint();
    },
    onRemove(_map, glOrig) {
      const gl = glOrig as WebGL2RenderingContext;
      if (program) gl.deleteProgram(program);
      if (vbo) gl.deleteBuffer(vbo);
      if (vao) gl.deleteVertexArray(vao);
      program = null;
      vao = null;
      vbo = null;
    },
    trigger(centerLogical, durationMs) {
      if (!mapRef) return;
      const cw = mapRef.getContainer().clientWidth;
      const ch = mapRef.getContainer().clientHeight;
      const cx = centerLogical ? centerLogical[0] : cw / 2;
      const cy = centerLogical ? centerLogical[1] : ch / 2;
      scanCenterLogical = [cx, cy];
      scanDuration = durationMs ?? 1100;
      scanMaxRadiusLogical = Math.max(
        Math.hypot(cx, cy),
        Math.hypot(cw - cx, cy),
        Math.hypot(cx, ch - cy),
        Math.hypot(cw - cx, ch - cy),
      );
      scanStart = performance.now();
      mapRef.triggerRepaint();
    },
  };
}
