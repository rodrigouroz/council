import assert from "node:assert/strict";
import { test } from "node:test";

import { runProcess } from "../src/process.ts";

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
