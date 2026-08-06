import type { Face, MapFile, Vec3 } from "./model.js";

export function fmt(n: number): string {
  if (Object.is(n, -0)) n = 0;
  if (Number.isInteger(n)) return String(n);
  return n
    .toFixed(6)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
}

function fmtVec(v: Vec3): string {
  return `${fmt(v[0])} ${fmt(v[1])} ${fmt(v[2])}`;
}

export function formatFace(f: Face): string {
  const pts = f.points.map((p) => `( ${fmtVec(p)} )`).join(" ");
  const tail = f.extra ? ` ${f.extra}` : "";
  if (f.uAxis && f.vAxis) {
    const u = `[ ${fmtVec(f.uAxis.axis)} ${fmt(f.uAxis.offset)} ]`;
    const v = `[ ${fmtVec(f.vAxis.axis)} ${fmt(f.vAxis.offset)} ]`;
    return `${pts} ${f.texture} ${u} ${v} ${fmt(f.rotation)} ${fmt(f.xScale)} ${fmt(f.yScale)}${tail}`;
  }
  return `${pts} ${f.texture} ${fmt(f.xOffset ?? 0)} ${fmt(f.yOffset ?? 0)} ${fmt(f.rotation)} ${fmt(f.xScale)} ${fmt(f.yScale)}${tail}`;
}

/**
 * Serialize in TrenchBroom's own output style ("// entity N" / "// brush N"
 * comments, one property or face per line). Unmodified properties and faces
 * are emitted from their original source lines, so parse -> serialize is a
 * fixpoint and diffs only touch what actually changed.
 */
export function serializeMap(map: MapFile): string {
  const lines: string[] = [];
  map.entities.forEach((e, ei) => {
    lines.push(`// entity ${ei}`, "{");
    for (const p of e.properties) {
      lines.push(p.raw ?? `"${p.key}" "${p.value}"`);
    }
    e.brushes.forEach((b, bi) => {
      lines.push(`// brush ${bi}`, "{");
      for (const f of b.faces) {
        lines.push(f.raw ?? formatFace(f));
      }
      lines.push("}");
    });
    lines.push("}");
  });
  return lines.join(map.eol) + map.eol;
}
