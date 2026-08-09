// Bundles the server into a single .mjs file that runs with no node_modules,
// so it can be dropped onto another machine or attached to a release.
import { build } from "esbuild";
import { chmod, readFile } from "node:fs/promises";

const outfile = "dist/trenchbroom-mcp.mjs";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile,
  // src/index.ts already carries a shebang and esbuild preserves it, so the
  // banner must not add another -- a second one lands on line 2 and is a
  // syntax error rather than a comment.
  banner: {
    js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
  },
});

// esbuild does not set the executable bit, which matters on Unix.
await chmod(outfile, 0o755);

const text = await readFile(outfile, "utf8");
const lines = text.split("\n");
if (!lines[0].startsWith("#!")) {
  throw new Error(`expected a shebang on line 1, found: ${lines[0].slice(0, 60)}`);
}
if (lines.slice(1).some((l) => l.startsWith("#!"))) {
  throw new Error("a second shebang appears below line 1; it would be a syntax error");
}
console.log(`${outfile}  ${(text.length / 1024).toFixed(0)} kb`);
