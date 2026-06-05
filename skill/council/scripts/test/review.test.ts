import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { buildPrompt, parseReviewerOutput, readReviewDiff, runReview, sandboxHarnessNotes } from "../src/review.ts";
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
  await git(dir, ["config", "commit.gpgsign", "false"]);
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

test("parseReviewerOutput accepts markdown-wrapped finding prefixes", () => {
  const parsed = parseReviewerOutput(
    "claude",
    [
      '**BLOCKER: branch mode can render a false pass.**',
      "**BLOCKER:** parse bolded label with colon.",
      "**BLOCKER**: parse bolded label before colon.",
      "- **SUGGESTION: add a regression test.**",
      "* SUGGESTION: parse star bullets too.",
      "1. **SUGGESTION: parse numbered bold findings.**",
      "**QUESTION: should tests run on no-diff paths?**",
    ].join("\n"),
  );

  assert.equal(parsed.blockingFindings[0]?.text, "branch mode can render a false pass.");
  assert.equal(parsed.blockingFindings[1]?.text, "parse bolded label with colon.");
  assert.equal(parsed.blockingFindings[2]?.text, "parse bolded label before colon.");
  assert.equal(parsed.suggestions[0]?.text, "add a regression test.");
  assert.equal(parsed.suggestions[1]?.text, "parse star bullets too.");
  assert.equal(parsed.suggestions[2]?.text, "parse numbered bold findings.");
  assert.equal(parsed.questions[0]?.text, "should tests run on no-diff paths?");
});

test("parseReviewerOutput does not treat numbered explanatory lines as findings", () => {
  const parsed = parseReviewerOutput("claude", "1. BLOCKER: means a release-stopping issue.");
  assert.equal(parsed.blockingFindings.length, 0);
});

test("parseReviewerOutput preserves inline emphasis inside finding text", () => {
  const parsed = parseReviewerOutput("claude", "BLOCKER: preserve final **important**");
  assert.equal(parsed.blockingFindings[0]?.text, "preserve final **important**");
});

test("readReviewDiff only reads git diff when diff review is requested", async () => {
  assert.deepEqual(await readReviewDiff({ cwd: process.cwd(), includeDiff: false }), {
    diff: "",
    harnessNotes: [],
  });
});

test("sandboxHarnessNotes warns when Codex sandboxing may block reviewer auth", () => {
  assert.deepEqual(sandboxHarnessNotes({ CODEX_SANDBOX: "seatbelt", CODEX_SANDBOX_NETWORK_DISABLED: "1" }), [
    "running inside CODEX_SANDBOX=seatbelt with network disabled; reviewer CLIs run as local child processes and need their normal auth/home state and network access.",
  ]);
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

test("readReviewDiff local mode reads only dirty changes", async () => {
  const repo = await initRepo();
  await git(repo, ["checkout", "-b", "feature"]);
  await writeFile(path.join(repo, "branch-only.txt"), "committed branch file\n");
  await git(repo, ["add", "branch-only.txt"]);
  await git(repo, ["commit", "-m", "add branch-only file"]);
  await writeFile(path.join(repo, "tracked.txt"), "dirty\n");

  const result = await readReviewDiff({ cwd: repo, includeDiff: true, diffMode: "local" });

  assert.doesNotMatch(result.diff, /branch-only/);
  assert.match(result.diff, /dirty/);
  assert.deepEqual(result.harnessNotes, []);
});

test("readReviewDiff local mode notes ignored base refs", async () => {
  const repo = await initRepo();
  await writeFile(path.join(repo, "tracked.txt"), "dirty\n");

  const result = await readReviewDiff({ cwd: repo, includeDiff: true, diffMode: "local", baseRef: "main" });

  assert.match(result.harnessNotes.join("\n"), /--base main ignored by --mode local/);
});

test("readReviewDiff branch mode reads committed branch changes against base", async () => {
  const repo = await initRepo();
  await git(repo, ["checkout", "-b", "feature"]);
  await writeFile(path.join(repo, "tracked.txt"), "committed\n");
  await git(repo, ["commit", "-am", "change tracked"]);

  const result = await readReviewDiff({ cwd: repo, includeDiff: true, diffMode: "branch", baseRef: "main" });

  assert.match(result.diff, /committed/);
  assert.deepEqual(result.harnessNotes, []);
});

test("readReviewDiff commit mode reads a single committed change", async () => {
  const repo = await initRepo();
  await writeFile(path.join(repo, "tracked.txt"), "committed\n");
  await git(repo, ["commit", "-am", "change tracked"]);

  const result = await readReviewDiff({ cwd: repo, includeDiff: true, diffMode: "commit", commitRef: "HEAD" });

  assert.match(result.diff, /committed/);
  assert.deepEqual(result.harnessNotes, []);
});

test("readReviewDiff commit mode notes ignored base refs", async () => {
  const repo = await initRepo();
  await writeFile(path.join(repo, "tracked.txt"), "committed\n");
  await git(repo, ["commit", "-am", "change tracked"]);

  const result = await readReviewDiff({
    cwd: repo,
    includeDiff: true,
    diffMode: "commit",
    commitRef: "HEAD",
    baseRef: "main",
  });

  assert.match(result.harnessNotes.join("\n"), /--base main ignored by --commit HEAD/);
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
    incomplete: false,
    incompleteReasons: [],
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
    incomplete: false,
    incompleteReasons: [],
    nextRoundRecommended: false,
  };

  const markdown = renderMarkdown(report);
  assert.match(markdown, /- reviewers: none/);
  assert.match(markdown, /- result: no reviewer agents available/);

  const json = JSON.parse(renderJson(report));
  assert.equal(json.result, "no reviewer agents available");
});

test("reports flagged incomplete render as incomplete regardless of note wording", () => {
  const report = {
    round: 1,
    maxRounds: 3,
    artifact: "git diff",
    reviewers: [],
    blockingFindings: [],
    suggestions: [],
    questions: [],
    // Deliberately reworded so the verdict cannot come from string-matching notes.
    harnessNotes: ["the working tree produced nothing to review"],
    reviewerResults: [],
    incomplete: true,
    incompleteReasons: ["no review diff found"],
    nextRoundRecommended: false,
  };

  const json = JSON.parse(renderJson(report));
  assert.equal(json.result, "review incomplete");
});

test("a note that merely mentions a diff problem does not flip a complete review", () => {
  const report = {
    round: 1,
    maxRounds: 3,
    artifact: "git diff",
    reviewers: ["claude"],
    blockingFindings: [],
    suggestions: [],
    questions: [],
    // Old code keyed on phrases like "no diff found"; the verdict must now come
    // from the structured flag, not this text.
    harnessNotes: ["no diff found in an unrelated submodule (informational)"],
    reviewerResults: [],
    incomplete: false,
    incompleteReasons: [],
    nextRoundRecommended: false,
  };

  const json = JSON.parse(renderJson(report));
  assert.equal(json.result, "no blocking findings");
});

test("reports include review command and parallel test proof", () => {
  const report = {
    round: 1,
    maxRounds: 3,
    artifact: "git diff",
    reviewers: ["claude"],
    blockingFindings: [],
    suggestions: [],
    questions: [],
    harnessNotes: [],
    reviewerResults: [],
    incomplete: false,
    incompleteReasons: [],
    nextRoundRecommended: false,
    reviewCommand: "council review --mode branch --base origin/main",
    testProof: {
      command: "npm test",
      status: "passed" as const,
      summary: "stdout proof",
    },
  };

  const markdown = renderMarkdown(report);
  assert.match(markdown, /review command: council review --mode branch --base origin\/main/);
  assert.match(markdown, /parallel tests: passed/);
  assert.match(markdown, /npm test/);

  const json = JSON.parse(renderJson(report));
  assert.equal(json.testProof.status, "passed");
});

test("parallel tests use the independent test timeout when provided", async () => {
  const repo = await initRepo();
  const artifact = path.join(repo, "artifact.md");
  await writeFile(artifact, "review me\n");

  const report = await runReview({
    command: "review",
    cwd: repo,
    artifactPath: artifact,
    includeDiff: false,
    author: "codex",
    reviewers: ["codex"],
    maxRounds: 3,
    round: 1,
    changeSummary: "",
    format: "markdown",
    timeoutMs: 1_000,
    testTimeoutMs: 20,
    parallelTests: `${process.execPath} -e "setTimeout(() => {}, 100)"`,
  });

  assert.equal(report.testProof?.status, "failed");
  assert.match(report.testProof?.summary ?? "", /timed out after 20ms/);
});

test("parallel tests record passing proof through runReview", async () => {
  const repo = await initRepo();
  const artifact = path.join(repo, "artifact.md");
  await writeFile(artifact, "review me\n");

  const report = await runReview({
    command: "review",
    cwd: repo,
    artifactPath: artifact,
    includeDiff: false,
    author: "codex",
    reviewers: ["codex"],
    maxRounds: 3,
    round: 1,
    changeSummary: "",
    format: "markdown",
    parallelTests: `${process.execPath} -e "console.log('proof ok')"`,
  });

  assert.equal(report.testProof?.status, "passed");
  assert.match(report.testProof?.summary ?? "", /proof ok/);
});

test("failed parallel tests are summarized and noted without reviewers", async () => {
  const repo = await initRepo();
  const artifact = path.join(repo, "artifact.md");
  await writeFile(artifact, "review me\n");

  const report = await runReview({
    command: "review",
    cwd: repo,
    artifactPath: artifact,
    includeDiff: false,
    author: "codex",
    reviewers: ["codex"],
    maxRounds: 3,
    round: 1,
    changeSummary: "",
    format: "markdown",
    parallelTests: `${process.execPath} -e "console.error('x'.repeat(1000)); process.exit(1)"`,
  });

  assert.equal(report.testProof?.status, "failed");
  assert.ok((report.testProof?.summary.length ?? 0) <= 500);
  assert.match(report.harnessNotes.join("\n"), /parallel tests failed:/);
});

test("parallel tests are skipped when diff review has no diff", async () => {
  const repo = await initRepo();

  const report = await runReview({
    command: "review",
    cwd: repo,
    includeDiff: true,
    diffMode: "local",
    author: "codex",
    reviewers: ["codex"],
    maxRounds: 3,
    round: 1,
    changeSummary: "",
    format: "markdown",
    parallelTests: `${process.execPath} -e "console.log('should not run')"`,
  });

  assert.equal(report.testProof, undefined);
});

test("run deadline cancels a hanging reviewer and renders incomplete", async () => {
  const repo = await initRepo();
  const artifact = path.join(repo, "artifact.md");
  await writeFile(artifact, "review me\n");
  const binDir = await mkdtemp(path.join(tmpdir(), "council-run-timeout-"));
  await writeFile(
    path.join(binDir, "claude"),
    [
      `#!${process.execPath}`,
      "process.stdin.resume();",
      "process.stdin.on('end', () => { setTimeout(() => console.log('PASS: too late'), 5000); });",
    ].join("\n"),
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
      reviewers: ["claude"],
      maxRounds: 3,
      round: 1,
      changeSummary: "",
      format: "markdown",
      runTimeoutMs: 1_500,
    });

    assert.equal(report.incomplete, true);
    assert.ok(report.incompleteReasons.includes("run timed out"));
    assert.match(report.harnessNotes.join("\n"), /run timed out/);
    assert.match(report.reviewerResults[0]?.error ?? "", /aborted/);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("run deadline keeps a fast reviewer's findings while cancelling a slow one", async () => {
  const repo = await initRepo();
  const artifact = path.join(repo, "artifact.md");
  await writeFile(artifact, "review me\n");
  const binDir = await mkdtemp(path.join(tmpdir(), "council-run-partial-"));
  await writeFile(
    path.join(binDir, "codex"),
    [
      `#!${process.execPath}`,
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'SUGGESTION: keep it' } }));",
      "});",
    ].join("\n"),
    { mode: 0o755 },
  );
  await writeFile(
    path.join(binDir, "claude"),
    [
      `#!${process.execPath}`,
      "process.stdin.resume();",
      "process.stdin.on('end', () => { setTimeout(() => console.log('PASS: too late'), 5000); });",
    ].join("\n"),
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
      reviewers: ["codex", "claude"],
      maxRounds: 3,
      round: 1,
      changeSummary: "",
      format: "markdown",
      runTimeoutMs: 1_500,
    });

    assert.equal(report.incomplete, true);
    assert.equal(report.suggestions.some((s) => s.text === "keep it"), true);
    const claude = report.reviewerResults.find((r) => r.reviewer === "claude");
    assert.match(claude?.error ?? "", /aborted/);
  } finally {
    process.env.PATH = oldPath;
  }
});

test("an abort during workspace setup yields an incomplete report, not a rejection", async () => {
  const repo = await initRepo();
  const artifact = path.join(repo, "artifact.md");
  await writeFile(artifact, "review me\n");
  const binDir = await mkdtemp(path.join(tmpdir(), "council-abort-setup-"));
  await writeFile(path.join(binDir, "claude"), `#!${process.execPath}\nconsole.log('PASS: ok')\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
  try {
    // A 1ms run deadline aborts around workspace preparation. runReview must
    // still resolve with an incomplete report rather than rejecting.
    const report = await runReview({
      command: "review",
      cwd: repo,
      artifactPath: artifact,
      includeDiff: false,
      author: "codex",
      reviewers: ["claude"],
      maxRounds: 3,
      round: 1,
      changeSummary: "",
      format: "markdown",
      runTimeoutMs: 1,
    });

    assert.equal(report.incomplete, true);
    assert.ok((report.reviewerResults[0]?.error ?? "").length > 0);
  } finally {
    process.env.PATH = oldPath;
  }
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
  const oldSandbox = process.env.CODEX_SANDBOX;
  const oldNetwork = process.env.CODEX_SANDBOX_NETWORK_DISABLED;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
  delete process.env.CODEX_SANDBOX;
  delete process.env.CODEX_SANDBOX_NETWORK_DISABLED;
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
    if (oldSandbox === undefined) {
      delete process.env.CODEX_SANDBOX;
    } else {
      process.env.CODEX_SANDBOX = oldSandbox;
    }
    if (oldNetwork === undefined) {
      delete process.env.CODEX_SANDBOX_NETWORK_DISABLED;
    } else {
      process.env.CODEX_SANDBOX_NETWORK_DISABLED = oldNetwork;
    }
  }
});

test("runReview blocks reviewer launch inside Codex sandbox", async () => {
  const repo = await initRepo();
  const artifact = path.join(repo, "artifact.md");
  await writeFile(artifact, "review me\n");
  const binDir = await mkdtemp(path.join(tmpdir(), "council-sandbox-reviewer-"));
  const marker = path.join(repo, "reviewer-launched.txt");
  await writeFile(
    path.join(binDir, "claude"),
    [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(marker)}, 'launched');`,
      "console.log('PASS: ok');",
    ].join("\n"),
    { mode: 0o755 },
  );

  const oldPath = process.env.PATH;
  const oldSandbox = process.env.CODEX_SANDBOX;
  const oldNetwork = process.env.CODEX_SANDBOX_NETWORK_DISABLED;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
  process.env.CODEX_SANDBOX = "seatbelt";
  process.env.CODEX_SANDBOX_NETWORK_DISABLED = "1";
  try {
    const report = await runReview({
      command: "review",
      cwd: repo,
      artifactPath: artifact,
      includeDiff: false,
      author: "codex",
      reviewers: ["claude"],
      maxRounds: 3,
      round: 1,
      changeSummary: "",
      format: "markdown",
    });

    assert.match(report.harnessNotes.join("\n"), /reviewer launch blocked/);
    assert.deepEqual(report.reviewers, []);
    assert.equal(renderJson(report).includes('"result": "review incomplete"'), true);
    await assert.rejects(() => readFile(marker, "utf8"));
  } finally {
    process.env.PATH = oldPath;
    if (oldSandbox === undefined) {
      delete process.env.CODEX_SANDBOX;
    } else {
      process.env.CODEX_SANDBOX = oldSandbox;
    }
    if (oldNetwork === undefined) {
      delete process.env.CODEX_SANDBOX_NETWORK_DISABLED;
    } else {
      process.env.CODEX_SANDBOX_NETWORK_DISABLED = oldNetwork;
    }
  }
});

test("blocked sandbox reviewer launch still records parallel test proof", async () => {
  const repo = await initRepo();
  const artifact = path.join(repo, "artifact.md");
  await writeFile(artifact, "review me\n");
  const binDir = await mkdtemp(path.join(tmpdir(), "council-sandbox-testproof-"));
  await writeFile(path.join(binDir, "claude"), `#!${process.execPath}\nconsole.log('PASS: should not launch')\n`, {
    mode: 0o755,
  });

  const oldPath = process.env.PATH;
  const oldSandbox = process.env.CODEX_SANDBOX;
  const oldNetwork = process.env.CODEX_SANDBOX_NETWORK_DISABLED;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
  process.env.CODEX_SANDBOX = "seatbelt";
  process.env.CODEX_SANDBOX_NETWORK_DISABLED = "1";
  try {
    const report = await runReview({
      command: "review",
      cwd: repo,
      artifactPath: artifact,
      includeDiff: false,
      author: "codex",
      reviewers: ["claude"],
      maxRounds: 3,
      round: 1,
      changeSummary: "",
      format: "markdown",
      parallelTests: `${process.execPath} -e "console.log('proof ok')"`,
    });

    assert.match(report.harnessNotes.join("\n"), /reviewer launch blocked/);
    assert.equal(report.testProof?.status, "passed");
    assert.match(report.testProof?.summary ?? "", /proof ok/);
  } finally {
    process.env.PATH = oldPath;
    if (oldSandbox === undefined) {
      delete process.env.CODEX_SANDBOX;
    } else {
      process.env.CODEX_SANDBOX = oldSandbox;
    }
    if (oldNetwork === undefined) {
      delete process.env.CODEX_SANDBOX_NETWORK_DISABLED;
    } else {
      process.env.CODEX_SANDBOX_NETWORK_DISABLED = oldNetwork;
    }
  }
});

test("runReview allows sandboxed reviewer launch when network is enabled even without an API key", async () => {
  const repo = await initRepo();
  const artifact = path.join(repo, "artifact.md");
  await writeFile(artifact, "review me\n");
  const binDir = await mkdtemp(path.join(tmpdir(), "council-sandbox-network-"));
  await writeFile(path.join(binDir, "claude"), `#!${process.execPath}\nconsole.log('PASS: ok')\n`, { mode: 0o755 });

  const oldPath = process.env.PATH;
  const oldSandbox = process.env.CODEX_SANDBOX;
  const oldNetwork = process.env.CODEX_SANDBOX_NETWORK_DISABLED;
  const oldAnthropicKey = process.env.ANTHROPIC_API_KEY;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
  process.env.CODEX_SANDBOX = "landlock";
  delete process.env.CODEX_SANDBOX_NETWORK_DISABLED;
  // The common case: OAuth/subscription auth, no API key env var. Must not block.
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const report = await runReview({
      command: "review",
      cwd: repo,
      artifactPath: artifact,
      includeDiff: false,
      author: "codex",
      reviewers: ["claude"],
      maxRounds: 3,
      round: 1,
      changeSummary: "",
      format: "markdown",
    });

    assert.doesNotMatch(report.harnessNotes.join("\n"), /reviewer launch blocked/);
    assert.equal(report.reviewerResults[0]?.pass, true);
  } finally {
    process.env.PATH = oldPath;
    if (oldSandbox === undefined) {
      delete process.env.CODEX_SANDBOX;
    } else {
      process.env.CODEX_SANDBOX = oldSandbox;
    }
    if (oldNetwork === undefined) {
      delete process.env.CODEX_SANDBOX_NETWORK_DISABLED;
    } else {
      process.env.CODEX_SANDBOX_NETWORK_DISABLED = oldNetwork;
    }
    if (oldAnthropicKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = oldAnthropicKey;
    }
  }
});

test("runReview allows sandboxed reviewer launch with explicit override", async () => {
  const repo = await initRepo();
  const artifact = path.join(repo, "artifact.md");
  await writeFile(artifact, "review me\n");
  const binDir = await mkdtemp(path.join(tmpdir(), "council-sandbox-override-"));
  await writeFile(path.join(binDir, "claude"), `#!${process.execPath}\nconsole.log('PASS: ok')\n`, { mode: 0o755 });

  const oldPath = process.env.PATH;
  const oldSandbox = process.env.CODEX_SANDBOX;
  const oldNetwork = process.env.CODEX_SANDBOX_NETWORK_DISABLED;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
  process.env.CODEX_SANDBOX = "seatbelt";
  process.env.CODEX_SANDBOX_NETWORK_DISABLED = "1";
  try {
    const report = await runReview({
      command: "review",
      cwd: repo,
      artifactPath: artifact,
      includeDiff: false,
      author: "codex",
      reviewers: ["claude"],
      allowSandboxedReviewers: true,
      maxRounds: 3,
      round: 1,
      changeSummary: "",
      format: "markdown",
    });

    assert.doesNotMatch(report.harnessNotes.join("\n"), /reviewer launch blocked/);
    assert.equal(report.reviewerResults[0]?.pass, true);
  } finally {
    process.env.PATH = oldPath;
    if (oldSandbox === undefined) {
      delete process.env.CODEX_SANDBOX;
    } else {
      process.env.CODEX_SANDBOX = oldSandbox;
    }
    if (oldNetwork === undefined) {
      delete process.env.CODEX_SANDBOX_NETWORK_DISABLED;
    } else {
      process.env.CODEX_SANDBOX_NETWORK_DISABLED = oldNetwork;
    }
  }
});
