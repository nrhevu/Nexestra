import { build } from "esbuild";

await build({
  entryPoints: ["src/server/index.ts"],
  outfile: "dist/server.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  packages: "external",
  sourcemap: true,
});
