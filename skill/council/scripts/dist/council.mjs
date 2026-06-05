#!/usr/bin/env node

// src/cli.ts
import { cwd as currentWorkingDirectory, env as processEnv } from "node:process";

// src/review.ts
import { readFile as readFile2 } from "node:fs/promises";
import path3 from "node:path";

// src/agents.ts
import { accessSync, constants } from "node:fs";
import path from "node:path";

// src/process.ts
import { spawn } from "node:child_process";
var DEFAULT_TIMEOUT_MS = 3e5;
function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        child.kill("SIGKILL");
      }, 2e3).unref();
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(failedProcessMessage(command, code, stdout, stderr)));
    });
    if (options.input !== void 0) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}
function runShellCommand(command, options) {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const child = spawn(command, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        child.kill("SIGKILL");
      }, 2e3).unref();
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(failedProcessMessage(command, code, stdout, stderr)));
    });
    if (options.input !== void 0) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}
function failedProcessMessage(command, code, stdout, stderr) {
  const diagnostic = stderr.trim() || stdout.trim();
  return `${command} exited with code ${code}: ${diagnostic}`;
}

// src/agents.ts
var supportedReviewers = [
  { id: "codex", executable: "codex" },
  { id: "claude", executable: "claude" }
];
function discoverReviewers(env = process.env, author, selectedReviewers) {
  const reviewers = [];
  const warnings = [];
  const selected = selectedReviewers ? new Set(selectedReviewers) : void 0;
  for (const candidate of supportedReviewers) {
    if (candidate.id === author) {
      warnings.push(`reviewer ${candidate.id} skipped: matches authoring agent`);
      continue;
    }
    if (selected && !selected.has(candidate.id)) {
      warnings.push(`reviewer ${candidate.id} skipped: not selected`);
      continue;
    }
    const executable = findExecutable(candidate.executable, env);
    if (!executable) {
      warnings.push(`reviewer ${candidate.id} skipped: executable "${candidate.executable}" not found on PATH`);
      continue;
    }
    reviewers.push({ id: candidate.id, executable });
  }
  return { reviewers, warnings };
}
async function runReviewer(reviewer, request) {
  switch (reviewer.id) {
    case "codex":
      return runCodex(reviewer.executable, request);
    case "claude":
      return runClaude(reviewer.executable, request);
  }
}
function findExecutable(name, env) {
  const pathValue = env.PATH ?? "";
  const dirs = pathValue.split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${name}${ext}`);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
      }
    }
  }
  return void 0;
}
async function runCodex(executable, request) {
  const { stdout } = await runProcess(
    executable,
    ["exec", "--json", "--skip-git-repo-check", "--sandbox", "workspace-write"],
    { cwd: request.cwd, input: `${request.prompt}
`, timeoutMs: request.timeoutMs }
  );
  return parseCodexOutput(stdout);
}
async function runClaude(executable, request) {
  const { stdout } = await runProcess(
    executable,
    [
      "--print",
      "--no-session-persistence",
      "--permission-mode",
      "bypassPermissions"
    ],
    { cwd: request.cwd, input: `${request.prompt}
`, timeoutMs: request.timeoutMs }
  );
  return parseClaudeOutput(stdout);
}
function parseCodexOutput(stdout) {
  const parts = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const frame = JSON.parse(line);
      if (frame.type === "item.completed" && frame.item?.type === "agent_message" && frame.item.text) {
        parts.push(frame.item.text);
      }
    } catch {
    }
  }
  return parts.join("\n").trim();
}
function parseClaudeOutput(stdout) {
  return stdout.trim();
}

// src/workspace.ts
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path2 from "node:path";
async function prepareWorkspace(request) {
  const root = await gitRoot(request.cwd);
  if (!root || !await hasGitHead(root)) {
    return copyFallback(request, root ? "git repository has no HEAD" : "not inside a git repository");
  }
  const tmpRoot = await mkdtemp(path2.join(tmpdir(), `council-${safeSegment(request.reviewerId)}-`));
  const worktreePath = path2.join(tmpRoot, "repo");
  try {
    await runProcess("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], { cwd: root });
    await applyDirtyDiff(root, worktreePath);
    await copyUntracked(root, worktreePath);
    await copyArtifactIfNeeded(request.artifactPath, worktreePath);
    return {
      path: worktreePath,
      fallback: false,
      async status() {
        const { stdout } = await runProcess("git", ["status", "--porcelain=v1", "-uall"], { cwd: worktreePath });
        return stdout.trim();
      },
      async cleanup() {
        try {
          await runProcess("git", ["worktree", "remove", "--force", worktreePath], { cwd: root });
        } finally {
          await rm(tmpRoot, { recursive: true, force: true });
        }
      }
    };
  } catch (error) {
    await rm(tmpRoot, { recursive: true, force: true });
    return copyFallback(request, `git worktree setup failed: ${error.message}`);
  }
}
async function gitRoot(cwd) {
  try {
    const { stdout } = await runProcess("git", ["rev-parse", "--show-toplevel"], { cwd });
    return stdout.trim();
  } catch {
    return void 0;
  }
}
async function hasGitHead(root) {
  try {
    await runProcess("git", ["rev-parse", "--verify", "HEAD"], { cwd: root });
    return true;
  } catch {
    return false;
  }
}
async function applyDirtyDiff(root, worktreePath) {
  const { stdout } = await runProcess("git", ["diff", "--binary", "HEAD", "--"], { cwd: root });
  if (!stdout.trim()) return;
  await runProcess("git", ["apply", "--binary", "--whitespace=nowarn"], { cwd: worktreePath, input: stdout });
}
async function copyUntracked(root, worktreePath) {
  const { stdout } = await runProcess("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root });
  for (const rel of stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    await copyFilePreservingDirs(path2.join(root, rel), path2.join(worktreePath, rel));
  }
}
async function copyArtifactIfNeeded(artifactPath, worktreePath) {
  if (!artifactPath) return;
  await copyFilePreservingDirs(artifactPath, path2.join(worktreePath, ".council", "artifact.md"));
}
async function copyFallback(request, reason) {
  const tmpRoot = await mkdtemp(path2.join(tmpdir(), `council-copy-${safeSegment(request.reviewerId)}-`));
  const workspacePath = path2.join(tmpRoot, "repo");
  await cp(request.cwd, workspacePath, {
    recursive: true,
    filter: (source) => source === request.cwd || !shouldExcludeCopyPath(source)
  });
  await copyArtifactIfNeeded(request.artifactPath, workspacePath);
  return {
    path: workspacePath,
    fallback: true,
    note: `used directory-copy isolation fallback: ${reason}`,
    async status() {
      return "";
    },
    async cleanup() {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  };
}
function shouldExcludeCopyPath(source) {
  const base = path2.basename(source);
  return [".git", "node_modules", ".next", "dist", "build", "coverage"].includes(base);
}
async function copyFilePreservingDirs(source, destination) {
  const sourceStat = await stat(source);
  if (sourceStat.isDirectory()) {
    await cp(source, destination, { recursive: true });
    return;
  }
  await mkdir(path2.dirname(destination), { recursive: true });
  await writeFile(destination, await readFile(source));
}
function safeSegment(input) {
  return input.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

// src/review.ts
async function runReview(request) {
  const discovery = discoverReviewers(process.env, request.author, request.reviewers);
  const report = {
    round: request.round,
    maxRounds: request.maxRounds,
    artifact: artifactLabel(request),
    reviewers: discovery.reviewers.map((reviewer) => reviewer.id),
    blockingFindings: [],
    suggestions: [],
    questions: [],
    harnessNotes: [authorNote(request), ...sandboxHarnessNotes(process.env), ...discovery.warnings],
    reviewerResults: [],
    nextRoundRecommended: false,
    reviewCommand: request.reviewCommand
  };
  const artifact = await readArtifact(request);
  const diffResult = await readReviewDiff(request);
  report.harnessNotes.push(...diffResult.harnessNotes);
  if (request.includeDiff && !diffResult.diff) {
    return report;
  }
  const testProofPromise = request.parallelTests ? runParallelTests(request) : Promise.resolve(void 0);
  if (shouldBlockSandboxedReviewers(process.env, request, discovery.reviewers)) {
    report.harnessNotes.push(
      sandboxReviewerBlockedNote()
    );
    report.reviewers = [];
    report.testProof = await testProofPromise;
    appendTestProofNotes(report);
    return report;
  }
  if (discovery.reviewers.length === 0) {
    report.harnessNotes.push("no reviewer agents available");
    report.testProof = await testProofPromise;
    appendTestProofNotes(report);
    return report;
  }
  const [reviewerResults, testProof] = await Promise.all([
    Promise.all(discovery.reviewers.map((reviewer) => runOneReviewer(reviewer, request, artifact, diffResult.diff))),
    testProofPromise
  ]);
  report.testProof = testProof;
  for (const [index, result] of reviewerResults.entries()) {
    const reviewer = discovery.reviewers[index];
    report.reviewerResults.push(result);
    report.blockingFindings.push(...result.blockingFindings);
    report.suggestions.push(...result.suggestions);
    report.questions.push(...result.questions);
    if (result.error) {
      report.harnessNotes.push(`reviewer ${reviewer.id} failed: ${result.error}`);
    }
    if (result.workspaceStatus) {
      report.harnessNotes.push(`reviewer ${reviewer.id} left workspace changes: ${result.workspaceStatus}`);
    }
  }
  appendTestProofNotes(report);
  report.nextRoundRecommended = report.blockingFindings.length > 0 || report.questions.length > 0 || report.reviewerResults.some((result) => result.error) || report.testProof?.status === "failed";
  return report;
}
function shouldBlockSandboxedReviewers(env, request, reviewers) {
  if (!env.CODEX_SANDBOX || reviewers.length === 0 || request.allowSandboxedReviewers) {
    return false;
  }
  return env.CODEX_SANDBOX_NETWORK_DISABLED === "1";
}
function sandboxReviewerBlockedNote() {
  return "reviewer launch blocked: Council is running inside a Codex sandbox with network disabled, so reviewer CLIs cannot reach their model backends. Rerun outside the sandbox. In Codex tool calls, use sandbox_permissions=require_escalated; from a shell, use codex --sandbox danger-full-access or --dangerously-bypass-approvals-and-sandbox only when you understand the risk. --allow-sandboxed-reviewers is an unconditional override.";
}
function authorNote(request) {
  const source = request.authorSource ?? "unspecified";
  if (request.author) {
    return `authoring agent: ${request.author} (${source}); excluded from reviewers to prevent self-review`;
  }
  return `authoring agent: none (${source}); no reviewer auto-excluded \u2014 pass --author to guarantee no self-review`;
}
function sandboxHarnessNotes(env) {
  const sandbox = env.CODEX_SANDBOX;
  if (!sandbox) return [];
  const networkNote = env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? " with network disabled" : "";
  return [
    `running inside CODEX_SANDBOX=${sandbox}${networkNote}; reviewer CLIs run as local child processes and need their normal auth/home state and network access.`
  ];
}
function buildPrompt(input) {
  return `You are a Council reviewer. Review the artifact and repository context. Use tools as needed inside this disposable workspace. Do not intentionally modify source; if tools generate state, the harness will discard this workspace.

Artifact kind: ${input.artifactKind || "unknown"}
Repository path: ${input.cwd}
Round: ${input.round} of ${input.maxRounds}
Change summary: ${input.changeSummary || "none"}

Look for bugs, missing requirements, incorrect assumptions, unverifiable claims, test gaps, operational risks, and unclear user impact.

Return concise findings using only these prefixes:
BLOCKER: concrete issue with file/line/evidence when available
SUGGESTION: useful but non-blocking improvement
QUESTION: information needed to judge the artifact
PASS: no blocking findings

Artifact:
${input.artifact}

Diff:
${input.diff}
`;
}
function parseReviewerOutput(reviewer, output) {
  const result = {
    reviewer,
    rawOutput: output,
    blockingFindings: [],
    suggestions: [],
    questions: [],
    pass: false
  };
  let currentFinding;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    const findingLine = normalizeFindingLine(line);
    const upper = findingLine.toUpperCase();
    if (upper.startsWith("BLOCKER:")) {
      currentFinding = pushFinding(result.blockingFindings, reviewer, findingLine.slice("BLOCKER:".length));
    } else if (upper.startsWith("SUGGESTION:")) {
      currentFinding = pushFinding(result.suggestions, reviewer, findingLine.slice("SUGGESTION:".length));
    } else if (upper.startsWith("QUESTION:")) {
      currentFinding = pushFinding(result.questions, reviewer, findingLine.slice("QUESTION:".length));
    } else if (upper.startsWith("PASS:")) {
      result.pass = true;
      currentFinding = void 0;
    } else if (!line) {
      currentFinding = void 0;
    } else if (line && currentFinding) {
      currentFinding.text = `${currentFinding.text}
${rawLine}`;
    }
  }
  return result;
}
function normalizeFindingLine(line) {
  let normalized = line.replace(/^[-+*]\s+/, "").trim();
  normalized = normalized.replace(/^\d+[.)]\s+(?=(?:\*\*|__))/, "").trim();
  normalized = normalized.replace(/^>\s*/, "").trim();
  normalized = normalized.replace(
    /^(?:\*\*|__)(BLOCKER|SUGGESTION|QUESTION|PASS)(?::)?(?:\*\*|__):?\s*/i,
    (_match, prefix) => `${prefix.toUpperCase()}: `
  );
  for (const marker of ["**", "__"]) {
    if (normalized.startsWith(marker) && normalized.endsWith(marker)) {
      normalized = normalized.slice(marker.length, -marker.length);
    }
  }
  return normalized.trim();
}
async function runOneReviewer(reviewer, request, artifact, diff) {
  const prepared = await prepareWorkspace({
    cwd: request.cwd,
    reviewerId: reviewer.id,
    artifactPath: request.artifactPath
  });
  try {
    const prompt = buildPrompt({
      artifactKind: artifactKind(request),
      artifact,
      diff,
      cwd: prepared.path,
      round: request.round,
      maxRounds: request.maxRounds,
      changeSummary: request.changeSummary
    });
    const output = await runReviewer(reviewer, { cwd: prepared.path, prompt, timeoutMs: request.timeoutMs });
    const result = parseReviewerOutput(reviewer.id, output);
    if (!hasUsableReviewerOutput(result)) {
      result.error = "no usable reviewer output; expected BLOCKER, SUGGESTION, QUESTION, or PASS";
    }
    const status = await prepared.status();
    if (prepared.note) {
      result.workspaceStatus = prepared.note;
    }
    if (status) {
      result.workspaceStatus = [result.workspaceStatus, status].filter(Boolean).join("; ");
    }
    return result;
  } catch (error) {
    return {
      reviewer: reviewer.id,
      blockingFindings: [],
      suggestions: [],
      questions: [],
      pass: false,
      error: error.message
    };
  } finally {
    await prepared.cleanup();
  }
}
async function readArtifact(request) {
  if (!request.artifactPath) return "";
  return readFile2(request.artifactPath, "utf8");
}
async function readReviewDiff(request) {
  if (!request.includeDiff) return { diff: "", harnessNotes: [] };
  try {
    const mode = request.diffMode ?? "auto";
    if (mode === "local") {
      const diff = await gitStdout(request.cwd, ["diff", "--binary", "HEAD", "--"]);
      const harnessNotes = ignoredBaseNotes(request, "--mode local");
      return diff ? { diff, harnessNotes } : { diff: "", harnessNotes: [...harnessNotes, "no diff found in local working tree"] };
    }
    if (mode === "commit") {
      if (!request.commitRef) {
        return { diff: "", harnessNotes: ["--mode commit requires --commit"] };
      }
      const diff = await gitStdout(request.cwd, ["show", "--format=", "--binary", request.commitRef, "--"]);
      const harnessNotes = ignoredBaseNotes(request, `--commit ${request.commitRef}`);
      return diff ? { diff, harnessNotes } : { diff: "", harnessNotes: [...harnessNotes, `no diff found for commit ${request.commitRef}`] };
    }
    const dirtyDiff = await gitStdout(request.cwd, ["diff", "--binary", "HEAD", "--"]);
    const baseRef = request.baseRef ?? await readUpstreamRef(request.cwd);
    if (mode === "branch" && !baseRef) {
      return { diff: "", harnessNotes: ["--mode branch requires --base or an upstream ref"] };
    }
    if (baseRef) {
      const mergeBase = await gitStdout(request.cwd, ["merge-base", baseRef, "HEAD"]);
      const committedDiff = await gitStdout(request.cwd, ["diff", "--binary", `${mergeBase}...HEAD`, "--"]);
      if (committedDiff && dirtyDiff) {
        return {
          diff: `${committedDiff}

# ---- dirty working-tree changes ----
${dirtyDiff}`,
          harnessNotes: [`diff includes committed changes against ${baseRef} and dirty working-tree changes`]
        };
      }
      if (committedDiff) {
        return { diff: committedDiff, harnessNotes: [] };
      }
      if (dirtyDiff) {
        return { diff: dirtyDiff, harnessNotes: [] };
      }
      return {
        diff: "",
        harnessNotes: [`no diff found against ${baseRef}`]
      };
    }
    if (dirtyDiff) {
      return { diff: dirtyDiff, harnessNotes: [] };
    }
    return {
      diff: "",
      harnessNotes: ["no diff found; pass --base <ref> for committed branch review"]
    };
  } catch (error) {
    return {
      diff: "",
      harnessNotes: [`failed to read diff: ${error.message}`]
    };
  }
}
function ignoredBaseNotes(request, target) {
  return request.baseRef ? [`--base ${request.baseRef} ignored by ${target}`] : [];
}
async function runParallelTests(request) {
  const command = request.parallelTests;
  try {
    const result = await runShellCommand(command, { cwd: request.cwd, timeoutMs: request.testTimeoutMs ?? request.timeoutMs });
    return {
      command,
      status: "passed",
      summary: summarizeOutput(result.stdout, result.stderr) || "command exited with code 0"
    };
  } catch (error) {
    return {
      command,
      status: "failed",
      summary: summarizeOutput("", error.message) || error.message.slice(0, 500)
    };
  }
}
function appendTestProofNotes(report) {
  if (report.testProof?.status === "failed") {
    report.harnessNotes.push(`parallel tests failed: ${report.testProof.summary}`);
  }
}
function summarizeOutput(stdout, stderr) {
  return [...lastNonEmptyLines(stdout, 2), ...lastNonEmptyLines(stderr, 2)].join(" | ").slice(0, 500);
}
function lastNonEmptyLines(output, count) {
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-count);
}
async function gitStdout(cwd, args) {
  const { stdout } = await runProcess("git", args, { cwd });
  return stdout.trimEnd();
}
async function readUpstreamRef(cwd) {
  try {
    return await gitStdout(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  } catch {
    return void 0;
  }
}
function hasUsableReviewerOutput(result) {
  return result.pass || result.blockingFindings.length > 0 || result.suggestions.length > 0 || result.questions.length > 0 || Boolean(result.error);
}
function artifactKind(request) {
  if (request.includeDiff) return "diff";
  const ext = path3.extname(request.artifactPath ?? "").toLowerCase();
  if (ext === ".md" || ext === ".markdown") return "spec";
  return "unknown";
}
function artifactLabel(request) {
  return request.includeDiff ? "git diff" : request.artifactPath ?? "";
}
function finding(reviewer, text) {
  return { reviewer, text: cleanFindingText(text) };
}
function cleanFindingText(text) {
  let cleaned = text.trim();
  for (const marker of ["**", "__"]) {
    if (cleaned.startsWith(marker) && cleaned.endsWith(marker)) {
      cleaned = cleaned.slice(marker.length, -marker.length);
    }
  }
  return cleaned.trim();
}
function pushFinding(target, reviewer, text) {
  const entry = finding(reviewer, text);
  target.push(entry);
  return entry;
}

// src/report.ts
function renderMarkdown(report) {
  const lines = [
    "# Council Review",
    "",
    "## Summary",
    `- round: ${report.round} of ${report.maxRounds}`,
    `- artifact: ${report.artifact}`,
    `- reviewers: ${report.reviewers.length > 0 ? report.reviewers.join(", ") : "none"}`,
    `- result: ${reportResult(report)}`,
    ...report.reviewCommand ? [`- review command: ${report.reviewCommand}`] : [],
    ...report.testProof ? [`- parallel tests: ${report.testProof.status}`, `- test command: ${report.testProof.command}`] : [],
    "",
    ...findingSection("Blocking Findings", report.blockingFindings),
    "",
    ...findingSection("Suggestions", report.suggestions),
    "",
    ...findingSection("Questions", report.questions),
    "",
    "## Reviewer Disagreements",
    "- None detected by the v1 harness.",
    "",
    "## Harness Notes",
    ...report.harnessNotes.length > 0 ? report.harnessNotes.map((note) => `- ${note}`) : ["- None."],
    ...report.testProof ? ["", "## Test Proof", `- ${report.testProof.status}: ${report.testProof.summary}`] : [],
    "",
    "## Author Checklist",
    "- Accept, reject, or explain each blocking finding.",
    "- Re-run Council after meaningful changes while rounds remain.",
    ""
  ];
  return `${lines.join("\n")}`;
}
function renderJson(report) {
  return `${JSON.stringify({ ...report, result: reportResult(report) }, null, 2)}
`;
}
function findingSection(title, findings) {
  if (findings.length === 0) {
    return [`## ${title}`, "- None."];
  }
  return [`## ${title}`, ...findings.map((finding2) => `- ${finding2.reviewer}: ${finding2.text}`)];
}
function reportResult(report) {
  if (report.reviewerResults.some((result) => result.error) || report.testProof?.status === "failed" || report.harnessNotes.some(isIncompleteHarnessNote)) {
    return "review incomplete";
  }
  if (report.reviewers.length === 0) {
    return "no reviewer agents available";
  }
  return report.nextRoundRecommended ? "next round recommended" : "no blocking findings";
}
function isIncompleteHarnessNote(note) {
  return note.startsWith("no diff found") || note.startsWith("failed to read diff") || note.startsWith("--mode ") || note.startsWith("reviewer launch blocked");
}

// src/cli.ts
function parseArgs(args, env = processEnv) {
  const [command, ...rest] = args;
  if (command !== "review") {
    throw new Error("usage: council review --artifact PATH --cwd PATH");
  }
  const request = {
    command: "review",
    cwd: currentWorkingDirectory(),
    includeDiff: false,
    maxRounds: 3,
    round: 1,
    changeSummary: "",
    format: "markdown"
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    switch (arg) {
      case "--artifact":
        request.artifactPath = requireValue(rest, ++i, "--artifact");
        break;
      case "--cwd":
        request.cwd = requireValue(rest, ++i, "--cwd");
        break;
      case "--diff":
        request.includeDiff = true;
        request.diffMode ??= "auto";
        break;
      case "--mode":
        request.diffMode = parseDiffMode(requireValue(rest, ++i, "--mode"));
        request.includeDiff = true;
        break;
      case "--base":
        request.baseRef = requireValue(rest, ++i, "--base");
        break;
      case "--commit":
        request.commitRef = requireValue(rest, ++i, "--commit");
        request.diffMode = "commit";
        request.includeDiff = true;
        break;
      case "--timeout-ms":
        request.timeoutMs = parsePositiveInteger(requireValue(rest, ++i, "--timeout-ms"), "--timeout-ms");
        break;
      case "--test-timeout-ms":
        request.testTimeoutMs = parsePositiveInteger(requireValue(rest, ++i, "--test-timeout-ms"), "--test-timeout-ms");
        break;
      case "--author":
        request.author = parseAuthor(requireValue(rest, ++i, "--author"), "--author");
        break;
      case "--reviewers":
        request.reviewers = parseReviewers(requireValue(rest, ++i, "--reviewers"));
        break;
      case "--panel":
        request.reviewers = ["codex", "claude"];
        break;
      case "--parallel-tests":
        request.parallelTests = requireValue(rest, ++i, "--parallel-tests");
        break;
      case "--allow-sandboxed-reviewers":
        request.allowSandboxedReviewers = true;
        break;
      case "--max-rounds":
        request.maxRounds = parsePositiveInteger(requireValue(rest, ++i, "--max-rounds"), "--max-rounds");
        break;
      case "--round":
        request.round = parsePositiveInteger(requireValue(rest, ++i, "--round"), "--round");
        break;
      case "--change-summary":
        request.changeSummary = requireValue(rest, ++i, "--change-summary");
        break;
      case "--format":
        request.format = parseFormat(requireValue(rest, ++i, "--format"));
        break;
      case "--json":
        request.format = "json";
        break;
      default:
        if (arg.startsWith("-")) {
          throw new Error(`unknown option: ${arg}`);
        }
        throw new Error(`unexpected positional argument: ${arg}`);
    }
  }
  const resolved = resolveAuthor(request.author, env);
  request.author = resolved.author;
  request.authorSource = resolved.source;
  request.reviewCommand = commandLine(args);
  validateRequest(request);
  return request;
}
function resolveAuthor(flagAuthor, env) {
  if (flagAuthor) {
    return { author: flagAuthor, source: "--author flag" };
  }
  const envAuthor = parseAuthor(env.COUNCIL_AUTHOR_AGENT, "COUNCIL_AUTHOR_AGENT");
  if (envAuthor) {
    return { author: envAuthor, source: "COUNCIL_AUTHOR_AGENT" };
  }
  if (env.CODEX_SANDBOX) {
    return { author: "codex", source: "auto-detected from CODEX_SANDBOX" };
  }
  if (env.CLAUDECODE === "1" || env.CLAUDE_CODE_ENTRYPOINT) {
    return { author: "claude", source: "auto-detected from CLAUDECODE" };
  }
  return { author: void 0, source: "no authoring agent detected" };
}
async function runCli(args) {
  const request = parseArgs(args);
  const report = await runReview(request);
  return request.format === "json" ? renderJson(report) : renderMarkdown(report);
}
function requireValue(args, index, flag) {
  const value = args[index];
  if (value === void 0 || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}
function parsePositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be at least 1`);
  }
  return parsed;
}
function parseFormat(value) {
  if (value === "markdown" || value === "json") {
    return value;
  }
  throw new Error("--format must be markdown or json");
}
function parseDiffMode(value) {
  if (value === "auto" || value === "local" || value === "branch" || value === "commit") {
    return value;
  }
  throw new Error("--mode must be auto, local, branch, or commit");
}
function parseAuthor(value, source) {
  const normalized = value?.trim();
  if (normalized === void 0 || normalized === "") {
    return void 0;
  }
  if (normalized === "codex" || normalized === "claude") {
    return normalized;
  }
  throw new Error(`${source} must be codex or claude`);
}
function parseReviewers(value) {
  let parsed;
  try {
    parsed = value.split(",").map((entry) => parseAuthor(entry, "--reviewers")).filter((entry) => entry !== void 0);
  } catch {
    throw new Error("--reviewers must contain codex or claude");
  }
  if (parsed.length === 0) {
    throw new Error("--reviewers must contain codex or claude");
  }
  return [...new Set(parsed)];
}
function validateRequest(request) {
  if (!request.artifactPath && !request.includeDiff) {
    throw new Error("review requires --artifact or --diff");
  }
  if (request.artifactPath && request.includeDiff) {
    throw new Error("review accepts either --artifact or --diff, not both");
  }
  if (request.round > request.maxRounds) {
    throw new Error("--round must be between 1 and --max-rounds");
  }
  if (request.diffMode === "commit" && !request.commitRef) {
    throw new Error("--mode commit requires --commit");
  }
  if (request.commitRef && request.diffMode !== "commit") {
    throw new Error("--commit requires --mode commit");
  }
}
function commandLine(args) {
  return `council ${args.map(shellToken).join(" ")}`;
}
function shellToken(value) {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

// src/main.ts
runCli(process.argv.slice(2)).then((output) => {
  process.stdout.write(output);
}).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}
`);
  process.exitCode = 1;
});
