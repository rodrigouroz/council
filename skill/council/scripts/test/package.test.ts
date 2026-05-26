import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptsDir, "..", "..");
const repoRoot = path.resolve(skillRoot, "..", "..");

test("package source has required skill files", () => {
  assert.equal(existsSync(path.join(skillRoot, "SKILL.md")), true);
  assert.equal(existsSync(path.join(skillRoot, "agents", "openai.yaml")), true);
  assert.equal(existsSync(path.join(skillRoot, "references", "council-workflow.md")), true);
  assert.equal(existsSync(path.join(skillRoot, "evals", "spec-review.md")), true);
  assert.equal(existsSync(path.join(skillRoot, "evals", "diff-review.md")), true);
  assert.equal(existsSync(path.join(skillRoot, "evals", "manual-fallback.md")), true);
});

test("repository documents local release and external install flow", () => {
  const scriptPath = path.join(repoRoot, "scripts", "local-release.sh");
  assert.equal(existsSync(scriptPath), true);
  assert.notEqual(statSync(scriptPath).mode & 0o111, 0);

  const script = readFileSync(scriptPath, "utf8");
  for (const expected of [
    "npm ci",
    "npm run typecheck",
    "npm test",
    "npm run check-dist",
    "npm run package",
    "--install-local",
    "git status --porcelain",
    "council-skill.zip",
  ]) {
    assert.match(script, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
  assert.match(readme, /scripts\/local-release\.sh/);
  assert.match(readme, /\$\{CODEX_HOME:-\$HOME\/\.codex\}\/skills/);
  assert.match(readme, /unzip/);
});
