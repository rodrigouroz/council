import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

test("package source has required skill files", () => {
  assert.equal(existsSync("../SKILL.md"), true);
  assert.equal(existsSync("../agents/openai.yaml"), true);
  assert.equal(existsSync("../references/council-workflow.md"), true);
  assert.equal(existsSync("../evals/spec-review.md"), true);
  assert.equal(existsSync("../evals/diff-review.md"), true);
  assert.equal(existsSync("../evals/manual-fallback.md"), true);
});
