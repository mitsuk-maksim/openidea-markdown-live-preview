import { build } from "esbuild";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = fileURLToPath(new URL(".", import.meta.url));
const manifest = await readFile(`${root}plugin.toml`, "utf8");
const version = manifest.match(/^version = "([^"]+)"$/m)?.[1];
if (!version) throw new Error("Missing plugin version in plugin.toml");
const folder = "dist/plugin";
const cargo = process.env.CARGO || "cargo";
const rustArgs = ["--locked", "--manifest-path", "native/Cargo.toml"];
await rm(`${root}${folder}`, { recursive: true, force: true });
await mkdir(`${root}${folder}/web`, { recursive: true });
await mkdir(`${root}${folder}/native`, { recursive: true });
const target = `${root}dist/native-target`;
execFileSync(cargo, [
  "build", ...rustArgs, "--release", "--target", "wasm32-wasip2",
  "--target-dir", target,
], { cwd: root, stdio: "inherit" });
const output = await build({
  absWorkingDir: root,
  entryPoints: ["src/editor.js", "src/editor.css"],
  bundle: true,
  format: "iife",
  outdir: `${folder}/web`,
  assetNames: "fonts/[name]",
  loader: { ".woff2": "file" },
  metafile: true,
  target: "safari16",
  legalComments: "eof",
});

async function dependencyNotices(dir, label, licenseFile) {
  const files = new Set((await readdir(dir))
    .filter((name) => /^(?:licen[cs]e|copying|notice)(?:[._-]|$)/i.test(name) && !name.endsWith(".spdx.json")));
  if (licenseFile) files.add(licenseFile);
  if (!files.size) throw new Error(`Missing license text for ${label}`);
  return Promise.all([...files].sort().map(async (file) =>
    `--- ${label} · ${file} ---\n${(await readFile(join(dir, file), "utf8")).trimEnd()}\n`));
}

const npmDirs = new Set(Object.keys(output.metafile.inputs)
  .map((file) => file.match(/^(node_modules\/(?:@[^/]+\/)?[^/]+)/)?.[1]).filter(Boolean));
const npmNotices = await Promise.all([...npmDirs].sort().map(async (dir) => {
  const path = join(root, dir);
  const { name, version } = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
  return dependencyNotices(path, `${name} ${version}`);
}));

const rust = JSON.parse(execFileSync(cargo, [
  "metadata", ...rustArgs, "--format-version", "1", "--filter-platform", "wasm32-wasip2",
], { cwd: root, encoding: "utf8" }));
const packages = new Map(rust.packages.map((pkg) => [pkg.id, pkg]));
const graph = new Map(rust.resolve.nodes.map((node) => [node.id, node.deps]));
const runtime = new Set();
function visitRuntime(id) {
  if (runtime.has(id) || packages.get(id).targets.some(({ kind }) => kind.includes("proc-macro"))) return;
  runtime.add(id);
  for (const dep of graph.get(id)) {
    if (dep.dep_kinds.some(({ kind }) => kind === null)) visitRuntime(dep.pkg);
  }
}
visitRuntime(rust.resolve.root);
const rustNotices = await Promise.all([...runtime].sort().map((id) => {
  const pkg = packages.get(id);
  // The plugin and the OpenIDEA SDK are covered by LICENSE and the upstream attribution.
  if (id === rust.resolve.root || pkg.name === "openidea-plugin") return [];
  return dependencyNotices(dirname(pkg.manifest_path), `${pkg.name} ${pkg.version}`, pkg.license_file);
}));
const attribution = await readFile(`${root}src/upstream/NOTICE`, "utf8");

await Promise.all([
  copyFile(`${root}plugin.toml`, `${root}${folder}/plugin.toml`),
  copyFile(`${target}/wasm32-wasip2/release/openidea_markdown_navigation.wasm`, `${root}${folder}/native/link.wasm`),
  copyFile(`${root}LICENSE`, `${root}${folder}/LICENSE`),
  writeFile(`${root}${folder}/NOTICE`, [attribution, ...npmNotices.flat(), ...rustNotices.flat()].join("\n")),
  copyFile(`${root}src/index.html`, `${root}${folder}/web/index.html`),
]);
await rm(`${root}dist/markdown-live-preview-${version}.oiplugin`, { force: true });
execFileSync("zip", ["-X", "-q", `../markdown-live-preview-${version}.oiplugin`, "plugin.toml", "LICENSE", "NOTICE", "native/link.wasm",
  "web/index.html",
  ...Object.keys(output.metafile.outputs).map((file) => relative(folder, file)),
], { cwd: `${root}${folder}` });
