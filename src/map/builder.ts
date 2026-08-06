import type { Brush, Entity, Face, MapFile, Vec3 } from "./model.js";
import { getProp } from "./model.js";

/**
 * Whether the map uses Valve 220 texture axes. Detected from worldspawn's
 * "mapversion" or from any existing face; defaults to Valve (TrenchBroom's
 * default for new Quake maps).
 */
export function usesValveFormat(map: MapFile): boolean {
  const world = map.entities[0];
  if (world && getProp(world, "mapversion") === "220") return true;
  for (const e of map.entities) {
    for (const b of e.brushes) {
      for (const f of b.faces) return f.uAxis !== undefined;
    }
  }
  return true;
}

interface BoxFaceSpec {
  p1: Vec3;
  e1: Vec3; // p2 = p1 + e1
  e2: Vec3; // p3 = p1 + e2
  u: Vec3;
  v: Vec3;
}

/**
 * Axis-aligned box brush. Plane points are a corner plus unit steps chosen so
 * (p3 - p1) x (p2 - p1) faces outward; texture axes use face-aligned
 * projection.
 */
export function makeBoxBrush(min: Vec3, max: Vec3, texture: string, valve: boolean): Brush {
  const [nx, ny, nz] = min;
  const [px, py, pz] = max;
  const specs: BoxFaceSpec[] = [
    // +Z (top)
    { p1: [nx, ny, pz], e1: [0, 1, 0], e2: [1, 0, 0], u: [1, 0, 0], v: [0, -1, 0] },
    // -Z (bottom)
    { p1: [nx, ny, nz], e1: [1, 0, 0], e2: [0, 1, 0], u: [1, 0, 0], v: [0, -1, 0] },
    // +X
    { p1: [px, ny, nz], e1: [0, 0, 1], e2: [0, 1, 0], u: [0, 1, 0], v: [0, 0, -1] },
    // -X
    { p1: [nx, ny, nz], e1: [0, 1, 0], e2: [0, 0, 1], u: [0, 1, 0], v: [0, 0, -1] },
    // +Y
    { p1: [nx, py, nz], e1: [1, 0, 0], e2: [0, 0, 1], u: [1, 0, 0], v: [0, 0, -1] },
    // -Y
    { p1: [nx, ny, nz], e1: [0, 0, 1], e2: [1, 0, 0], u: [1, 0, 0], v: [0, 0, -1] },
  ];
  const faces: Face[] = specs.map((s) => {
    const p2: Vec3 = [s.p1[0] + s.e1[0], s.p1[1] + s.e1[1], s.p1[2] + s.e1[2]];
    const p3: Vec3 = [s.p1[0] + s.e2[0], s.p1[1] + s.e2[1], s.p1[2] + s.e2[2]];
    const base = {
      points: [s.p1, p2, p3] as [Vec3, Vec3, Vec3],
      texture,
      rotation: 0,
      xScale: 1,
      yScale: 1,
    };
    if (valve) {
      return { ...base, uAxis: { axis: s.u, offset: 0 }, vAxis: { axis: s.v, offset: 0 } };
    }
    return { ...base, xOffset: 0, yOffset: 0 };
  });
  return { faces };
}

export function translateEntity(e: Entity, delta: Vec3): void {
  for (const b of e.brushes) {
    for (const f of b.faces) {
      f.points = f.points.map(
        (p) => [p[0] + delta[0], p[1] + delta[1], p[2] + delta[2]] as Vec3
      ) as [Vec3, Vec3, Vec3];
      // Keep textures locked to the geometry in Valve format
      if (f.uAxis) f.uAxis.offset -= dotv(f.uAxis.axis, delta) / f.xScale;
      if (f.vAxis) f.vAxis.offset -= dotv(f.vAxis.axis, delta) / f.yScale;
      f.raw = undefined;
    }
  }
  const originProp = e.properties.find((p) => p.key === "origin");
  if (originProp) {
    const parts = originProp.value.trim().split(/\s+/).map(Number);
    if (parts.length === 3 && !parts.some(Number.isNaN)) {
      originProp.value = `${parts[0] + delta[0]} ${parts[1] + delta[1]} ${parts[2] + delta[2]}`;
      originProp.raw = undefined;
    }
  }
}

function dotv(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
