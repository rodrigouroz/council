import { cwd as currentWorkingDirectory, env as processEnv } from "node:process";

import type { DiffMode, Format, ReviewerId, ReviewRequest } from "./types.ts";
import { runReview } from "./review.ts";
import { renderJson, renderMarkdown } from "./report.ts";

export function parseArgs(args: string[], env: NodeJS.ProcessEnv = processEnv): ReviewRequest {
  const [command, ...rest] = args;
  if (command !== "review") {
    throw new Error("usage: council review --artifact PATH --cwd PATH");
  }

  const request: ReviewRequest = {
    command: "review",
    cwd: currentWorkingDirectory(),
    includeDiff: false,
    maxRounds: 3,
    round: 1,
    changeSummary: "",
    format: "markdown",
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
      case "--run-timeout-ms":
        request.runTimeoutMs = parsePositiveInteger(requireValue(rest, ++i, "--run-timeout-ms"), "--run-timeout-ms");
        break;
      case "--author":
        request.author = parseAuthor(requireValue(rest, ++i, "--author"), "--author");
        break;
      case "--reviewers":
        request.reviewers = parseReviewers(requireValue(rest, ++i, "--reviewers"));
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

export interface ResolvedAuthor {
  author?: ReviewerId;
  source: string;
}

/**
 * Resolve the authoring agent so Council never reviews itself, regardless of
 * caller. Precedence: explicit --author flag > COUNCIL_AUTHOR_AGENT > env
 * auto-detect. Auto-detect is deterministic when markers collide: the codex CLI
 * exports CODEX_SANDBOX for its own child process tree, so a helper launched
 * under codex can see both CODEX_SANDBOX and CLAUDECODE; CODEX_SANDBOX wins.
 */
export function resolveAuthor(flagAuthor: ReviewerId | undefined, env: NodeJS.ProcessEnv): ResolvedAuthor {
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
  return { author: undefined, source: "no authoring agent detected" };
}

export async function runCli(args: string[]): Promise<string> {
  const request = parseArgs(args);
  const report = await runReview(request);
  return request.format === "json" ? renderJson(report) : renderMarkdown(report);
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be at least 1`);
  }
  return parsed;
}

function parseFormat(value: string): Format {
  if (value === "markdown" || value === "json") {
    return value;
  }
  throw new Error("--format must be markdown or json");
}

function parseDiffMode(value: string): DiffMode {
  if (value === "auto" || value === "local" || value === "branch" || value === "commit") {
    return value;
  }
  throw new Error("--mode must be auto, local, branch, or commit");
}

function parseAuthor(value: string | undefined, source: string): ReviewerId | undefined {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === "") {
    return undefined;
  }
  if (normalized === "codex" || normalized === "claude") {
    return normalized;
  }
  throw new Error(`${source} must be codex or claude`);
}

function parseReviewers(value: string): ReviewerId[] {
  let parsed: ReviewerId[];
  try {
    parsed = value
      .split(",")
      .map((entry) => parseAuthor(entry, "--reviewers"))
      .filter((entry): entry is ReviewerId => entry !== undefined);
  } catch {
    throw new Error("--reviewers must contain codex or claude");
  }
  if (parsed.length === 0) {
    throw new Error("--reviewers must contain codex or claude");
  }
  return [...new Set(parsed)];
}

function validateRequest(request: ReviewRequest): void {
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

function commandLine(args: string[]): string {
  return `council ${args.map(shellToken).join(" ")}`;
}

function shellToken(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}
