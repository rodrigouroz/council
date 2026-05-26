import { createWriteStream } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yazl from "yazl";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.resolve(__dirname, "..");
const skillRoot = path.resolve(scriptsDir, "..");
const outputDir = path.join(skillRoot, "dist");
const outputPath = path.join(outputDir, "council-skill.zip");

await mkdir(outputDir, { recursive: true });

const zip = new yazl.ZipFile();
await addDirectory(skillRoot, "council");

await new Promise((resolve, reject) => {
  zip.outputStream.pipe(createWriteStream(outputPath)).on("close", resolve).on("error", reject);
  zip.end();
});

console.log(`Wrote ${outputPath}`);

async function addDirectory(sourceDir, zipDir) {
  for (const entry of await readdir(sourceDir)) {
    const sourcePath = path.join(sourceDir, entry);
    if (shouldExclude(sourcePath)) continue;
    const zipPath = path.posix.join(zipDir, entry);
    const info = await stat(sourcePath);
    if (info.isDirectory()) {
      await addDirectory(sourcePath, zipPath);
    } else {
      zip.addFile(sourcePath, zipPath);
    }
  }
}

function shouldExclude(sourcePath) {
  const relative = path.relative(skillRoot, sourcePath);
  const segments = relative.split(path.sep);
  if (relative === "dist") return true;
  return segments.includes("node_modules") || segments.includes("test") || segments.includes(".cache") || segments.includes(".turbo");
}
