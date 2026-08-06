/**
 * Best-effort FGD (entity definition) parser. Handles the common shape of
 * Quake/Half-Life FGDs: @BaseClass / @PointClass / @SolidClass with
 * properties, choices, and spawnflags. Exotic constructs are skipped rather
 * than fatal.
 */

export interface FgdChoice {
  value: string;
  label: string;
}

export interface FgdProperty {
  name: string;
  type: string;
  displayName?: string;
  defaultValue?: string;
  description?: string;
  choices?: FgdChoice[];
}

export interface FgdSpawnflag {
  bit: number;
  label: string;
  defaultOn: boolean;
}

export interface FgdClass {
  type: "PointClass" | "SolidClass" | "BaseClass";
  name: string;
  description?: string;
  base: string[];
  size?: string;
  color?: string;
  properties: FgdProperty[];
  spawnflags: FgdSpawnflag[];
}

function stripComments(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => {
      // strip // comments, but not inside quotes
      let inStr = false;
      for (let i = 0; i < l.length - 1; i++) {
        if (l[i] === '"') inStr = !inStr;
        else if (!inStr && l[i] === "/" && l[i + 1] === "/") return l.slice(0, i);
      }
      return l;
    })
    .join("\n");
}

/** Read a [ ... ] block starting at text[start] === "[", handling nesting and strings. */
function readBracketBlock(text: string, start: number): { body: string; end: number } {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '"') inStr = !inStr;
    else if (!inStr && c === "[") depth++;
    else if (!inStr && c === "]") {
      depth--;
      if (depth === 0) return { body: text.slice(start + 1, i), end: i + 1 };
    }
  }
  return { body: text.slice(start + 1), end: text.length };
}

/** Join FGD string concatenation: "a" + "b" -> ab */
function joinStrings(s: string): string {
  const matches = [...s.matchAll(/"([^"]*)"/g)];
  return matches.map((m) => m[1]).join("");
}

const HEADER_RE = /@(PointClass|SolidClass|BaseClass)\b([^=]*)=\s*([\w-]+)\s*(:\s*((?:"[^"]*"\s*\+?\s*)+))?/gi;

function parseHeaderMeta(meta: string): { base: string[]; size?: string; color?: string } {
  const base: string[] = [];
  let size: string | undefined;
  let color: string | undefined;
  const baseM = /base\(\s*([^)]*)\)/i.exec(meta);
  if (baseM) base.push(...baseM[1].split(",").map((s) => s.trim()).filter(Boolean));
  const sizeM = /size\(\s*([^)]*)\)/i.exec(meta);
  if (sizeM) size = sizeM[1].trim();
  const colorM = /color\(\s*([^)]*)\)/i.exec(meta);
  if (colorM) color = colorM[1].trim();
  return { base, size, color };
}

function splitColonParts(s: string): string[] {
  // Split on ":" not inside quotes
  const parts: string[] = [];
  let cur = "";
  let inStr = false;
  for (const c of s) {
    if (c === '"') {
      inStr = !inStr;
      cur += c;
    } else if (c === ":" && !inStr) {
      parts.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts.map((p) => p.trim());
}

function unquote(s: string): string {
  if (s.includes('"')) return joinStrings(s);
  return s;
}

function findEqOutsideQuotes(s: string): number {
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"') inStr = !inStr;
    else if (s[i] === "=" && !inStr) return i;
  }
  return -1;
}

function parseBody(body: string, cls: FgdClass): void {
  let i = 0;
  const lines: { text: string; choicesBody?: string }[] = [];
  // Linearize into statements; a statement whose "=" is followed by a
  // [ ... ] block (same line or next) carries that block as choicesBody.
  while (i < body.length) {
    let nl = body.indexOf("\n", i);
    if (nl === -1) nl = body.length;
    const line = body.slice(i, nl).trim();
    if (!line) {
      i = nl + 1;
      continue;
    }
    const eq = findEqOutsideQuotes(line);
    if (eq !== -1) {
      const afterEq = line.slice(eq + 1).trim();
      if (afterEq === "" || afterEq.startsWith("[")) {
        const start = body.indexOf("[", i + eq);
        if (start !== -1) {
          const block = readBracketBlock(body, start);
          lines.push({ text: line.slice(0, eq).trim(), choicesBody: block.body });
          i = block.end;
          continue;
        }
      }
    }
    lines.push({ text: line });
    i = nl + 1;
  }

  for (const { text, choicesBody } of lines) {
    const m = /^([\w.]+)\(\s*([\w ]+?)\s*\)\s*(.*)$/.exec(text);
    if (!m) continue;
    const [, name, type, tail] = m;

    if (type.toLowerCase() === "flags" && name.toLowerCase() === "spawnflags") {
      if (choicesBody) {
        for (const fl of choicesBody.split(/\r?\n/)) {
          const fm = /^\s*(\d+)\s*:\s*"([^"]*)"\s*(?::\s*(\d+))?/.exec(fl);
          if (fm) cls.spawnflags.push({ bit: Number(fm[1]), label: fm[2], defaultOn: fm[3] === "1" });
        }
      }
      continue;
    }

    const prop: FgdProperty = { name, type: type.trim() };
    const tailClean = tail.replace(/=\s*$/, "").trim();
    if (tailClean.startsWith(":")) {
      const parts = splitColonParts(tailClean.slice(1));
      if (parts[0]) prop.displayName = unquote(parts[0]);
      if (parts[1]) prop.defaultValue = unquote(parts[1]);
      if (parts[2]) prop.description = unquote(parts[2]);
    }
    if (choicesBody && type.toLowerCase() === "choices") {
      prop.choices = [];
      for (const cl of choicesBody.split(/\r?\n/)) {
        const cm = /^\s*("[^"]*"|[-\w.]+)\s*:\s*"([^"]*)"/.exec(cl);
        if (cm) prop.choices.push({ value: cm[1].replace(/"/g, ""), label: cm[2] });
      }
    }
    cls.properties.push(prop);
  }
}

export function parseFgd(text: string): FgdClass[] {
  const clean = stripComments(text);
  const classes: FgdClass[] = [];
  let m: RegExpExecArray | null;
  HEADER_RE.lastIndex = 0;
  while ((m = HEADER_RE.exec(clean)) !== null) {
    const type = (m[1][0].toUpperCase() + m[1].slice(1)) as FgdClass["type"];
    const meta = parseHeaderMeta(m[2]);
    const cls: FgdClass = {
      type,
      name: m[3],
      description: m[5] ? joinStrings(m[5]) : undefined,
      base: meta.base,
      size: meta.size,
      color: meta.color,
      properties: [],
      spawnflags: [],
    };
    // Body: next non-whitespace char should be "["
    const after = clean.slice(HEADER_RE.lastIndex);
    const bodyStartRel = after.search(/\S/);
    if (bodyStartRel !== -1 && after[bodyStartRel] === "[") {
      const block = readBracketBlock(clean, HEADER_RE.lastIndex + bodyStartRel);
      parseBody(block.body, cls);
      HEADER_RE.lastIndex = block.end;
    }
    classes.push(cls);
  }
  return classes;
}

/** Flatten a class with its inherited base-class properties and spawnflags. */
export function resolveClass(classes: FgdClass[], name: string): FgdClass | undefined {
  const byName = new Map(classes.map((c) => [c.name.toLowerCase(), c]));
  const target = byName.get(name.toLowerCase());
  if (!target) return undefined;

  const properties: FgdProperty[] = [];
  const spawnflags: FgdSpawnflag[] = [];
  const seen = new Set<string>();
  const visit = (cls: FgdClass, visited: Set<string>) => {
    if (visited.has(cls.name)) return;
    visited.add(cls.name);
    for (const baseName of cls.base) {
      const base = byName.get(baseName.toLowerCase());
      if (base) visit(base, visited);
    }
    for (const p of cls.properties) {
      if (!seen.has(p.name.toLowerCase())) {
        seen.add(p.name.toLowerCase());
        properties.push(p);
      }
    }
    spawnflags.push(...cls.spawnflags);
  };
  visit(target, new Set());
  return { ...target, properties, spawnflags };
}
