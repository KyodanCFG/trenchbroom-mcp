import type { Entity, MapFile, Vec3 } from "../map/model.js";
import { classname, parseOrigin } from "../map/model.js";
import { brushVertices, convexHull2D, type Vec2 } from "../map/geometry.js";

export type ViewName = "top" | "front" | "side";

interface ViewDef {
  /** Map a world point to 2D "paper" coords (y up). */
  project: (p: Vec3) => Vec2;
  hAxis: string;
  vAxis: string;
}

const VIEWS: Record<ViewName, ViewDef> = {
  top: { project: (p) => [p[0], p[1]], hAxis: "X", vAxis: "Y" },
  front: { project: (p) => [p[0], p[2]], hAxis: "X", vAxis: "Z" },
  side: { project: (p) => [p[1], p[2]], hAxis: "Y", vAxis: "Z" },
};

const WIDTH = 1200;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface RenderResult {
  svg: string;
  brushCount: number;
  pointEntityCount: number;
}

export function renderView(map: MapFile, viewName: ViewName): RenderResult {
  const view = VIEWS[viewName];

  interface BrushPoly {
    hull: Vec2[];
    owner: string; // classname of owning entity
  }
  const polys: BrushPoly[] = [];
  const points: { pos: Vec2; label: string }[] = [];
  const allPts: Vec2[] = [];

  for (const e of map.entities) {
    const cls = classname(e);
    for (const b of e.brushes) {
      const verts = brushVertices(b);
      if (verts.length < 3) continue;
      const projected = verts.map(view.project);
      const hull = convexHull2D(projected);
      if (hull.length >= 3) {
        polys.push({ hull, owner: cls });
        allPts.push(...hull);
      }
    }
    if (e.brushes.length === 0) {
      const origin = parseOrigin(e);
      if (origin) {
        const pos = view.project(origin);
        points.push({ pos, label: cls });
        allPts.push(pos);
      }
    }
  }

  if (allPts.length === 0) {
    return {
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100"><text x="10" y="50" font-family="monospace">empty map</text></svg>`,
      brushCount: 0,
      pointEntityCount: 0,
    };
  }

  const pad = 64;
  let minH = Infinity, maxH = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const [h, v] of allPts) {
    if (h < minH) minH = h;
    if (h > maxH) maxH = h;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  minH -= pad; maxH += pad; minV -= pad; maxV += pad;
  const scale = WIDTH / (maxH - minH);
  const height = Math.max(80, Math.round((maxV - minV) * scale));
  const X = (h: number) => (h - minH) * scale;
  const Y = (v: number) => height - (v - minV) * scale; // paper y-up -> svg y-down

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" font-family="monospace">`
  );
  parts.push(`<rect width="${WIDTH}" height="${height}" fill="#f8fafc"/>`);

  // 256-unit grid
  const gridStep = 256 * scale;
  if (gridStep > 12) {
    for (let h = Math.ceil(minH / 256) * 256; h <= maxH; h += 256) {
      const major = h % 1024 === 0;
      parts.push(`<line x1="${X(h)}" y1="0" x2="${X(h)}" y2="${height}" stroke="${major ? "#cbd5e1" : "#e2e8f0"}" stroke-width="1"/>`);
    }
    for (let v = Math.ceil(minV / 256) * 256; v <= maxV; v += 256) {
      const major = v % 1024 === 0;
      parts.push(`<line x1="0" y1="${Y(v)}" x2="${WIDTH}" y2="${Y(v)}" stroke="${major ? "#cbd5e1" : "#e2e8f0"}" stroke-width="1"/>`);
    }
  }

  for (const poly of polys) {
    const d = poly.hull.map(([h, v]) => `${X(h).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
    const isWorld = poly.owner === "worldspawn";
    const fill = isWorld ? "#94a3b8" : "#f59e0b";
    parts.push(
      `<polygon points="${d}" fill="${fill}" fill-opacity="${isWorld ? "0.55" : "0.6"}" stroke="#334155" stroke-width="1.2"/>`
    );
  }

  for (const pt of points) {
    const x = X(pt.pos[0]);
    const y = Y(pt.pos[1]);
    parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="#2563eb" stroke="#1e3a8a"/>`);
    parts.push(`<text x="${(x + 8).toFixed(1)}" y="${(y + 4).toFixed(1)}" font-size="11" fill="#1e293b">${esc(pt.label)}</text>`);
  }

  parts.push(
    `<text x="8" y="16" font-size="12" fill="#475569">${viewName} view (${view.hAxis} right, ${view.vAxis} up) — grid 256, 1 px = ${(1 / scale).toFixed(1)} units</text>`
  );
  parts.push(`</svg>`);

  return { svg: parts.join("\n"), brushCount: polys.length, pointEntityCount: points.length };
}
