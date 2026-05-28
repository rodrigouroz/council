import { cwd as currentWorkingDirectory, env as processEnv } from "node:process";

import type { Format, ReviewerId, ReviewRequest } from "./types.ts";
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
        break;
      case "--base":
        request.baseRef = requireValue(rest, ++i, "--base");
        break;
      case "--timeout-ms":
        request.timeoutMs = parsePositiveInteger(requireValue(rest, ++i, "--timeout-ms"), "--timeout-ms");
        break;
      case "--author":
        request.author = parseAuthor(requireValue(rest, ++i, "--author"), "--author");
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

  request.author ??= parseAuthor(env.COUNCIL_AUTHOR_AGENT, "COUNCIL_AUTHOR_AGENT");
  validateRequest(request);
  return request;
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
}
