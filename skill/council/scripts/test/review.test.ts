import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPrompt, parseReviewerOutput } from "../src/review.ts";
import { renderJson, renderMarkdown } from "../src/report.ts";

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
  assert.equal(json.nextRoundRecommended, true);
});
