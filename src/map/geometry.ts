import type { Brush, Entity, MapFile, Vec3 } from "./model.js";
import { parseOrigin } from "./model.js";

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function normalize(v: Vec3): Vec3 {
  const len = Math.sqrt(dot(v, v));
  if (len === 0) return [0, 0, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
}

export interface Plane {
  normal: Vec3; // outward-facing
  dist: number; // dot(normal, x) === dist on the plane
}

/**
 * Quake .map winding: for points (p1 p2 p3) the outward normal is
 * (p3 - p1) x (p2 - p1), normalized.
 */
export function planeFromPoints(p1: Vec3, p2: Vec3, p3: Vec3): Plane {
  const normal = normalize(cross(sub(p3, p1), sub(p2, p1)));
  return { normal, dist: dot(normal, p1) };
}

function solve3Planes(a: Plane, b: Plane, c: Plane): Vec3 | null {
  const det = dot(a.normal, cross(b.normal, c.normal));
  if (Math.abs(det) < 1e-8) return null;
  // Cramer's rule: x = (d_a (n_b x n_c) + d_b (n_c x n_a) + d_c (n_a x n_b)) / det
  const term = (d: number, u: Vec3, v: Vec3): Vec3 => {
    const cx = cross(u, v);
    return [cx[0] * d, cx[1] * d, cx[2] * d];
  };
  const s = add(
    add(term(a.dist, b.normal, c.normal), term(b.dist, c.normal, a.normal)),
    term(c.dist, a.normal, b.normal)
  );
  // "+ 0" folds negative zero back to 0
  return [s[0] / det + 0, s[1] / det + 0, s[2] / det + 0];
}

const EPS = 0.05;

/**
 * Enumerate the vertices of a convex brush by intersecting every triple of
 * face planes and keeping points inside all half-spaces.
 */
export function brushVertices(brush: Brush): Vec3[] {
  const planes = brush.faces.map((f) => planeFromPoints(...f.points));
  const verts: Vec3[] = [];
  for (let i = 0; i < planes.length; i++) {
    for (let j = i + 1; j < planes.length; j++) {
      for (let k = j + 1; k < planes.length; k++) {
        const p = solve3Planes(planes[i], planes[j], planes[k]);
        if (!p) continue;
        if (planes.some((pl) => dot(pl.normal, p) > pl.dist + EPS)) continue;
        if (verts.some((v) => Math.abs(v[0] - p[0]) < 0.01 && Math.abs(v[1] - p[1]) < 0.01 && Math.abs(v[2] - p[2]) < 0.01)) continue;
        verts.push(p);
      }
    }
  }
  return verts;
}

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export function boundsOfPoints(points: Vec3[]): Bounds | null {
  if (points.length === 0) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let i = 0; i < 3; i++) {
      if (p[i] < min[i]) min[i] = p[i];
      if (p[i] > max[i]) max[i] = p[i];
    }
  }
  return { min, max };
}

export function brushBounds(brush: Brush): Bounds | null {
  return boundsOfPoints(brushVertices(brush));
}

export function entityBounds(e: Entity): Bounds | null {
  if (e.brushes.length > 0) {
    const all: Vec3[] = [];
    for (const b of e.brushes) all.push(...brushVertices(b));
    return boundsOfPoints(all);
  }
  const origin = parseOrigin(e);
  if (origin) return { min: origin, max: origin };
  return null;
}

export function mapBounds(map: MapFile): Bounds | null {
  const pts: Vec3[] = [];
  for (const e of map.entities) {
    const b = entityBounds(e);
    if (b) pts.push(b.min, b.max);
  }
  return boundsOfPoints(pts);
}

export type Vec2 = [number, number];

/** Andrew's monotone chain; returns hull in counter-clockwise order. */
export function convexHull2D(points: Vec2[]): Vec2[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length <= 2) return pts;
  const cross2 = (o: Vec2, a: Vec2, b: Vec2) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross2(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross2(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}
