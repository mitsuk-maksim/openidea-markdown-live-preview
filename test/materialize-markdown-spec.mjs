import { mkdir, writeFile } from "node:fs/promises";

const commonMarkUrl = "https://spec.commonmark.org/0.31.2/spec.json";
const gfmUrl = "https://raw.githubusercontent.com/github/cmark-gfm/0.29.0.gfm.13/test/extensions.txt";

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} while downloading ${url}`);
  return response;
}

const [commonMark, gfm] = await Promise.all([
  download(commonMarkUrl).then((response) => response.json()),
  download(gfmUrl).then((response) => response.text()),
]);

// cmark-gfm separates each input from its expected HTML with a standalone dot.
const gfmExamples = [...gfm.matchAll(/^`{32} example([^\r\n]*)\n([\s\S]*?)^`{32}[ \t]*$/gm)]
  .map(([, flags, body], index) => {
    const separator = body.search(/^\.[ \t]*$/m);
    if (separator === -1) throw new Error(`Missing HTML separator in GFM example ${index + 1}`);
    return {
      example: index + 1,
      markdown: body.slice(0, separator).replaceAll("→", "\t"),
      disabled: flags.trim().split(/\s+/).includes("disabled"),
    };
  }).filter(({ disabled }) => !disabled);

for (const [name, examples] of [["commonmark", commonMark], ["gfm", gfmExamples]]) {
  if (examples.length === 0) throw new Error(`No ${name} examples found`);
  const folder = new URL(`../dist/markdown-corpus/${name}/`, import.meta.url);
  await mkdir(folder, { recursive: true });
  for (const { example, markdown } of examples) {
    await writeFile(new URL(`${String(example).padStart(3, "0")}.md`, folder), markdown);
  }
  console.log(`${name}: ${examples.length} documents`);
}
