import type maplibregl from 'maplibre-gl';
import { getYearFromDate, type PlacedRace } from '../data/load.js';
import { RACE_CORE_LAYER, RACE_HALO_LAYER } from './map.js';
import type { Palette } from './palettes.js';

/**
 * Custom WebGL2 layer that renders race markers with a breathing pulse,
 * inner core + outer halo bloom, and a hover flare. Replaces the static
 * MapLibre circle layers (which we keep around at opacity 0 purely for
 * hit detection so map.on('click', RACE_*_LAYER, …) still works).
 */

const MAX_MARKERS = 64;

const VS = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FS = `#version 300 es
precision highp float;
uniform vec2 u_resolution;
uniform float u_time;
uniform int u_count;
uniform int u_hovered;       // index in u_marker, -1 if none
uniform vec4 u_marker[${MAX_MARKERS}];   // (x_px, y_px, coreR_px, haloR_px)
uniform float u_glow[${MAX_MARKERS}];    // 0..1 halo intensity from elevation
uniform float u_entryBoost[${MAX_MARKERS}]; // 0..1 transient pulse on tier entry
uniform float u_globalAlpha;            // 0..1 layer-wide fade for filter transitions
uniform vec3 u_coreColor;
uniform vec3 u_haloColor;
out vec4 fragColor;

void main() {
  // gl_FragCoord origin is bottom-left; flip so coords match map.project().
  vec2 frag = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);

  vec3 accum = vec3(0.0);
  float alpha = 0.0;

  for (int i = 0; i < ${MAX_MARKERS}; i++) {
    if (i >= u_count) break;
    vec4 m = u_marker[i];
    float coreR = m.z;
    float haloR = m.w;
    float glow = u_glow[i];
    float entry = u_entryBoost[i];

    // Breathing pulse — phase-offset per index so the field doesn't pulse in
    // unison. ~0.45 Hz overall, bigger amplitude than a passive glow so the
    // map reads as actively alive.
    float phase = u_time * 0.9 + float(i) * 0.83;
    float pulse01 = 0.5 + 0.5 * sin(phase);
    float coreScale = 0.85 + 0.18 * pulse01;
    float haloScale = 0.88 + 0.14 * pulse01;

    // Entry pulse: when the user enters a cluster (or single race) tier, its
    // member markers briefly swell + brighten so the eye lands there before
    // the camera even finishes its flyTo. Pure additive on top of breathing.
    coreScale += entry * 0.55;
    haloScale += entry * 0.40;

    bool hovered = (i == u_hovered);
    if (hovered) {
      coreScale *= 1.22;
      haloScale *= 1.45;
    }

    coreR *= coreScale;
    haloR *= haloScale;

    float d = distance(frag, m.xy);

    // Halo — Gaussian-ish radial falloff with extra brightness near center.
    float t = d / haloR;
    float haloFalloff = exp(-t * t * 1.9);
    float haloA = haloFalloff * mix(0.55, 1.15, glow) * (hovered ? 1.9 : 1.25)
                * (0.7 + 0.3 * pulse01)
                * (1.0 + entry * 0.7);

    // Inner aura — a tighter, brighter halo just outside the core.
    float aura = exp(-pow(d / (coreR * 2.4), 2.0) * 1.4)
               * (hovered ? 1.0 : 0.7) * (0.85 + 0.15 * pulse01);

    // Core — hard-edged disk with soft inner bloom for depth.
    float coreA = 1.0 - smoothstep(coreR * 0.55, coreR, d);
    float coreBloom = exp(-pow(d / (coreR * 1.05), 2.0) * 5.0) * 0.7;
    coreA = max(coreA, coreBloom);

    // Compose halo (warm amber) + aura (slightly hotter) + core (incandescent)
    vec3 haloRGB = u_haloColor * (haloA + aura * 0.6);
    vec3 hot = mix(u_coreColor, vec3(1.0, 0.96, 0.86), 0.5);
    vec3 coreRGB = mix(u_coreColor, vec3(1.0, 0.98, 0.92), coreA * 0.7) * coreA * 1.9;

    accum += haloRGB + coreRGB + hot * aura * 0.25;
    alpha = max(alpha, max(haloA + aura * 0.4, coreA));
  }

  // Premultiplied additive output. Multiply RGB and alpha by u_globalAlpha
  // so a filter transition can fade the whole layer in/out cleanly without
  // each marker's individual breathing/entry math leaking through.
  float effectiveAlpha = alpha * u_globalAlpha;
  if (effectiveAlpha < 0.003) discard;
  fragColor = vec4(accum * u_globalAlpha, effectiveAlpha);
}
`;

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('createShader failed');
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`Shader compile failed: ${log}`);
  }
  return sh;
}

function linkProgram(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error('createProgram failed');
  const vss = compileShader(gl, gl.VERTEX_SHADER, vs);
  const fss = compileShader(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(program, vss);
  gl.attachShader(program, fss);
  gl.bindAttribLocation(program, 0, 'a_pos');
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Program link failed: ${log}`);
  }
  gl.deleteShader(vss);
  gl.deleteShader(fss);
  return program;
}

// Match the original MapLibre piecewise-linear scales so the visual encoding
// contract (distance → size, elevation → glow) stays exactly as documented in
// HANDOFF.md.
function lerpStops(stops: Array<[number, number]>, x: number): number {
  if (x <= stops[0]![0]) return stops[0]![1];
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]!, b = stops[i]!;
    if (x <= b[0]) return a[1] + (b[1] - a[1]) * ((x - a[0]) / (b[0] - a[0]));
  }
  return stops[stops.length - 1]![1];
}

const CORE_R_STOPS: Array<[number, number]> = [[10, 4], [50, 7], [100, 10], [200, 14]];
const HALO_R_STOPS: Array<[number, number]> = [[10, 18], [50, 32], [100, 46], [200, 64]];
const GLOW_STOPS: Array<[number, number]> = [[300, 0.25], [2000, 0.55], [5000, 0.85]];

function parseHex(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [1, 1, 1];
  const v = parseInt(m[1]!, 16);
  return [((v >> 16) & 0xff) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255];
}

type DerivedRace = {
  id: string;
  lon: number;
  lat: number;
  year: number;
  category: string;
  coreRadius: number;
  haloRadius: number;
  glow: number;
};

function deriveMarkerData(races: PlacedRace[]): DerivedRace[] {
  return races.map((r) => ({
    id: r.id,
    lon: r.lon,
    lat: r.lat,
    year: getYearFromDate(r.date),
    category: r.category ?? '',
    coreRadius: lerpStops(CORE_R_STOPS, r.distanceKm ?? 0),
    haloRadius: lerpStops(HALO_R_STOPS, r.distanceKm ?? 0),
    glow: lerpStops(GLOW_STOPS, r.elevationGainM ?? 0),
  }));
}

export type MarkerFilter = {
  yearMin: number;
  yearMax: number;
  /** null = all categories pass. */
  categories: ReadonlySet<string> | null;
};

export type MarkerLayer = maplibregl.CustomLayerInterface & {
  setRaces(races: PlacedRace[]): void;
  setFilter(f: MarkerFilter): void;
  setPalette(p: Palette): void;
  /** Briefly swell + brighten the listed marker IDs to draw the eye on
   *  tier entry. Pulse rises instantly to 1, falls to 0 over ~700ms with
   *  easeOutCubic. Re-trigger restarts the curve from 1. */
  triggerEntryPulse(ids: ReadonlyArray<string>): void;
  /** Layer-wide opacity multiplier (0..1). Used by the cinematic filter
   *  transition: caller fades to 0, swaps the filter while invisible, fades
   *  back to 1 — all coordinated with a Sheikah scan running on top. */
  setGlobalAlpha(alpha: number): void;
};

const ENTRY_PULSE_MS = 700;

export function createMarkerLayer(initialRaces: PlacedRace[], initialPalette: Palette): MarkerLayer {
  // Display positions baked in by [src/scene/map.ts] are in the GeoJSON
  // source. To stay consistent and avoid duplicating petal-layout logic, we
  // pull live coords each frame via map.querySourceFeatures.
  let derived = deriveMarkerData(initialRaces);
  let yearMin = -Infinity;
  let yearMax = Infinity;
  let categories: ReadonlySet<string> | null = null;
  let palette = initialPalette;
  let coreColorRGB = parseHex(palette.markerCore);
  let haloColorRGB = parseHex(palette.markerHalo);
  let hoveredId: string | null = null;
  let entryStartedAt = 0;
  let entryMembers: ReadonlySet<string> = new Set();
  let globalAlpha = 1;

  // Pre-allocated per-frame uniform scratch. Hoisted out of render() so we
  // don't churn three Float32Arrays per frame (~180/sec at 60fps), which
  // adds avoidable GC pressure during sustained breathing animation.
  const positionsScratch = new Float32Array(MAX_MARKERS * 4);
  const glowsScratch = new Float32Array(MAX_MARKERS);
  const entryScratch = new Float32Array(MAX_MARKERS);
  const featureById = new Map<string, [number, number]>();

  let mapRef: maplibregl.Map | null = null;
  let program: WebGLProgram | null = null;
  let vao: WebGLVertexArrayObject | null = null;
  let vbo: WebGLBuffer | null = null;
  let u: Record<string, WebGLUniformLocation | null> = {};
  let mouseEnter: ((e: maplibregl.MapLayerMouseEvent) => void) | null = null;
  let mouseMove: ((e: maplibregl.MapLayerMouseEvent) => void) | null = null;
  let mouseLeave: (() => void) | null = null;

  function rebuildHoverHandlers(map: maplibregl.Map) {
    if (mouseEnter) {
      map.off('mouseenter', RACE_HALO_LAYER, mouseEnter as never);
      map.off('mouseenter', RACE_CORE_LAYER, mouseEnter as never);
    }
    if (mouseMove) {
      map.off('mousemove', RACE_HALO_LAYER, mouseMove as never);
      map.off('mousemove', RACE_CORE_LAYER, mouseMove as never);
    }
    if (mouseLeave) {
      map.off('mouseleave', RACE_HALO_LAYER, mouseLeave as never);
      map.off('mouseleave', RACE_CORE_LAYER, mouseLeave as never);
    }
    mouseEnter = (e) => {
      const id = e.features?.[0]?.properties?.['id'];
      if (id != null) {
        hoveredId = String(id);
        map.triggerRepaint();
      }
    };
    mouseMove = (e) => {
      const id = e.features?.[0]?.properties?.['id'];
      if (id != null) {
        const next = String(id);
        if (next !== hoveredId) {
          hoveredId = next;
          map.triggerRepaint();
        }
      }
    };
    mouseLeave = () => {
      hoveredId = null;
      map.triggerRepaint();
    };
    map.on('mouseenter', RACE_HALO_LAYER, mouseEnter);
    map.on('mouseenter', RACE_CORE_LAYER, mouseEnter);
    map.on('mousemove', RACE_HALO_LAYER, mouseMove);
    map.on('mousemove', RACE_CORE_LAYER, mouseMove);
    map.on('mouseleave', RACE_HALO_LAYER, mouseLeave);
    map.on('mouseleave', RACE_CORE_LAYER, mouseLeave);
  }

  return {
    id: 'pj-marker',
    type: 'custom',
    renderingMode: '2d',

    onAdd(map, glOrig) {
      mapRef = map;
      const gl = glOrig as WebGL2RenderingContext;
      program = linkProgram(gl, VS, FS);
      vao = gl.createVertexArray()!;
      vbo = gl.createBuffer()!;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      u = {
        resolution: gl.getUniformLocation(program, 'u_resolution'),
        time: gl.getUniformLocation(program, 'u_time'),
        count: gl.getUniformLocation(program, 'u_count'),
        hovered: gl.getUniformLocation(program, 'u_hovered'),
        marker: gl.getUniformLocation(program, 'u_marker'),
        glow: gl.getUniformLocation(program, 'u_glow'),
        entryBoost: gl.getUniformLocation(program, 'u_entryBoost'),
        globalAlpha: gl.getUniformLocation(program, 'u_globalAlpha'),
        coreColor: gl.getUniformLocation(program, 'u_coreColor'),
        haloColor: gl.getUniformLocation(program, 'u_haloColor'),
      };
      rebuildHoverHandlers(map);
    },

    render(glOrig, _args) {
      if (!program || !vao || !mapRef) return;
      const gl = glOrig as WebGL2RenderingContext;

      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const dpr = w / mapRef.getContainer().clientWidth;

      // We need the live (petal-jittered) screen positions. Read from the
      // source once per frame so we always reflect MapLibre's projection.
      const features = mapRef.querySourceFeatures('races');
      featureById.clear();
      for (const f of features) {
        const id = f.properties?.['id'];
        if (id == null) continue;
        const g = f.geometry as { type: string; coordinates: [number, number] };
        featureById.set(String(id), g.coordinates);
      }

      const positions = positionsScratch;
      const glows = glowsScratch;
      const entryBoosts = entryScratch;
      // Each active slot (i < count) is unconditionally re-assigned below;
      // shader breaks when i >= u_count so stale tail values never matter.
      let count = 0;
      let hoveredIdx = -1;

      // Entry pulse amplitude: starts at 1 the moment a tier is entered,
      // falls to 0 over ENTRY_PULSE_MS as (1 - t)^3 — a quick burst with a
      // long tail. Reads as "look here!" → "ok, settling" rather than a
      // linear fade, which would feel mechanical.
      const entryAge = entryStartedAt > 0 ? performance.now() - entryStartedAt : Infinity;
      const entryT = Math.min(1, entryAge / ENTRY_PULSE_MS);
      const entryAmp = entryT >= 1 ? 0 : (1 - entryT) ** 3;
      const pulsing = entryAmp > 0.001 && entryMembers.size > 0;

      for (const d of derived) {
        if (count >= MAX_MARKERS) break;
        if (d.year < yearMin || d.year > yearMax) continue;
        if (categories && categories.size > 0 && !categories.has(d.category)) continue;
        const coords = featureById.get(d.id);
        if (!coords) continue;
        const p = mapRef.project([coords[0], coords[1]]);
        positions[count * 4 + 0] = p.x * dpr;
        positions[count * 4 + 1] = p.y * dpr;
        positions[count * 4 + 2] = d.coreRadius * dpr;
        positions[count * 4 + 3] = d.haloRadius * dpr;
        glows[count] = d.glow;
        entryBoosts[count] = pulsing && entryMembers.has(d.id) ? entryAmp : 0;
        if (d.id === hoveredId) hoveredIdx = count;
        count++;
      }

      gl.useProgram(program);
      gl.bindVertexArray(vao);

      // Premultiplied additive — markers add light onto the (already
      // possibly fogged) framebuffer.
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.disable(gl.DEPTH_TEST);

      gl.uniform2f(u.resolution!, w, h);
      gl.uniform1f(u.time!, performance.now() / 1000);
      gl.uniform1i(u.count!, count);
      gl.uniform1i(u.hovered!, hoveredIdx);
      gl.uniform4fv(u.marker!, positions);
      gl.uniform1fv(u.glow!, glows);
      gl.uniform1fv(u.entryBoost!, entryBoosts);
      gl.uniform1f(u.globalAlpha!, globalAlpha);
      gl.uniform3f(u.coreColor!, coreColorRGB[0], coreColorRGB[1], coreColorRGB[2]);
      gl.uniform3f(u.haloColor!, haloColorRGB[0], haloColorRGB[1], haloColorRGB[2]);

      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);

      // No triggerRepaint here — the TierManager wobble loop is already
      // pumping ~30 jumpTo()/sec, which schedules MapLibre redraws and
      // re-runs every custom layer. During flyTo, MapLibre's own animation
      // loop drives redraws. This keeps the breathing animation alive
      // without redundant render scheduling.
    },

    onRemove(_map, glOrig) {
      const gl = glOrig as WebGL2RenderingContext;
      if (mapRef) {
        if (mouseEnter) {
          mapRef.off('mouseenter', RACE_HALO_LAYER, mouseEnter as never);
          mapRef.off('mouseenter', RACE_CORE_LAYER, mouseEnter as never);
        }
        if (mouseMove) {
          mapRef.off('mousemove', RACE_HALO_LAYER, mouseMove as never);
          mapRef.off('mousemove', RACE_CORE_LAYER, mouseMove as never);
        }
        if (mouseLeave) {
          mapRef.off('mouseleave', RACE_HALO_LAYER, mouseLeave as never);
          mapRef.off('mouseleave', RACE_CORE_LAYER, mouseLeave as never);
        }
      }
      if (program) gl.deleteProgram(program);
      if (vbo) gl.deleteBuffer(vbo);
      if (vao) gl.deleteVertexArray(vao);
      program = null;
      vao = null;
      vbo = null;
    },

    setRaces(rs) {
      derived = deriveMarkerData(rs);
      mapRef?.triggerRepaint();
    },
    setFilter(f) {
      yearMin = f.yearMin;
      yearMax = f.yearMax;
      categories = f.categories;
      mapRef?.triggerRepaint();
    },
    setPalette(p) {
      palette = p;
      coreColorRGB = parseHex(p.markerCore);
      haloColorRGB = parseHex(p.markerHalo);
      mapRef?.triggerRepaint();
    },
    triggerEntryPulse(ids) {
      entryMembers = new Set(ids);
      entryStartedAt = performance.now();
      // The breathing-pulse repaint cadence (~30fps via wobble) is enough
      // to animate the boost smoothly, but during a flyTo wobble pauses;
      // MapLibre's flyTo animation loop drives repaints in that window.
      // Either way the entry pulse renders without an explicit rAF here.
      mapRef?.triggerRepaint();
    },
    setGlobalAlpha(a) {
      // No triggerRepaint: this is called from a per-frame rAF tick during a
      // cinematic swap; wobble + the tick itself already drive paints.
      globalAlpha = Math.max(0, Math.min(1, a));
    },
  };
}
