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

/**
 * Creates a directory inside .tb-mcp next to the map. That is usually inside the user's
 * own repository, so the directory is made to ignore itself rather than turning up in
 * their next commit.
 */
export function ensureTbMcpDir(mapPath: string, ...segments: string[]): string {
  const root = path.join(path.dirname(mapPath), ".tb-mcp");
  const dir = path.join(root, ...segments);
  fs.mkdirSync(dir, { recursive: true });

  const ignore = path.join(root, ".gitignore");
  if (!fs.existsSync(ignore)) {
    fs.writeFileSync(ignore, "*\n");
  }
  return dir;
}

/** Copy the map aside before a mutation. Returns the backup path. */
export function snapshot(mapPath: string): string {
  const dir = ensureTbMcpDir(mapPath, "backups");
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

/**
 * Write atomically: temp file in the same directory, then rename over.
 *
 * On Windows the rename fails with EPERM or EBUSY while something else holds the file
 * open, which happens routinely and briefly: a virus scanner reading a file that was
 * just written, the search indexer, or the editor picking up the previous change. Those
 * locks clear on their own, so the rename is retried before giving up. The temp file is
 * cleaned up on failure so a later write does not trip over it.
 */
export function atomicWrite(filePath: string, content: string): void {
  const tmp = filePath + ".tb-mcp-tmp";
  fs.writeFileSync(tmp, content);

  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      fs.renameSync(tmp, filePath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") || Date.now() >= deadline) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // The temp file is already gone, or locked too; nothing useful to do.
        }
        throw err;
      }
      // Busy-wait briefly: these locks are held for milliseconds.
      const until = Date.now() + 25;
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
}
