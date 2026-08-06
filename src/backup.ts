import * as fs from "node:fs";
import * as path from "node:path";

const KEEP = 20;

function backupDir(mapPath: string): string {
  return path.join(path.dirname(mapPath), ".tb-mcp", "backups");
}

export function listBackups(mapPath: string): string[] {
  const dir = backupDir(mapPath);
  if (!fs.existsSync(dir)) return [];
  const base = path.basename(mapPath, ".map");
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(base + ".") && f.endsWith(".map"))
    .sort()
    .map((f) => path.join(dir, f));
}

/** Copy the map aside before a mutation. Returns the backup path. */
export function snapshot(mapPath: string): string {
  const dir = backupDir(mapPath);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(mapPath, ".map");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(dir, `${base}.${stamp}.map`);
  fs.copyFileSync(mapPath, dest);
  const all = listBackups(mapPath);
  for (const old of all.slice(0, Math.max(0, all.length - KEEP))) {
    fs.unlinkSync(old);
  }
  return dest;
}

/** Restore the most recent backup over the map and consume it. */
export function restoreLatest(mapPath: string): string | null {
  const all = listBackups(mapPath);
  const latest = all[all.length - 1];
  if (!latest) return null;
  fs.copyFileSync(latest, mapPath);
  fs.unlinkSync(latest);
  return latest;
}

/** Write atomically: temp file in the same directory, then rename over. */
export function atomicWrite(filePath: string, content: string): void {
  const tmp = filePath + ".tb-mcp-tmp";
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}
