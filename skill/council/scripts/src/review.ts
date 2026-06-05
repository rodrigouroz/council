import { readFile } from "node:fs/promises";
import path from "node:path";

import { discoverReviewers, runReviewer } from "./agents.ts";
import { runProcess, runShellCommand } from "./process.ts";
import type { CouncilReport, DiffMode, Finding, ReviewRequest, Reviewer, ReviewerResult, TestProof } from "./types.ts";
import { prepareWorkspace, type PreparedWorkspace } from "./workspace.ts";

export interface PromptInput {
  artifactKind: string;
  artifact: string;
  diff: string;
  cwd: string;
  round: number;
  maxRounds: number;
  changeSummary: string;
}

export interface DiffReadRequest {
  cwd: string;
  includeDiff: boolean;
  diffMode?: DiffMode;
  baseRef?: string;
  commitRef?: string;
  signal?: AbortSignal;
}

export const DEFAULT_RUN_TIMEOUT_MS = 480_000;

export interface DiffReadResult {
  diff: string;
  harnessNotes: string[];
}

export async function runReview(request: ReviewRequest): Promise<CouncilReport> {
  const runController = new AbortController();
  let runTimedOut = false;
  const runTimer = setTimeout(() => {
    runTimedOut = true;
    runController.abort();
  }, request.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
  runTimer.unref();
  try {
    return await runReviewInner(request, runController.signal, () => runTimedOut);
  } finally {
    clearTimeout(runTimer);
  }
}

async function runReviewInner(
  request: ReviewRequest,
  signal: AbortSignal,
  timedOut: () => boolean,
): Promise<CouncilReport> {
  const discovery = discoverReviewers(process.env, request.author, request.reviewers);
  const report: CouncilReport = {
    round: request.round,
    maxRounds: request.maxRounds,
    artifact: artifactLabel(request),
    reviewers: discovery.reviewers.map((reviewer) => reviewer.id),
    blockingFindings: [],
    suggestions: [],
    questions: [],
    harnessNotes: [authorNote(request), ...sandboxHarnessNotes(process.env), ...discovery.warnings],
    reviewerResults: [],
    incomplete: false,
    incompleteReasons: [],
    nextRoundRecommended: false,
    reviewCommand: request.reviewCommand,
  };

  const artifact = await readArtifact(request);
  const diffResult = await readReviewDiff({ ...request, signal });
  report.harnessNotes.push(...diffResult.harnessNotes);
  if (request.includeDiff && !diffResult.diff) {
    markIncomplete(report, "no review diff found");
    return report;
  }
  const testProofPromise = request.parallelTests ? runParallelTests(request, signal) : Promise.resolve(undefined);
  if (shouldBlockSandboxedReviewers(process.env, request, discovery.reviewers)) {
    report.harnessNotes.push(
      sandboxReviewerBlockedNote(),
    );
    report.reviewers = [];
    markIncomplete(report, "reviewer launch blocked inside sandbox");
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
    Promise.all(
      discovery.reviewers.map((reviewer) => runOneReviewer(reviewer, request, artifact, diffResult.diff, signal)),
    ),
    testProofPromise,
  ]);
  report.testProof = testProof;
  if (timedOut()) {
    report.harnessNotes.push(
      `run timed out after ${request.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS}ms; outstanding reviewers/tests were cancelled and any completed results are kept`,
    );
    markIncomplete(report, "run timed out");
  }
  for (const [index, result] of reviewerResults.entries()) {
    const reviewer = discovery.reviewers[index]!;
    report.reviewerResults.push(result);
    report.blockingFindings.push(...result.blockingFindings);
    report.suggestions.push(...result.suggestions);
    report.questions.push(...result.questions);
    if (result.error) {
      report.harnessNotes.push(`reviewer ${reviewer.id} failed: ${result.error}`);
      markIncomplete(report, `reviewer ${reviewer.id} failed`);
    }
    if (result.workspaceStatus) {
      report.harnessNotes.push(`reviewer ${reviewer.id} left workspace changes: ${result.workspaceStatus}`);
    }
  }
  appendTestProofNotes(report);

  report.nextRoundRecommended =
    report.blockingFindings.length > 0 ||
    report.questions.length > 0 ||
    report.reviewerResults.some((result) => result.error) ||
    report.testProof?.status === "failed";
  return report;
}

function shouldBlockSandboxedReviewers(
  env: NodeJS.ProcessEnv,
  request: ReviewRequest,
  reviewers: Reviewer[],
): boolean {
  if (!env.CODEX_SANDBOX || reviewers.length === 0 || request.allowSandboxedReviewers) {
    return false;
  }
  // Block only on the one signal we can observe reliably: disabled network.
  // Reviewer auth is commonly OAuth/subscription state in the home directory,
  // so inferring usability from API-key env vars wrongly blocks the common case.
  // When a reviewer's auth is actually unavailable, the launch fails and is
  // surfaced as a reviewer error instead.
  return env.CODEX_SANDBOX_NETWORK_DISABLED === "1";
}

function sandboxReviewerBlockedNote(): string {
  return "reviewer launch blocked: Council is running inside a Codex sandbox with network disabled, so reviewer CLIs cannot reach their model backends. Rerun outside the sandbox. In Codex tool calls, use sandbox_permissions=require_escalated; from a shell, use codex --sandbox danger-full-access or --dangerously-bypass-approvals-and-sandbox only when you understand the risk. --allow-sandboxed-reviewers is an unconditional override.";
}

function authorNote(request: ReviewRequest): string {
  const source = request.authorSource ?? "unspecified";
  if (request.author) {
    return `authoring agent: ${request.author} (${source}); excluded from reviewers to prevent self-review`;
  }
  return `authoring agent: none (${source}); no reviewer auto-excluded — pass --author to guarantee no self-review`;
}

export function sandboxHarnessNotes(env: NodeJS.ProcessEnv): string[] {
  const sandbox = env.CODEX_SANDBOX;
  if (!sandbox) return [];
  const networkNote = env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? " with network disabled" : "";
  return [
    `running inside CODEX_SANDBOX=${sandbox}${networkNote}; reviewer CLIs run as local child processes and need their normal auth/home state and network access.`,
  ];
}

export function buildPrompt(input: PromptInput): string {
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

export function parseReviewerOutput(reviewer: string, output: string): ReviewerResult {
  const result: ReviewerResult = {
    reviewer,
    rawOutput: output,
    blockingFindings: [],
    suggestions: [],
    questions: [],
    pass: false,
  };
  let currentFinding: Finding | undefined;
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
      currentFinding = undefined;
    } else if (!line) {
      currentFinding = undefined;
    } else if (line && currentFinding) {
      currentFinding.text = `${currentFinding.text}\n${rawLine}`;
    }
  }
  return result;
}

function normalizeFindingLine(line: string): string {
  let normalized = line.replace(/^[-+*]\s+/, "").trim();
  normalized = normalized.replace(/^\d+[.)]\s+(?=(?:\*\*|__))/, "").trim();
  normalized = normalized.replace(/^>\s*/, "").trim();
  normalized = normalized.replace(
    /^(?:\*\*|__)(BLOCKER|SUGGESTION|QUESTION|PASS)(?::)?(?:\*\*|__):?\s*/i,
    (_match, prefix: string) => `${prefix.toUpperCase()}: `,
  );
  return stripSurroundingEmphasis(normalized).trim();
}

function stripSurroundingEmphasis(text: string): string {
  let result = text;
  for (const marker of ["**", "__"]) {
    if (result.startsWith(marker) && result.endsWith(marker)) {
      result = result.slice(marker.length, -marker.length);
    }
  }
  return result;
}

async function runOneReviewer(
  reviewer: Reviewer,
  request: ReviewRequest,
  artifact: string,
  diff: string,
  signal?: AbortSignal,
): Promise<ReviewerResult> {
  // prepareWorkspace can throw (e.g. a run-deadline abort during git setup), so
  // it must be inside the try: a throw here becomes a reviewer error result, not
  // a rejection that escapes Promise.all and crashes the whole run.
  let prepared: PreparedWorkspace | undefined;
  try {
    prepared = await prepareWorkspace({
      cwd: request.cwd,
      reviewerId: reviewer.id,
      artifactPath: request.artifactPath,
      signal,
    });
    const prompt = buildPrompt({
      artifactKind: artifactKind(request),
      artifact,
      diff,
      cwd: prepared.path,
      round: request.round,
      maxRounds: request.maxRounds,
      changeSummary: request.changeSummary,
    });
    const output = await runReviewer(reviewer, { cwd: prepared.path, prompt, timeoutMs: request.timeoutMs, signal });
    const result = parseReviewerOutput(reviewer.id, output);
    if (!hasUsableReviewerOutput(result)) {
      result.error = "no usable reviewer output; expected BLOCKER, SUGGESTION, QUESTION, or PASS";
    }
    if (prepared.note) {
      result.workspaceStatus = prepared.note;
    }
    // Status collection runs git commands that may be cancelled by the run
    // deadline; a failure here must not discard findings the reviewer produced.
    try {
      const status = await prepared.status();
      if (status) {
        result.workspaceStatus = [result.workspaceStatus, status].filter(Boolean).join("; ");
      }
    } catch (error) {
      result.workspaceStatus = [result.workspaceStatus, `status check failed: ${(error as Error).message}`]
        .filter(Boolean)
        .join("; ");
    }
    return result;
  } catch (error) {
    return {
      reviewer: reviewer.id,
      blockingFindings: [],
      suggestions: [],
      questions: [],
      pass: false,
      error: (error as Error).message,
    };
  } finally {
    if (prepared) await prepared.cleanup();
  }
}

async function readArtifact(request: ReviewRequest): Promise<string> {
  if (!request.artifactPath) return "";
  return readFile(request.artifactPath, "utf8");
}

export async function readReviewDiff(request: DiffReadRequest): Promise<DiffReadResult> {
  if (!request.includeDiff) return { diff: "", harnessNotes: [] };
  const git = (args: string[]): Promise<string> => gitStdout(request.cwd, args, request.signal);
  try {
    const mode = request.diffMode ?? "auto";
    if (mode === "local") {
      const diff = await git(["diff", "--binary", "HEAD", "--"]);
      const harnessNotes = ignoredBaseNotes(request, "--mode local");
      return diff ? { diff, harnessNotes } : { diff: "", harnessNotes: [...harnessNotes, "no diff found in local working tree"] };
    }
    if (mode === "commit") {
      if (!request.commitRef) {
        return { diff: "", harnessNotes: ["--mode commit requires --commit"] };
      }
      const diff = await git(["show", "--format=", "--binary", request.commitRef, "--"]);
      const harnessNotes = ignoredBaseNotes(request, `--commit ${request.commitRef}`);
      return diff ? { diff, harnessNotes } : { diff: "", harnessNotes: [...harnessNotes, `no diff found for commit ${request.commitRef}`] };
    }
    const dirtyDiff = await git(["diff", "--binary", "HEAD", "--"]);
    const baseRef = request.baseRef ?? (await readUpstreamRef(request.cwd, request.signal));
    if (mode === "branch" && !baseRef) {
      return { diff: "", harnessNotes: ["--mode branch requires --base or an upstream ref"] };
    }
    if (baseRef) {
      const mergeBase = await git(["merge-base", baseRef, "HEAD"]);
      const committedDiff = await git(["diff", "--binary", `${mergeBase}...HEAD`, "--"]);
      if (committedDiff && dirtyDiff) {
        return {
          diff: `${committedDiff}\n\n# ---- dirty working-tree changes ----\n${dirtyDiff}`,
          harnessNotes: [`diff includes committed changes against ${baseRef} and dirty working-tree changes`],
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
        harnessNotes: [`no diff found against ${baseRef}`],
      };
    }

    if (dirtyDiff) {
      return { diff: dirtyDiff, harnessNotes: [] };
    }

    return {
      diff: "",
      harnessNotes: ["no diff found; pass --base <ref> for committed branch review"],
    };
  } catch (error) {
    return {
      diff: "",
      harnessNotes: [`failed to read diff: ${(error as Error).message}`],
    };
  }
}

function ignoredBaseNotes(request: DiffReadRequest, target: string): string[] {
  return request.baseRef ? [`--base ${request.baseRef} ignored by ${target}`] : [];
}

async function runParallelTests(request: ReviewRequest, signal?: AbortSignal): Promise<TestProof> {
  const command = request.parallelTests!;
  try {
    const result = await runShellCommand(command, {
      cwd: request.cwd,
      timeoutMs: request.testTimeoutMs ?? request.timeoutMs,
      signal,
    });
    return {
      command,
      status: "passed",
      summary: summarizeOutput(result.stdout, result.stderr) || "command exited with code 0",
    };
  } catch (error) {
    return {
      command,
      status: "failed",
      summary: summarizeOutput("", (error as Error).message) || (error as Error).message.slice(0, 500),
    };
  }
}

function appendTestProofNotes(report: CouncilReport): void {
  if (report.testProof?.status === "failed") {
    report.harnessNotes.push(`parallel tests failed: ${report.testProof.summary}`);
    markIncomplete(report, "parallel tests failed");
  }
}

function markIncomplete(report: CouncilReport, reason: string): void {
  report.incomplete = true;
  if (!report.incompleteReasons.includes(reason)) {
    report.incompleteReasons.push(reason);
  }
}

function summarizeOutput(stdout: string, stderr: string): string {
  return [...lastNonEmptyLines(stdout, 2), ...lastNonEmptyLines(stderr, 2)].join(" | ").slice(0, 500);
}

function lastNonEmptyLines(output: string, count: number): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-count);
}

async function gitStdout(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  const { stdout } = await runProcess("git", args, { cwd, signal });
  return stdout.trimEnd();
}

async function readUpstreamRef(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    return await gitStdout(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], signal);
  } catch {
    return undefined;
  }
}

function hasUsableReviewerOutput(result: ReviewerResult): boolean {
  return (
    result.pass ||
    result.blockingFindings.length > 0 ||
    result.suggestions.length > 0 ||
    result.questions.length > 0 ||
    Boolean(result.error)
  );
}

function artifactKind(request: ReviewRequest): string {
  if (request.includeDiff) return "diff";
  const ext = path.extname(request.artifactPath ?? "").toLowerCase();
  if (ext === ".md" || ext === ".markdown") return "spec";
  return "unknown";
}

function artifactLabel(request: ReviewRequest): string {
  return request.includeDiff ? "git diff" : request.artifactPath ?? "";
}

function finding(reviewer: string, text: string): Finding {
  return { reviewer, text: cleanFindingText(text) };
}

function cleanFindingText(text: string): string {
  return stripSurroundingEmphasis(text.trim()).trim();
}

function pushFinding(target: Finding[], reviewer: string, text: string): Finding {
  const entry = finding(reviewer, text);
  target.push(entry);
  return entry;
}
