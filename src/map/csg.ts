import type { Brush, Face, Vec3 } from "./model.js";
import { add, cross, dot, normalize, planeFromPoints, sub, type Plane } from "./geometry.js";

/**
 * Convex-solid CSG on top of the plane representation a .map brush already is.
 * A solid is a list of half-spaces (n.x <= d) plus, per plane, the face it came
 * from, so texture state survives clipping. Everything else (wedges, prisms,
 * rotation, clip, subtract, hollow, bevel) is built from three primitives:
 * polygons-of-a-solid, clip-by-plane, and solid-from-polygons.
 */

const EPS = 1e-4;

export interface SolidPlane {
  plane: Plane;
  /** Face this plane inherits texture state from; undefined for a fresh cut. */
  src?: Face;
}

export interface Solid {
  planes: SolidPlane[];
}

export interface Polygon {
  plane: SolidPlane;
  verts: Vec3[]; // counter-clockwise seen from outside
}

export function solidFromBrush(brush: Brush): Solid {
  return { planes: brush.faces.map((f) => ({ plane: planeFromPoints(...f.points), src: f })) };
}

function quadOnPlane(pl: Plane): Vec3[] {
  const n = pl.normal;
  const helper: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = normalize(cross(n, helper));
  const v = cross(n, u);
  const c: Vec3 = [n[0] * pl.dist, n[1] * pl.dist, n[2] * pl.dist];
  const B = 65536;
  const mk = (a: number, b: number): Vec3 => [
    c[0] + u[0] * a + v[0] * b,
    c[1] + u[1] * a + v[1] * b,
    c[2] + u[2] * a + v[2] * b,
  ];
  // u x v = n, so this order is CCW seen from +n
  return [mk(-B, -B), mk(B, -B), mk(B, B), mk(-B, B)];
}

/** Sutherland-Hodgman against the half-space n.x <= d. */
function clipPolygon(verts: Vec3[], pl: Plane): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < verts.length; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    const da = dot(pl.normal, a) - pl.dist;
    const db = dot(pl.normal, b) - pl.dist;
    if (da <= EPS) out.push(a);
    if ((da < -EPS && db > EPS) || (da > EPS && db < -EPS)) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  return out;
}

function polyArea(verts: Vec3[]): number {
  let s: Vec3 = [0, 0, 0];
  for (let i = 1; i + 1 < verts.length; i++) {
    s = add(s, cross(sub(verts[i], verts[0]), sub(verts[i + 1], verts[0])));
  }
  return Math.sqrt(dot(s, s)) / 2;
}

function dedupe(verts: Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  for (const v of verts) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev[0] - v[0]) < 1e-5 && Math.abs(prev[1] - v[1]) < 1e-5 && Math.abs(prev[2] - v[2]) < 1e-5) continue;
    out.push(v);
  }
  const f = out[0];
  const l = out[out.length - 1];
  if (out.length > 1 && Math.abs(f[0] - l[0]) < 1e-5 && Math.abs(f[1] - l[1]) < 1e-5 && Math.abs(f[2] - l[2]) < 1e-5) out.pop();
  return out;
}

/** Face polygons of a solid. Planes that contribute no area are dropped. */
export function polygons(solid: Solid): Polygon[] {
  const out: Polygon[] = [];
  solid.planes.forEach((sp, i) => {
    let verts = quadOnPlane(sp.plane);
    for (let j = 0; j < solid.planes.length && verts.length >= 3; j++) {
      if (j === i) continue;
      const o = solid.planes[j].plane;
      // Duplicate (coplanar, same side) planes: keep the first only.
      const same = dot(o.normal, sp.plane.normal) > 1 - 1e-6 && Math.abs(o.dist - sp.plane.dist) < 1e-4;
      if (same) {
        if (j < i) verts = [];
        continue;
      }
      verts = clipPolygon(verts, o);
    }
    verts = dedupe(verts);
    if (verts.length >= 3 && polyArea(verts) > 1e-3) out.push({ plane: sp, verts });
  });
  return out;
}

export function solidVolume(solid: Solid): number {
  let vol = 0;
  for (const p of polygons(solid)) {
    const a = p.verts[0];
    for (let i = 1; i + 1 < p.verts.length; i++) {
      vol += dot(a, cross(p.verts[i], p.verts[i + 1])) / 6;
    }
  }
  return Math.abs(vol);
}

export function isValidSolid(solid: Solid): boolean {
  const polys = polygons(solid);
  return polys.length >= 4 && solidVolume(solid) > 1e-2;
}

export function withPlane(solid: Solid, pl: Plane, src?: Face): Solid {
  return { planes: [...solid.planes, { plane: pl, src }] };
}

export function flip(pl: Plane): Plane {
  return { normal: [-pl.normal[0], -pl.normal[1], -pl.normal[2]], dist: -pl.dist };
}

/** Plane with outward normal n through point p. */
export function planeThrough(n: Vec3, p: Vec3): Plane {
  const nn = normalize(n);
  return { normal: nn, dist: dot(nn, p) };
}

/** Split into the part with n.x <= d (back) and n.x >= d (front); either may be null. */
export function split(solid: Solid, pl: Plane): { back: Solid | null; front: Solid | null } {
  const back = withPlane(solid, pl);
  const front = withPlane(solid, flip(pl));
  return { back: isValidSolid(back) ? back : null, front: isValidSolid(front) ? front : null };
}

/** A minus B for convex solids: at most one piece per face plane of B. */
export function subtract(a: Solid, b: Solid): Solid[] {
  const pieces: Solid[] = [];
  let rest: Solid = a;
  for (const bp of b.planes) {
    const outside = withPlane(rest, flip(bp.plane), bp.src);
    if (isValidSolid(outside)) pieces.push(outside);
    rest = withPlane(rest, bp.plane);
    if (!isValidSolid(rest)) return pieces;
  }
  // `rest` is the intersection (removed). If B did not touch A at all, A survives whole.
  if (pieces.length === 0) return [a];
  return pieces;
}

export function intersects(a: Solid, b: Solid): boolean {
  return isValidSolid({ planes: [...a.planes, ...b.planes] });
}

// ---------- transforms ----------

export type Mat3 = [Vec3, Vec3, Vec3]; // rows

export function rotationMatrix(axis: "x" | "y" | "z", degrees: number): Mat3 {
  const r = (degrees * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  if (axis === "x") return [[1, 0, 0], [0, c, -s], [0, s, c]];
  if (axis === "y") return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
  return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
}

export function mulMat(m: Mat3, v: Vec3): Vec3 {
  return [dot(m[0], v), dot(m[1], v), dot(m[2], v)];
}

/** Rotate a brush about a pivot, keeping Valve texture alignment locked to the geometry. */
export function rotateBrush(brush: Brush, m: Mat3, pivot: Vec3): void {
  for (const f of brush.faces) {
    f.points = f.points.map((p) => add(mulMat(m, sub(p, pivot)), pivot)) as [Vec3, Vec3, Vec3];
    for (const [ax, scale] of [[f.uAxis, f.xScale], [f.vAxis, f.yScale]] as const) {
      if (!ax) continue;
      const a = ax.axis;
      const ra = mulMat(m, a);
      ax.offset += (dot(a, pivot) - dot(ra, pivot)) / (scale || 1);
      ax.axis = ra;
    }
    f.raw = undefined;
  }
}

// ---------- solid -> brush ----------

function defaultAxes(n: Vec3): { u: Vec3; v: Vec3 } {
  const ax = Math.abs(n[0]);
  const ay = Math.abs(n[1]);
  const az = Math.abs(n[2]);
  if (az >= ax && az >= ay) return { u: [1, 0, 0], v: [0, -1, 0] };
  if (ax >= ay) return { u: [0, 1, 0], v: [0, 0, -1] };
  return { u: [1, 0, 0], v: [0, 0, -1] };
}

/**
 * Turn a solid back into a brush. Faces keep the texture state of the face they
 * descend from (Valve axes, scale, rotation, flags); fresh cut faces get
 * `cutTexture` with face-aligned axes.
 */
export function brushFromSolid(solid: Solid, cutTexture: string, valve: boolean, snap = false): Brush {
  const faces: Face[] = [];
  for (const poly of polygons(solid)) {
    let v = poly.verts;
    if (snap) v = v.map((p) => [Math.round(p[0]), Math.round(p[1]), Math.round(p[2])] as Vec3);
    // Pick the three most spread-out vertices so the plane stays well conditioned.
    const [a, b, c] = pickTriple(v);
    // (a, b, c) is CCW from outside; Quake wants (p3-p1)x(p2-p1) outward, so swap b and c.
    const points: [Vec3, Vec3, Vec3] = [a, c, b];
    const src = poly.plane.src;
    const n = poly.plane.plane.normal;
    if (src) {
      const face: Face = {
        ...src,
        points,
        uAxis: src.uAxis ? { ...src.uAxis, axis: [...src.uAxis.axis] as Vec3 } : undefined,
        vAxis: src.vAxis ? { ...src.vAxis, axis: [...src.vAxis.axis] as Vec3 } : undefined,
        raw: undefined,
      };
      faces.push(face);
    } else {
      const { u, v: vv } = defaultAxes(n);
      const base = { points, texture: cutTexture, rotation: 0, xScale: 1, yScale: 1 };
      faces.push(valve
        ? { ...base, uAxis: { axis: u, offset: 0 }, vAxis: { axis: vv, offset: 0 } }
        : { ...base, xOffset: 0, yOffset: 0 });
    }
  }
  return { faces };
}

function pickTriple(v: Vec3[]): [Vec3, Vec3, Vec3] {
  if (v.length === 3) return [v[0], v[1], v[2]];
  let best = -1;
  let tri: [Vec3, Vec3, Vec3] = [v[0], v[1], v[2]];
  // Bounded search: first vertex fixed at each index, other two maximise area.
  for (let i = 0; i < v.length; i++) {
    const j = (i + Math.floor(v.length / 3)) % v.length;
    const k = (i + Math.floor((2 * v.length) / 3)) % v.length;
    const area = polyArea([v[i], v[j], v[k]]);
    if (area > best && i !== j && j !== k && i !== k) {
      best = area;
      const idx = [i, j, k].sort((p, q) => p - q);
      tri = [v[idx[0]], v[idx[1]], v[idx[2]]]; // keeps polygon (CCW) order
    }
  }
  return tri;
}

// ---------- primitives ----------

function faceAt(n: Vec3, p: Vec3, texture: string, valve: boolean): Face {
  // placeholder point triple; brushFromSolid regenerates the real points
  const { u, v } = defaultAxes(n);
  const base = { points: [p, p, p] as [Vec3, Vec3, Vec3], texture, rotation: 0, xScale: 1, yScale: 1 };
  return valve
    ? { ...base, uAxis: { axis: u, offset: 0 }, vAxis: { axis: v, offset: 0 } }
    : { ...base, xOffset: 0, yOffset: 0 };
}

/** Solid from outward normals and a point on each plane. */
export function solidFromHalfSpaces(specs: { n: Vec3; p: Vec3 }[], texture: string, valve: boolean): Solid {
  return {
    planes: specs.map(({ n, p }) => ({ plane: planeThrough(n, p), src: faceAt(normalize(n), p, texture, valve) })),
  };
}

export type SlopeDir = "+x" | "-x" | "+y" | "-y";

/** Ramp: a box whose top slopes up toward `high` (the tall side keeps full height). */
export function wedgeSolid(min: Vec3, max: Vec3, high: SlopeDir, texture: string, valve: boolean): Solid {
  const [nx, ny, nz] = min;
  const [px, py, pz] = max;
  const specs = [
    { n: [0, 0, -1] as Vec3, p: [nx, ny, nz] as Vec3 },
    { n: [1, 0, 0] as Vec3, p: [px, py, pz] as Vec3 },
    { n: [-1, 0, 0] as Vec3, p: [nx, ny, nz] as Vec3 },
    { n: [0, 1, 0] as Vec3, p: [px, py, pz] as Vec3 },
    { n: [0, -1, 0] as Vec3, p: [nx, ny, nz] as Vec3 },
  ];
  // slope plane through the low top edge (at nz) and the high top edge (at pz)
  const run = high[1] === "x" ? px - nx : py - ny;
  const rise = pz - nz;
  const sign = high[0] === "+" ? 1 : -1;
  const n: Vec3 = high[1] === "x" ? [-sign * rise, 0, run] : [0, -sign * rise, run];
  const lowEdge: Vec3 = high[1] === "x"
    ? [sign > 0 ? nx : px, ny, nz]
    : [nx, sign > 0 ? ny : py, nz];
  specs.push({ n, p: lowEdge });
  // the face opposite the tall side stays vertical only on the tall side; drop the low side wall
  // (its polygon collapses to zero area and polygons() discards it)
  return solidFromHalfSpaces(specs, texture, valve);
}

/** Convex prism from a 2D polygon (any order; the hull is used) between two z levels. */
export function prismSolid(poly: [number, number][], zMin: number, zMax: number, texture: string, valve: boolean): Solid {
  const hull = convexHullCCW(poly);
  const specs: { n: Vec3; p: Vec3 }[] = [
    { n: [0, 0, 1], p: [0, 0, zMax] },
    { n: [0, 0, -1], p: [0, 0, zMin] },
  ];
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const edge: [number, number] = [b[0] - a[0], b[1] - a[1]];
    specs.push({ n: [edge[1], -edge[0], 0], p: [a[0], a[1], zMin] }); // outward for CCW
  }
  return solidFromHalfSpaces(specs, texture, valve);
}

function convexHullCCW(points: [number, number][]): [number, number][] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: [number, number][] = [];
  for (const p of pts) {
    while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop();
    lo.push(p);
  }
  const up: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop();
    up.push(p);
  }
  lo.pop();
  up.pop();
  return lo.concat(up);
}

export function boxSolid(min: Vec3, max: Vec3, texture: string, valve: boolean): Solid {
  return solidFromHalfSpaces(
    [
      { n: [1, 0, 0], p: max }, { n: [-1, 0, 0], p: min },
      { n: [0, 1, 0], p: max }, { n: [0, -1, 0], p: min },
      { n: [0, 0, 1], p: max }, { n: [0, 0, -1], p: min },
    ],
    texture,
    valve
  );
}

/**
 * Chamfer every edge by `size`. Each pair of adjacent faces gets one cutting
 * plane through the two points `size` away from the shared edge, one on each face.
 */
export type BevelEdges = "all" | "vertical" | "horizontal" | "top" | "bottom";

export function bevelSolid(solid: Solid, size: number, texture: string, valve: boolean, which: BevelEdges = "all"): Solid {
  const polys = polygons(solid);
  const cuts: SolidPlane[] = [];
  const key = (v: Vec3) => v.map((x) => Math.round(x * 100)).join(",");
  const edges = new Map<string, { a: Vec3; b: Vec3; polys: number[] }>();
  polys.forEach((p, pi) => {
    for (let i = 0; i < p.verts.length; i++) {
      const a = p.verts[i];
      const b = p.verts[(i + 1) % p.verts.length];
      const k = key(a) < key(b) ? key(a) + "|" + key(b) : key(b) + "|" + key(a);
      const e = edges.get(k);
      if (e) e.polys.push(pi);
      else edges.set(k, { a, b, polys: [pi] });
    }
  });
  for (const e of edges.values()) {
    if (e.polys.length !== 2) continue;
    if (which !== "all") {
      const d = normalize(sub(e.b, e.a));
      const vertical = Math.abs(d[2]) > 0.9;
      const zs = polys.flatMap((p) => p.verts.map((v) => v[2]));
      const zTop = Math.max(...zs), zBot = Math.min(...zs);
      const onTop = !vertical && Math.abs(e.a[2] - zTop) < 1e-3 && Math.abs(e.b[2] - zTop) < 1e-3;
      const onBottom = !vertical && Math.abs(e.a[2] - zBot) < 1e-3 && Math.abs(e.b[2] - zBot) < 1e-3;
      if (which === "vertical" && !vertical) continue;
      if (which === "horizontal" && vertical) continue;
      if (which === "top" && !onTop) continue;
      if (which === "bottom" && !onBottom) continue;
    }
    const n1 = polys[e.polys[0]].plane.plane.normal;
    const n2 = polys[e.polys[1]].plane.plane.normal;
    const s = Math.sqrt(Math.max(0, 1 - dot(n1, n2) ** 2));
    if (s < 1e-3) continue; // coplanar neighbours
    // step along each face away from the edge, perpendicular to it
    const inFace = (n: Vec3, other: Vec3): Vec3 => normalize(sub(other, [n[0] * dot(other, n), n[1] * dot(other, n), n[2] * dot(other, n)]));
    const t1 = inFace(n1, [-n2[0], -n2[1], -n2[2]]);
    const t2 = inFace(n2, [-n1[0], -n1[1], -n1[2]]);
    const q1 = add(e.a, [t1[0] * size, t1[1] * size, t1[2] * size]);
    const q2 = add(e.a, [t2[0] * size, t2[1] * size, t2[2] * size]);
    const m = normalize(add(n1, n2));
    if (dot(m, m) === 0) continue;
    const pl = planeThrough(m, [(q1[0] + q2[0]) / 2, (q1[1] + q2[1]) / 2, (q1[2] + q2[2]) / 2]);
    cuts.push({ plane: pl, src: faceAt(m, q1, texture, valve) });
  }
  return { planes: [...solid.planes, ...cuts] };
}

export function inset(min: Vec3, max: Vec3, wall: number): { min: Vec3; max: Vec3 } {
  return {
    min: [min[0] + wall, min[1] + wall, min[2] + wall],
    max: [max[0] - wall, max[1] - wall, max[2] - wall],
  };
}

// ---------- hulls and compound shapes ----------

/** Convex hull of a point cloud as a solid (brute-force face planes; fine for <= ~64 points). */
export function solidFromPoints(points: Vec3[], texture: string, valve: boolean): Solid {
  const planes: Plane[] = [];
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++)
      for (let k = j + 1; k < points.length; k++) {
        const nrm = normalize(cross(sub(points[j], points[i]), sub(points[k], points[i])));
        if (nrm[0] === 0 && nrm[1] === 0 && nrm[2] === 0) continue;
        const d = dot(nrm, points[i]);
        let pos = 0;
        let neg = 0;
        for (const p of points) {
          const e = dot(nrm, p) - d;
          if (e > 1e-4) pos++;
          else if (e < -1e-4) neg++;
          if (pos && neg) break;
        }
        if (pos && neg) continue;
        const pl: Plane = pos ? { normal: [-nrm[0], -nrm[1], -nrm[2]], dist: -d } : { normal: nrm, dist: d };
        if (!planes.some((q) => dot(q.normal, pl.normal) > 0.99999 && Math.abs(q.dist - pl.dist) < 1e-4)) planes.push(pl);
      }
  return { planes: planes.map((pl) => ({ plane: pl, src: faceAt(pl.normal, [0, 0, 0], texture, valve) })) };
}

/** Circular-ish pipe between two points: hull of two n-gon rings perpendicular to the axis. */
export function pipePoints(a: Vec3, b: Vec3, radius: number, sides: number): Vec3[] {
  const axis = normalize(sub(b, a));
  const helper: Vec3 = Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = normalize(cross(axis, helper));
  const v = cross(axis, u);
  const pts: Vec3[] = [];
  for (const c of [a, b]) {
    for (let i = 0; i < sides; i++) {
      const t = ((i + 0.5) / sides) * Math.PI * 2;
      pts.push([
        c[0] + (u[0] * Math.cos(t) + v[0] * Math.sin(t)) * radius,
        c[1] + (u[1] * Math.cos(t) + v[1] * Math.sin(t)) * radius,
        c[2] + (u[2] * Math.cos(t) + v[2] * Math.sin(t)) * radius,
      ]);
    }
  }
  return pts;
}

/**
 * Stairs rising toward `dir` across the box footprint: `steps` full-width risers.
 * Each step is a box from the floor to its own tread height, so every tread is solid.
 */
export function stairBoxes(min: Vec3, max: Vec3, dir: SlopeDir, steps: number): { min: Vec3; max: Vec3 }[] {
  const out: { min: Vec3; max: Vec3 }[] = [];
  const alongX = dir[1] === "x";
  const sign = dir[0] === "+" ? 1 : -1;
  const run = alongX ? max[0] - min[0] : max[1] - min[1];
  const rise = max[2] - min[2];
  for (let i = 0; i < steps; i++) {
    const t0 = (i / steps) * run;
    const t1 = ((i + 1) / steps) * run;
    const top = min[2] + ((i + 1) / steps) * rise;
    const lo: Vec3 = [...min] as Vec3;
    const hi: Vec3 = [...max] as Vec3;
    hi[2] = top;
    if (alongX) {
      if (sign > 0) { lo[0] = min[0] + t0; hi[0] = min[0] + t1; }
      else { lo[0] = max[0] - t1; hi[0] = max[0] - t0; }
    } else if (sign > 0) { lo[1] = min[1] + t0; hi[1] = min[1] + t1; }
    else { lo[1] = max[1] - t1; hi[1] = max[1] - t0; }
    // solid under each tread: extend this step back to the start so no tread floats
    if (alongX) { if (sign > 0) lo[0] = min[0]; else hi[0] = max[0]; }
    else if (sign > 0) lo[1] = min[1];
    else hi[1] = max[1];
    out.push({ min: lo, max: hi });
  }
  return out;
}

/**
 * Arch opening: voussoir blocks around a half ring, as hulls. Spans the x axis (or y) at `base`,
 * `inner` radius is the opening, `outer` the arch thickness, depth is the wall thickness.
 */
export function archPoints(center: Vec3, axis: "x" | "y", inner: number, outer: number, depth: number, segments: number): Vec3[][] {
  const out: Vec3[][] = [];
  for (let i = 0; i < segments; i++) {
    const a0 = Math.PI * (i / segments);
    const a1 = Math.PI * ((i + 1) / segments);
    const pts: Vec3[] = [];
    for (const a of [a0, a1]) {
      for (const r of [inner, outer]) {
        for (const d of [-depth / 2, depth / 2]) {
          const across = Math.cos(a) * r;
          const up = Math.sin(a) * r;
          pts.push(axis === "x"
            ? [center[0] + across, center[1] + d, center[2] + up]
            : [center[0] + d, center[1] + across, center[2] + up]);
        }
      }
    }
    out.push(pts);
  }
  return out;
}

/** Affine copy of a brush: rotate about z through `pivot`, then translate. Valve texture lock is kept. */
export function transformBrush(brush: Brush, rotZ: number, offset: Vec3, pivot: Vec3, mirror?: "x" | "y"): Brush {
  const copy: Brush = JSON.parse(JSON.stringify(brush));
  if (mirror) {
    const k = mirror === "x" ? 0 : 1;
    for (const f of copy.faces) {
      f.points = f.points.map((p) => { const q: Vec3 = [...p] as Vec3; q[k] = 2 * pivot[k] - q[k]; return q; }) as [Vec3, Vec3, Vec3];
      // reflection flips winding; swap two points to keep the outward normal
      f.points = [f.points[0], f.points[2], f.points[1]];
      for (const ax of [f.uAxis, f.vAxis]) if (ax) { ax.axis[k] = -ax.axis[k]; ax.offset += 0; }
      f.raw = undefined;
    }
  }
  if (rotZ) rotateBrush(copy, rotationMatrix("z", rotZ), pivot);
  for (const f of copy.faces) {
    f.points = f.points.map((p) => add(p, offset)) as [Vec3, Vec3, Vec3];
    for (const ax of [f.uAxis, f.vAxis]) if (ax) ax.offset -= dot(ax.axis, offset) / 1;
    f.raw = undefined;
  }
  return copy;
}

/** Face extent along the Valve u and v axes, for fit-to-face scaling. */
export function faceExtent(face: Face, verts: Vec3[]): { u: [number, number]; v: [number, number] } | null {
  if (!face.uAxis || !face.vAxis) return null;
  const us = verts.map((p) => dot(face.uAxis!.axis, p));
  const vs = verts.map((p) => dot(face.vAxis!.axis, p));
  return { u: [Math.min(...us), Math.max(...us)], v: [Math.min(...vs), Math.max(...vs)] };
}
