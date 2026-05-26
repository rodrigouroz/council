import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptsDir, "..", "..");

test("package source has required skill files", () => {
  assert.equal(existsSync(path.join(skillRoot, "SKILL.md")), true);
  assert.equal(existsSync(path.join(skillRoot, "agents", "openai.yaml")), true);
  assert.equal(existsSync(path.join(skillRoot, "references", "council-workflow.md")), true);
  assert.equal(existsSync(path.join(skillRoot, "evals", "spec-review.md")), true);
  assert.equal(existsSync(path.join(skillRoot, "evals", "diff-review.md")), true);
  assert.equal(existsSync(path.join(skillRoot, "evals", "manual-fallback.md")), true);
});
