import { accessSync, constants } from "node:fs";
import path from "node:path";

import { runProcess } from "./process.ts";
import type { Discovery, Reviewer, ReviewerId } from "./types.ts";

const supportedReviewers: Array<{ id: ReviewerId; executable: string }> = [
  { id: "codex", executable: "codex" },
  { id: "claude", executable: "claude" },
];

export interface RunReviewerRequest {
  cwd: string;
  prompt: string;
}

export function discoverReviewers(env: NodeJS.ProcessEnv = process.env): Discovery {
  const reviewers: Reviewer[] = [];
  const warnings: string[] = [];
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

export async function runReviewer(reviewer: Reviewer, request: RunReviewerRequest): Promise<string> {
  switch (reviewer.id) {
    case "codex":
      return runCodex(reviewer.executable, request);
    case "claude":
      return runClaude(reviewer.executable, request);
  }
}

function findExecutable(name: string, env: NodeJS.ProcessEnv): string | undefined {
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
        // Try the next path entry.
      }
    }
  }
  return undefined;
}

async function runCodex(executable: string, request: RunReviewerRequest): Promise<string> {
  const { stdout } = await runProcess(
    executable,
    ["exec", "--json", "--skip-git-repo-check", "--sandbox", "workspace-write"],
    { cwd: request.cwd, input: `${request.prompt}\n` },
  );
  return parseCodexOutput(stdout);
}

async function runClaude(executable: string, request: RunReviewerRequest): Promise<string> {
  const frame = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: request.prompt }],
    },
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
      "bypassPermissions",
    ],
    { cwd: request.cwd, input: `${frame}\n` },
  );
  return parseClaudeOutput(stdout);
}

function parseCodexOutput(stdout: string): string {
  const parts: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const frame = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string } };
      if (frame.type === "item.completed" && frame.item?.type === "agent_message" && frame.item.text) {
        parts.push(frame.item.text);
      }
    } catch {
      // Ignore non-JSON output.
    }
  }
  return parts.join("\n").trim();
}

function parseClaudeOutput(stdout: string): string {
  const parts: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const frame = JSON.parse(line) as {
        type?: string;
        message?: { content?: Array<{ type?: string; text?: string }> };
      };
      if (frame.type !== "assistant") continue;
      for (const block of frame.message?.content ?? []) {
        if (block.type === "text" && block.text) {
          parts.push(block.text);
        }
      }
    } catch {
      // Ignore non-JSON output.
    }
  }
  return parts.join("\n").trim();
}
