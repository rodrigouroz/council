import { readFile } from "node:fs/promises";
import path from "node:path";

import { discoverReviewers, runReviewer } from "./agents.ts";
import { runProcess } from "./process.ts";
import type { CouncilReport, Finding, ReviewRequest, Reviewer, ReviewerResult } from "./types.ts";
import { prepareWorkspace } from "./workspace.ts";

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
}

export async function runReview(request: ReviewRequest): Promise<CouncilReport> {
  const discovery = discoverReviewers();
  const report: CouncilReport = {
    round: request.round,
    maxRounds: request.maxRounds,
    artifact: artifactLabel(request),
    reviewers: discovery.reviewers.map((reviewer) => reviewer.id),
    blockingFindings: [],
    suggestions: [],
    questions: [],
    harnessNotes: [...discovery.warnings],
    reviewerResults: [],
    nextRoundRecommended: false,
  };

  const artifact = await readArtifact(request);
  const diff = await readReviewDiff(request);
  if (discovery.reviewers.length === 0) {
    report.harnessNotes.push("no reviewer agents available");
    return report;
  }

  const reviewerResults = await Promise.all(
    discovery.reviewers.map((reviewer) => runOneReviewer(reviewer, request, artifact, diff)),
  );
  for (const [index, result] of reviewerResults.entries()) {
    const reviewer = discovery.reviewers[index]!;
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
    const upper = line.toUpperCase();
    if (upper.startsWith("BLOCKER:")) {
      currentFinding = pushFinding(result.blockingFindings, reviewer, line.slice("BLOCKER:".length));
    } else if (upper.startsWith("SUGGESTION:")) {
      currentFinding = pushFinding(result.suggestions, reviewer, line.slice("SUGGESTION:".length));
    } else if (upper.startsWith("QUESTION:")) {
      currentFinding = pushFinding(result.questions, reviewer, line.slice("QUESTION:".length));
    } else if (upper.startsWith("PASS:")) {
      result.pass = true;
      currentFinding = undefined;
    } else if (line && currentFinding) {
      currentFinding.text = `${currentFinding.text}\n${rawLine}`;
    }
  }
  return result;
}

async function runOneReviewer(
  reviewer: Reviewer,
  request: ReviewRequest,
  artifact: string,
  diff: string,
): Promise<ReviewerResult> {
  const prepared = await prepareWorkspace({
    cwd: request.cwd,
    reviewerId: reviewer.id,
    artifactPath: request.artifactPath,
  });
  try {
    const prompt = buildPrompt({
      artifactKind: artifactKind(request),
      artifact,
      diff,
      cwd: prepared.path,
      round: request.round,
      maxRounds: request.maxRounds,
      changeSummary: request.changeSummary,
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
      error: (error as Error).message,
    };
  } finally {
    await prepared.cleanup();
  }
}

async function readArtifact(request: ReviewRequest): Promise<string> {
  if (!request.artifactPath) return "";
  return readFile(request.artifactPath, "utf8");
}

export async function readReviewDiff(request: DiffReadRequest): Promise<string> {
  if (!request.includeDiff) return "";
  try {
    const { stdout } = await runProcess("git", ["diff", "--binary", "HEAD", "--"], { cwd: request.cwd });
    return stdout;
  } catch {
    return "";
  }
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
  return { reviewer, text: text.trim() };
}

function pushFinding(target: Finding[], reviewer: string, text: string): Finding {
  const entry = finding(reviewer, text);
  target.push(entry);
  return entry;
}
