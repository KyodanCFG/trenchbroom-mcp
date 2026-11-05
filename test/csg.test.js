import test from "node:test";
import assert from "node:assert/strict";
import { wedgeSolid, boxSolid, prismSolid, solidVolume, subtract, bevelSolid, brushFromSolid, solidFromBrush, polygons, rotateBrush, rotationMatrix, split, planeThrough } from "../dist/map/csg.js";
import { parseMap } from "../dist/map/parser.js";
import { serializeMap } from "../dist/map/writer.js";
import { brushBounds } from "../dist/map/geometry.js";

const near = (a, b, e = 1e-3) => assert.ok(Math.abs(a - b) < e, `${a} vs ${b}`);

test("wedge is half a box, with 5 faces", () => {
  const w = wedgeSolid([0, 0, 0], [64, 32, 16], "+x", "t", true);
  near(solidVolume(w), 64 * 32 * 16 / 2);
  assert.equal(polygons(w).length, 5);
});

test("subtract box conserves volume", () => {
  const a = boxSolid([0, 0, 0], [64, 64, 64], "t", true);
  const cut = boxSolid([16, 16, -8], [48, 48, 40], "t", true);
  const pieces = subtract(a, cut);
  const total = pieces.reduce((s, p) => s + solidVolume(p), 0);
  near(total, 64 ** 3 - 32 * 32 * 40, 0.1);
});

test("octagonal prism then clip keeps valid brush and round-trips through the writer", () => {
  const poly = Array.from({ length: 8 }, (_, i) => [Math.cos(i * Math.PI / 4) * 32, Math.sin(i * Math.PI / 4) * 32]);
  const p = prismSolid(poly, 0, 64, "t", true);
  const { back } = split(p, planeThrough([0, 0, 1], [0, 0, 32]));
  near(solidVolume(back), solidVolume(p) / 2, 0.1);
  const brush = brushFromSolid(back, "cut", true);
  const map = parseMap(serializeMap({ header: ["// Game: Quake"], eol: "\n", entities: [{ properties: [{ key: "classname", value: "worldspawn" }], brushes: [brush] }] }));
  near(solidVolume(solidFromBrush(map.entities[0].brushes[0])), solidVolume(back), 0.1);
});

test("bevel removes volume and adds faces; rotation keeps volume", () => {
  const b = boxSolid([0, 0, 0], [32, 32, 32], "t", true);
  const v = bevelSolid(b, 4, "t", true);
  assert.ok(solidVolume(v) < solidVolume(b));
  assert.equal(polygons(v).length, 6 + 12);
  const brush = brushFromSolid(b, "t", true);
  const before = solidVolume(solidFromBrush(brush));
  rotateBrush(brush, rotationMatrix("z", 33), [16, 16, 16]);
  near(solidVolume(solidFromBrush(brush)), before, 0.5);
  const bb = brushBounds(brush);
  assert.ok(bb.max[0] - bb.min[0] > 32);
});

import { solidFromPoints, pipePoints, stairBoxes, archPoints, transformBrush } from "../dist/map/csg.js";

test("hull of a cube's corners is the cube; pipe is a prism; stairs fill a wedge-ish volume", () => {
  const pts = []; for (const x of [0, 8]) for (const y of [0, 8]) for (const z of [0, 8]) pts.push([x, y, z]);
  near(solidVolume(solidFromPoints(pts, "t", true)), 512, 0.1);
  const pipe = solidFromPoints(pipePoints([0, 0, 0], [0, 0, 100], 10, 8), "t", true);
  assert.equal(polygons(pipe).length, 10);
  const slanted = solidFromPoints(pipePoints([0, 0, 0], [60, 40, 30], 5, 6), "t", true);
  assert.ok(solidVolume(slanted) > 0 && polygons(slanted).length === 8);
  const steps = stairBoxes([0, 0, 0], [64, 32, 32], "+x", 4);
  assert.equal(steps.length, 4);
  near(steps[3].max[2], 32);
});

test("arch segments are valid convex solids", () => {
  const segs = archPoints([0, 0, 0], "x", 24, 40, 16, 8);
  assert.equal(segs.length, 8);
  for (const s of segs) assert.ok(solidVolume(solidFromPoints(s, "t", true)) > 10);
});

test("clone with mirror keeps outward winding (positive volume, same size)", () => {
  const b = brushFromSolid(boxSolid([0, 0, 0], [16, 8, 4], "t", true), "t", true);
  const m = transformBrush(b, 0, [0, 0, 0], [0, 0, 0], "x");
  near(solidVolume(solidFromBrush(m)), 16 * 8 * 4, 0.1);
  const bb = brushBounds(m);
  near(bb.min[0], -16);
  const r = transformBrush(b, 90, [10, 0, 0], [0, 0, 0]);
  near(solidVolume(solidFromBrush(r)), 16 * 8 * 4, 0.1);
});

import { bevelSolid as bevel2, faceExtent } from "../dist/map/csg.js";
test("per-edge bevel: vertical only adds 4 faces, top only adds 4, all adds 12", () => {
  const b = boxSolid([0, 0, 0], [32, 32, 32], "t", true);
  assert.equal(polygons(bevel2(b, 4, "t", true, "vertical")).length, 6 + 4);
  assert.equal(polygons(bevel2(b, 4, "t", true, "top")).length, 6 + 4);
  assert.equal(polygons(bevel2(b, 4, "t", true, "all")).length, 6 + 12);
});
test("faceExtent reads the u/v span of a Valve face", () => {
  const brush = brushFromSolid(boxSolid([0, 0, 0], [64, 32, 16], "t", true), "t", true);
  const top = polygons(solidFromBrush(brush)).find((p) => p.plane.plane.normal[2] > 0.9);
  const e = faceExtent(top.plane.src, top.verts);
  near(e.u[1] - e.u[0], 64); near(e.v[1] - e.v[0], 32);
});

test("union/intersect maths: flush boxes merge to a hull, overlapping L does not", () => {
  const a = boxSolid([0, 0, 0], [16, 16, 16], "t", true), b = boxSolid([16, 0, 0], [32, 16, 16], "t", true);
  const hull = solidFromPoints([...[0, 16, 32].flatMap((x) => [0, 16].flatMap((y) => [0, 16].map((z) => [x, y, z])))], "t", true);
  near(solidVolume(hull), solidVolume(a) + solidVolume(b));
  const c = boxSolid([8, 8, 0], [24, 24, 16], "t", true);
  const inter = { planes: [...a.planes, ...c.planes] };
  near(solidVolume(inter), 8 * 8 * 16);
  const rest = subtract(c, a);
  near(rest.reduce((s, p) => s + solidVolume(p), 0), solidVolume(c) - 8 * 8 * 16, 0.1);
});
