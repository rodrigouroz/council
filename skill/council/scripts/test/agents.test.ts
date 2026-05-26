import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { discoverReviewers, runReviewer } from "../src/agents.ts";

async function fakeBin(name: string, source: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "council-agent-"));
  const file = path.join(dir, name);
  await writeFile(file, source, { mode: 0o755 });
  return dir;
}

test("discoverReviewers finds supported reviewers on PATH", async () => {
  const dir = await fakeBin("codex", "#!/usr/bin/env node\nprocess.exit(0)\n");
  await writeFile(path.join(dir, "claude"), "#!/usr/bin/env node\nprocess.exit(0)\n", { mode: 0o755 });
  const found = discoverReviewers({ PATH: dir });
  assert.deepEqual(
    found.reviewers.map((reviewer) => reviewer.id),
    ["codex", "claude"],
  );
  assert.deepEqual(found.warnings, []);
});

test("discoverReviewers skips codex when codex is the authoring agent", async () => {
  const dir = await fakeBin("codex", "#!/usr/bin/env node\nprocess.exit(0)\n");
  await writeFile(path.join(dir, "claude"), "#!/usr/bin/env node\nprocess.exit(0)\n", { mode: 0o755 });
  const found = discoverReviewers({ PATH: dir }, "codex");
  assert.deepEqual(
    found.reviewers.map((reviewer) => reviewer.id),
    ["claude"],
  );
  assert.deepEqual(found.warnings, ["reviewer codex skipped: matches authoring agent"]);
});

test("discoverReviewers skips claude when claude is the authoring agent", async () => {
  const dir = await fakeBin("codex", "#!/usr/bin/env node\nprocess.exit(0)\n");
  await writeFile(path.join(dir, "claude"), "#!/usr/bin/env node\nprocess.exit(0)\n", { mode: 0o755 });
  const found = discoverReviewers({ PATH: dir }, "claude");
  assert.deepEqual(
    found.reviewers.map((reviewer) => reviewer.id),
    ["codex"],
  );
  assert.deepEqual(found.warnings, ["reviewer claude skipped: matches authoring agent"]);
});

test("discoverReviewers warns for missing reviewers", () => {
  const found = discoverReviewers({ PATH: "" });
  assert.equal(found.reviewers.length, 0);
  assert.equal(found.warnings.length, 2);
});

test("runReviewer parses codex agent messages", async () => {
  const dir = await fakeBin(
    "codex",
    [
      "#!/usr/bin/env node",
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'PASS: ok' } }));",
      "});",
    ].join("\n"),
  );
  const [reviewer] = discoverReviewers({ PATH: dir }).reviewers;
  const output = await runReviewer(reviewer, { cwd: dir, prompt: "review" });
  assert.equal(output.trim(), "PASS: ok");
});

test("runReviewer parses claude assistant text", async () => {
  const dir = await fakeBin(
    "claude",
    [
      "#!/usr/bin/env node",
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'PASS: ok' }] } }));",
      "});",
    ].join("\n"),
  );
  const [reviewer] = discoverReviewers({ PATH: dir }).reviewers;
  const output = await runReviewer(reviewer, { cwd: dir, prompt: "review" });
  assert.equal(output.trim(), "PASS: ok");
});
