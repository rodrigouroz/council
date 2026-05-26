#!/usr/bin/env node

// src/cli.ts
import { cwd as currentWorkingDirectory } from "node:process";

// src/review.ts
import { readFile as readFile2 } from "node:fs/promises";
import path3 from "node:path";

// src/agents.ts
import { accessSync, constants } from "node:fs";
import path from "node:path";

// src/process.ts
import { spawn } from "node:child_process";
function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });
    if (options.input !== void 0) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

// src/agents.ts
var supportedReviewers = [
  { id: "codex", executable: "codex" },
  { id: "claude", executable: "claude" }
];
function discoverReviewers(env = process.env) {
  const reviewers = [];
  const warnings = [];
  for (const candidate of supportedReviewers) {
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
` }
  );
  return parseCodexOutput(stdout);
}
async function runClaude(executable, request) {
  const frame = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: request.prompt }]
    }
  });
  const { stdout } = await runProcess(
    executable,
    [
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions"
    ],
    { cwd: request.cwd, input: `${frame}
` }
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
  const parts = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const frame = JSON.parse(line);
      if (frame.type !== "assistant") continue;
      for (const block of frame.message?.content ?? []) {
        if (block.type === "text" && block.text) {
          parts.push(block.text);
        }
      }
    } catch {
    }
  }
  return parts.join("\n").trim();
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
  const discovery = discoverReviewers();
  const report = {
    round: request.round,
    maxRounds: request.maxRounds,
    artifact: artifactLabel(request),
    reviewers: discovery.reviewers.map((reviewer) => reviewer.id),
    blockingFindings: [],
    suggestions: [],
    questions: [],
    harnessNotes: [...discovery.warnings],
    reviewerResults: [],
    nextRoundRecommended: false
  };
  const artifact = await readArtifact(request);
  const diff = await readReviewDiff(request);
  if (discovery.reviewers.length === 0) {
    report.harnessNotes.push("no reviewer agents available");
    return report;
  }
  const reviewerResults = await Promise.all(
    discovery.reviewers.map((reviewer) => runOneReviewer(reviewer, request, artifact, diff))
  );
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
  report.nextRoundRecommended = report.blockingFindings.length > 0 || report.questions.length > 0;
  return report;
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
    const upper = line.toUpperCase();
    if (upper.startsWith("BLOCKER:")) {
      currentFinding = pushFinding(result.blockingFindings, reviewer, line.slice("BLOCKER:".length));
    } else if (upper.startsWith("SUGGESTION:")) {
      currentFinding = pushFinding(result.suggestions, reviewer, line.slice("SUGGESTION:".length));
    } else if (upper.startsWith("QUESTION:")) {
      currentFinding = pushFinding(result.questions, reviewer, line.slice("QUESTION:".length));
    } else if (upper.startsWith("PASS:")) {
      result.pass = true;
      currentFinding = void 0;
    } else if (line && currentFinding) {
      currentFinding.text = `${currentFinding.text}
${rawLine}`;
    }
  }
  return result;
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
    const output = await runReviewer(reviewer, { cwd: prepared.path, prompt });
    const result = parseReviewerOutput(reviewer.id, output);
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
  if (!request.includeDiff) return "";
  try {
    const { stdout } = await runProcess("git", ["diff", "--binary", "HEAD", "--"], { cwd: request.cwd });
    return stdout;
  } catch {
    return "";
  }
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
  return { reviewer, text: text.trim() };
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
    `- result: ${report.nextRoundRecommended ? "next round recommended" : "no blocking findings"}`,
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
    "",
    "## Author Checklist",
    "- Accept, reject, or explain each blocking finding.",
    "- Re-run Council after meaningful changes while rounds remain.",
    ""
  ];
  return `${lines.join("\n")}`;
}
function renderJson(report) {
  return `${JSON.stringify(report, null, 2)}
`;
}
function findingSection(title, findings) {
  if (findings.length === 0) {
    return [`## ${title}`, "- None."];
  }
  return [`## ${title}`, ...findings.map((finding2) => `- ${finding2.reviewer}: ${finding2.text}`)];
}

// src/cli.ts
function parseArgs(args) {
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
  validateRequest(request);
  return request;
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
