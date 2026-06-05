import assert from "node:assert/strict";
import { test } from "node:test";

import { parseArgs, resolveAuthor } from "../src/cli.ts";

test("parseArgs requires artifact or diff", () => {
  assert.throws(
    () => parseArgs(["review", "--cwd", "/tmp/repo"], {}),
    /review requires --artifact or --diff/,
  );
});

test("parseArgs rejects artifact and diff together", () => {
  assert.throws(
    () => parseArgs(["review", "--artifact", "SPEC.md", "--diff"], {}),
    /review accepts either --artifact or --diff, not both/,
  );
});

test("parseArgs applies defaults", () => {
  const parsed = parseArgs(["review", "--artifact", "SPEC.md"], {});
  assert.equal(parsed.command, "review");
  assert.equal(parsed.artifactPath, "SPEC.md");
  assert.equal(parsed.includeDiff, false);
  assert.equal(parsed.author, undefined);
  assert.equal(parsed.maxRounds, 3);
  assert.equal(parsed.round, 1);
  assert.equal(parsed.format, "markdown");
  assert.ok(parsed.cwd.length > 0);
});

test("parseArgs rejects trailing positional arguments", () => {
  assert.throws(
    () => parseArgs(["review", "--artifact", "SPEC.md", "extra"], {}),
    /unexpected positional argument: extra/,
  );
});

test("parseArgs supports json shorthand", () => {
  const parsed = parseArgs(["review", "--diff", "--json"], {});
  assert.equal(parsed.format, "json");
});

test("parseArgs supports explicit author", () => {
  const parsed = parseArgs(["review", "--diff", "--author", "codex"], {});
  assert.equal(parsed.author, "codex");
});

test("parseArgs supports base ref and timeout override", () => {
  const parsed = parseArgs(["review", "--diff", "--base", "origin/main", "--timeout-ms", "30000"], {});
  assert.equal(parsed.baseRef, "origin/main");
  assert.equal(parsed.timeoutMs, 30000);
});

test("parseArgs supports explicit diff modes", () => {
  const parsed = parseArgs(["review", "--mode", "branch", "--base", "origin/main"], {});
  assert.equal(parsed.includeDiff, true);
  assert.equal(parsed.diffMode, "branch");
  assert.equal(parsed.baseRef, "origin/main");
});

test("parseArgs allows branch mode to use an upstream ref fallback", () => {
  const parsed = parseArgs(["review", "--mode", "branch"], {});
  assert.equal(parsed.includeDiff, true);
  assert.equal(parsed.diffMode, "branch");
  assert.equal(parsed.baseRef, undefined);
});

test("parseArgs supports commit review shorthand", () => {
  const parsed = parseArgs(["review", "--commit", "HEAD"], {});
  assert.equal(parsed.includeDiff, true);
  assert.equal(parsed.diffMode, "commit");
  assert.equal(parsed.commitRef, "HEAD");
});

test("parseArgs rejects commit mode without a commit ref", () => {
  assert.throws(
    () => parseArgs(["review", "--mode", "commit"], {}),
    /--mode commit requires --commit/,
  );
});

test("parseArgs supports reviewer selection", () => {
  const selected = parseArgs(["review", "--diff", "--reviewers", "claude,codex"], {});
  assert.deepEqual(selected.reviewers, ["claude", "codex"]);
});

test("parseArgs rejects the removed --panel flag", () => {
  assert.throws(() => parseArgs(["review", "--diff", "--panel"], {}), /unknown option: --panel/);
});

test("parseArgs rejects unknown reviewers", () => {
  assert.throws(
    () => parseArgs(["review", "--diff", "--reviewers", "gemini"], {}),
    /--reviewers must contain codex or claude/,
  );
});

test("parseArgs supports parallel test command", () => {
  const parsed = parseArgs(["review", "--diff", "--parallel-tests", "npm test"], {});
  assert.equal(parsed.parallelTests, "npm test");
});

test("parseArgs supports explicitly allowing sandboxed reviewers", () => {
  const parsed = parseArgs(["review", "--diff", "--allow-sandboxed-reviewers"], {});
  assert.equal(parsed.allowSandboxedReviewers, true);
});

test("parseArgs supports independent parallel test timeout", () => {
  const parsed = parseArgs(["review", "--diff", "--timeout-ms", "600000", "--test-timeout-ms", "30000"], {});
  assert.equal(parsed.timeoutMs, 600000);
  assert.equal(parsed.testTimeoutMs, 30000);
});

test("parseArgs rejects invalid timeout", () => {
  assert.throws(
    () => parseArgs(["review", "--diff", "--timeout-ms", "0"], {}),
    /--timeout-ms must be at least 1/,
  );
});

test("parseArgs reads author from environment when flag is omitted", () => {
  const parsed = parseArgs(["review", "--diff"], { COUNCIL_AUTHOR_AGENT: "claude" });
  assert.equal(parsed.author, "claude");
  assert.equal(parsed.authorSource, "COUNCIL_AUTHOR_AGENT");
});

test("resolveAuthor prefers the explicit flag over everything", () => {
  const resolved = resolveAuthor("claude", { COUNCIL_AUTHOR_AGENT: "codex", CODEX_SANDBOX: "seatbelt" });
  assert.equal(resolved.author, "claude");
  assert.equal(resolved.source, "--author flag");
});

test("resolveAuthor falls back to COUNCIL_AUTHOR_AGENT", () => {
  const resolved = resolveAuthor(undefined, { COUNCIL_AUTHOR_AGENT: "codex" });
  assert.equal(resolved.author, "codex");
  assert.equal(resolved.source, "COUNCIL_AUTHOR_AGENT");
});

test("resolveAuthor auto-detects claude from CLAUDECODE", () => {
  const resolved = resolveAuthor(undefined, { CLAUDECODE: "1" });
  assert.equal(resolved.author, "claude");
  assert.match(resolved.source, /CLAUDECODE/);
});

test("resolveAuthor auto-detects codex from CODEX_SANDBOX", () => {
  const resolved = resolveAuthor(undefined, { CODEX_SANDBOX: "seatbelt" });
  assert.equal(resolved.author, "codex");
  assert.match(resolved.source, /CODEX_SANDBOX/);
});

test("resolveAuthor resolves codex deterministically when both markers are present", () => {
  const resolved = resolveAuthor(undefined, { CLAUDECODE: "1", CODEX_SANDBOX: "seatbelt" });
  assert.equal(resolved.author, "codex");
});

test("resolveAuthor leaves author undefined when no marker is present", () => {
  const resolved = resolveAuthor(undefined, {});
  assert.equal(resolved.author, undefined);
  assert.match(resolved.source, /no authoring agent detected/);
});

test("parseArgs trims author values", () => {
  const parsed = parseArgs(["review", "--diff", "--author", " codex "], {});
  assert.equal(parsed.author, "codex");
});

test("parseArgs rejects invalid author", () => {
  assert.throws(
    () => parseArgs(["review", "--diff", "--author", "gemini"], {}),
    /--author must be codex or claude/,
  );
});
