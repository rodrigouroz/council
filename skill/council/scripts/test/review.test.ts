import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { buildPrompt, parseReviewerOutput, readReviewDiff, runReview } from "../src/review.ts";
import { renderJson, renderMarkdown } from "../src/report.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "council-review-repo-"));
  await git(dir, ["init"]);
  await git(dir, ["config", "user.email", "council@example.test"]);
  await git(dir, ["config", "user.name", "Council Test"]);
  await writeFile(path.join(dir, "tracked.txt"), "base\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "initial"]);
  return dir;
}

test("parseReviewerOutput buckets findings", () => {
  const parsed = parseReviewerOutput(
    "codex",
    [
      "BLOCKER: missing rollback step",
      "SUGGESTION: name the risk owner",
      "QUESTION: who signs off?",
      "PASS: no other blockers",
    ].join("\n"),
  );
  assert.equal(parsed.blockingFindings[0]?.text, "missing rollback step");
  assert.equal(parsed.suggestions[0]?.text, "name the risk owner");
  assert.equal(parsed.questions[0]?.text, "who signs off?");
  assert.equal(parsed.pass, true);
});

test("parseReviewerOutput preserves continuation lines on findings", () => {
  const parsed = parseReviewerOutput(
    "claude",
    [
      "BLOCKER: missing rollback step",
      "  Evidence: rollout.md has no rollback section",
      "  File: rollout.md:12",
      "",
      "SUGGESTION: name the risk owner",
      "Additional context should stay attached.",
    ].join("\n"),
  );

  assert.equal(
    parsed.blockingFindings[0]?.text,
    "missing rollback step\n  Evidence: rollout.md has no rollback section\n  File: rollout.md:12",
  );
  assert.equal(parsed.suggestions[0]?.text, "name the risk owner\nAdditional context should stay attached.");
});

test("parseReviewerOutput resets finding continuation on blank lines", () => {
  const parsed = parseReviewerOutput(
    "codex",
    [
      "BLOCKER: missing rollback step",
      "Evidence: rollout.md has no rollback section",
      "",
      "Random paragraph outside any finding.",
      "SUGGESTION: name the risk owner",
    ].join("\n"),
  );

  assert.equal(parsed.blockingFindings[0]?.text, "missing rollback step\nEvidence: rollout.md has no rollback section");
  assert.equal(parsed.suggestions[0]?.text, "name the risk owner");
});

test("readReviewDiff only reads git diff when diff review is requested", async () => {
  assert.deepEqual(await readReviewDiff({ cwd: process.cwd(), includeDiff: false }), {
    diff: "",
    harnessNotes: [],
  });
});

test("readReviewDiff reads committed branch diff from a base ref", async () => {
  const repo = await initRepo();
  await git(repo, ["checkout", "-b", "feature"]);
  await writeFile(path.join(repo, "tracked.txt"), "changed\n");
  await git(repo, ["commit", "-am", "change tracked"]);

  const result = await readReviewDiff({ cwd: repo, includeDiff: true, baseRef: "main" });

  assert.match(result.diff, /diff --git a\/tracked.txt b\/tracked.txt/);
  assert.deepEqual(result.harnessNotes, []);
});

test("readReviewDiff includes committed and dirty changes when both exist", async () => {
  const repo = await initRepo();
  await git(repo, ["checkout", "-b", "feature"]);
  await writeFile(path.join(repo, "tracked.txt"), "committed\n");
  await git(repo, ["commit", "-am", "change tracked"]);
  await writeFile(path.join(repo, "dirty.txt"), "dirty\n");
  await git(repo, ["add", "dirty.txt"]);

  const result = await readReviewDiff({ cwd: repo, includeDiff: true, baseRef: "main" });

  assert.match(result.diff, /committed/);
  assert.match(result.diff, /dirty working-tree changes/);
  assert.match(result.diff, /dirty/);
  assert.match(result.harnessNotes.join("\n"), /includes committed changes against main and dirty working-tree changes/);
});

test("readReviewDiff reports clean branch without a diff", async () => {
  const repo = await initRepo();

  const result = await readReviewDiff({ cwd: repo, includeDiff: true });

  assert.equal(result.diff, "");
  assert.match(result.harnessNotes.join("\n"), /no diff found/);
});

test("readReviewDiff reports invalid base refs instead of returning an empty diff", async () => {
  const repo = await initRepo();

  const result = await readReviewDiff({ cwd: repo, includeDiff: true, baseRef: "missing-ref" });

  assert.equal(result.diff, "");
  assert.match(result.harnessNotes.join("\n"), /failed to read diff/);
  assert.match(result.harnessNotes.join("\n"), /missing-ref/);
});

test("buildPrompt includes review contract", () => {
  const prompt = buildPrompt({
    artifactKind: "spec",
    artifact: "artifact body",
    diff: "diff --git a/file b/file",
    cwd: "/tmp/repo",
    round: 2,
    maxRounds: 3,
    changeSummary: "addressed first blocker",
  });
  for (const expected of [
    "Artifact kind: spec",
    "Round: 2 of 3",
    "artifact body",
    "diff --git",
    "addressed first blocker",
    "BLOCKER:",
    "SUGGESTION:",
    "QUESTION:",
    "PASS:",
  ]) {
    assert.match(prompt, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("reports render markdown and json", () => {
  const report = {
    round: 1,
    maxRounds: 3,
    artifact: "SPEC.md",
    reviewers: ["codex"],
    blockingFindings: [{ reviewer: "codex", text: "missing test plan" }],
    suggestions: [{ reviewer: "codex", text: "shorten intro" }],
    questions: [{ reviewer: "codex", text: "who owns rollout?" }],
    harnessNotes: ["reviewer claude skipped"],
    reviewerResults: [],
    nextRoundRecommended: true,
  };

  const markdown = renderMarkdown(report);
  assert.match(markdown, /# Council Review/);
  assert.match(markdown, /missing test plan/);
  assert.match(markdown, /## Harness Notes/);

  const json = JSON.parse(renderJson(report));
  assert.equal(json.round, 1);
  assert.equal(json.result, "next round recommended");
  assert.equal(json.nextRoundRecommended, true);
});

test("reports with no reviewers do not render as clean passes", () => {
  const report = {
    round: 1,
    maxRounds: 3,
    artifact: "git diff",
    reviewers: [],
    blockingFindings: [],
    suggestions: [],
    questions: [],
    harnessNotes: ["no reviewer agents available"],
    reviewerResults: [],
    nextRoundRecommended: false,
  };

  const markdown = renderMarkdown(report);
  assert.match(markdown, /- reviewers: none/);
  assert.match(markdown, /- result: no reviewer agents available/);

  const json = JSON.parse(renderJson(report));
  assert.equal(json.result, "no reviewer agents available");
});

test("reports with no diff found render as incomplete", () => {
  const report = {
    round: 1,
    maxRounds: 3,
    artifact: "git diff",
    reviewers: [],
    blockingFindings: [],
    suggestions: [],
    questions: [],
    harnessNotes: ["no diff found; pass --base <ref> for committed branch review"],
    reviewerResults: [],
    nextRoundRecommended: false,
  };

  const json = JSON.parse(renderJson(report));
  assert.equal(json.result, "review incomplete");
});

test("reports with empty reviewer output do not render as clean passes", async () => {
  const repo = await initRepo();
  const artifact = path.join(repo, "artifact.md");
  await writeFile(artifact, "review me\n");
  const binDir = await mkdtemp(path.join(tmpdir(), "council-empty-reviewer-"));
  await writeFile(
    path.join(binDir, "claude"),
    [`#!${process.execPath}`, "process.stdin.resume();", "process.stdin.on('end', () => process.exit(0));"].join("\n"),
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
  try {
    const report = await runReview({
      command: "review",
      cwd: repo,
      artifactPath: artifact,
      includeDiff: false,
      author: "codex",
      maxRounds: 3,
      round: 1,
      changeSummary: "",
      format: "markdown",
    });

    assert.match(
      report.harnessNotes.join("\n"),
      /reviewer claude failed: no usable reviewer output; expected BLOCKER, SUGGESTION, QUESTION, or PASS/,
    );
    assert.equal(renderJson(report).includes('"result": "review incomplete"'), true);
  } finally {
    process.env.PATH = oldPath;
  }
});
