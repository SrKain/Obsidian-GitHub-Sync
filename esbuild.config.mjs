import esbuild from "esbuild";
import process from "process";
import { mobileSafeBuildOptions } from "./esbuild.shared.mjs";

const prod = (process.argv[2] === "production");
const context = await esbuild.context({
  ...mobileSafeBuildOptions,
  entryPoints: ["main.ts"],
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  outfile: "main.js",
});

if (prod) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
