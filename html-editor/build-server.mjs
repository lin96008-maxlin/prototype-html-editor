import { build } from "esbuild";

await build({
  entryPoints: ["src/server/cli.ts"],
  outfile: "scripts/html-editor-session.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  sourcemap: false,
  legalComments: "inline",
});
