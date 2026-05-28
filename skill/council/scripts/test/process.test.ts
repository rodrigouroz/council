import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_TIMEOUT_MS, runProcess } from "../src/process.ts";

test("runProcess defaults to a five minute timeout", () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 300_000);
});

test("runProcess rejects when the child exceeds the timeout", async () => {
  await assert.rejects(
    () =>
      runProcess(
        process.execPath,
        ["-e", "setTimeout(() => process.stdout.write('late'), 100)"],
        { cwd: process.cwd(), timeoutMs: 20 },
      ),
    /timed out after 20ms/,
  );
});
