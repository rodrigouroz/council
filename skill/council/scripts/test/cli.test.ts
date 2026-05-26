import assert from "node:assert/strict";
import { test } from "node:test";

import { parseArgs } from "../src/cli.ts";

test("parseArgs requires artifact or diff", () => {
  assert.throws(
    () => parseArgs(["review", "--cwd", "/tmp/repo"]),
    /review requires --artifact or --diff/,
  );
});

test("parseArgs rejects artifact and diff together", () => {
  assert.throws(
    () => parseArgs(["review", "--artifact", "SPEC.md", "--diff"]),
    /review accepts either --artifact or --diff, not both/,
  );
});

test("parseArgs applies defaults", () => {
  const parsed = parseArgs(["review", "--artifact", "SPEC.md"]);
  assert.equal(parsed.command, "review");
  assert.equal(parsed.artifactPath, "SPEC.md");
  assert.equal(parsed.includeDiff, false);
  assert.equal(parsed.maxRounds, 3);
  assert.equal(parsed.round, 1);
  assert.equal(parsed.format, "markdown");
  assert.ok(parsed.cwd.length > 0);
});

test("parseArgs rejects trailing positional arguments", () => {
  assert.throws(
    () => parseArgs(["review", "--artifact", "SPEC.md", "extra"]),
    /unexpected positional argument: extra/,
  );
});

test("parseArgs supports json shorthand", () => {
  const parsed = parseArgs(["review", "--diff", "--json"]);
  assert.equal(parsed.format, "json");
});
