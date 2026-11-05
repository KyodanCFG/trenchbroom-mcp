import * as zlib from "node:zlib";
import type { MapFile, Vec3 } from "../map/model.js";
import { solidFromBrush, polygons } from "../map/csg.js";
import { cross, dot, normalize, sub } from "../map/geometry.js";

export interface ShadedOptions {
  eye: Vec3;
  target: Vec3;
  fov?: number; // vertical degrees
  width?: number;
  height?: number;
  /** Texture name -> [r,g,b] 0..255; unknown names get a stable hue from the name. */
  colors?: Record<string, [number, number, number]>;
  /** Hide polygons whose normal faces away from the eye and brushes above this z (cutaway). */
  clipZ?: number;
}

function hue(name: string): [number, number, number] {
  let h = 2166136261;
  for (const c of name) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const hh = ((h >>> 0) % 360) / 60;
  const s = 0.35, l = 0.55;
  const k = (n: number) => (n + hh) % 6;
  const f = (n: number) => l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(4) * 255, f(2) * 255];
}

/** Flat-shaded, z-buffered software render of every brush (worldspawn + brush entities) to a PNG buffer. */
export function renderShaded(map: MapFile, o: ShadedOptions): { png: Buffer; polys: number } {
  const W = o.width ?? 960, H = o.height ?? 540;
  const fwd = normalize(sub(o.target, o.eye));
  const right = normalize(cross(fwd, [0, 0, 1]));
  const up = cross(right, fwd);
  const f = 1 / Math.tan(((o.fov ?? 60) * Math.PI) / 360);
  const light = normalize([0.4, -0.5, 0.8]);
  const color = new Uint8Array(W * H * 3);
  const depth = new Float32Array(W * H).fill(Infinity);
  for (let i = 0; i < W * H; i++) { color[i * 3] = 30; color[i * 3 + 1] = 33; color[i * 3 + 2] = 44; }
  const proj = (p: Vec3): [number, number, number] | null => {
    const d = sub(p, o.eye);
    const z = dot(d, fwd);
    if (z < 0.5) return null;
    return [W / 2 + (dot(d, right) / z) * f * (H / 2), H / 2 - (dot(d, up) / z) * f * (H / 2), z];
  };
  let count = 0;
  for (const e of map.entities) {
    for (const b of e.brushes) {
      for (const poly of polygons(solidFromBrush(b))) {
        const n = poly.plane.plane.normal;
        const c0 = poly.verts[0];
        if (dot(n, sub(o.eye, c0)) <= 0) continue; // back face
        if (o.clipZ !== undefined && poly.verts.every((v) => v[2] > o.clipZ!)) continue;
        const tex = poly.plane.src?.texture ?? "none";
        const base = o.colors?.[tex] ?? hue(tex);
        const shade = 0.35 + 0.65 * Math.max(0, dot(n, light));
        const rgb = base.map((c) => Math.min(255, c * shade)) as [number, number, number];
        const pv = poly.verts.map(proj);
        if (pv.some((p) => !p)) continue;
        count++;
        for (let i = 1; i + 1 < pv.length; i++) {
          const a = pv[0]!, bb = pv[i]!, c = pv[i + 1]!;
          const minX = Math.max(0, Math.floor(Math.min(a[0], bb[0], c[0])));
          const maxX = Math.min(W - 1, Math.ceil(Math.max(a[0], bb[0], c[0])));
          const minY = Math.max(0, Math.floor(Math.min(a[1], bb[1], c[1])));
          const maxY = Math.min(H - 1, Math.ceil(Math.max(a[1], bb[1], c[1])));
          const area = (bb[0] - a[0]) * (c[1] - a[1]) - (bb[1] - a[1]) * (c[0] - a[0]);
          if (Math.abs(area) < 1e-6) continue;
          for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
            const px = x + 0.5, py = y + 0.5;
            const w0 = ((bb[0] - px) * (c[1] - py) - (bb[1] - py) * (c[0] - px)) / area;
            const w1 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area;
            const w2 = 1 - w0 - w1;
            const eps = -0.002;
            if (w0 < eps || w1 < eps || w2 < eps) continue;
            const z = w0 * a[2] + w1 * bb[2] + w2 * c[2];
            const idx = y * W + x;
            if (z >= depth[idx]) continue;
            depth[idx] = z;
            // darken polygon borders slightly so brush edges read
            const edge = Math.min(w0, w1, w2) < 0.004 ? 0.75 : 1;
            color[idx * 3] = rgb[0] * edge; color[idx * 3 + 1] = rgb[1] * edge; color[idx * 3 + 2] = rgb[2] * edge;
          }
        }
      }
    }
  }
  return { png: encodePng(W, H, color), polys: count };
}

function crc32(buf: Buffer): number {
  let c: number, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w: number, h: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
