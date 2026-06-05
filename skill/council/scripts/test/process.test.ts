import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { DEFAULT_TIMEOUT_MS, runProcess, runShellCommand } from "../src/process.ts";

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

test("runProcess includes stdout diagnostics when stderr is empty", async () => {
  await assert.rejects(
    () =>
      runProcess(
        process.execPath,
        ["-e", "console.log('Not logged in'); process.exit(1)"],
        { cwd: process.cwd() },
      ),
    /Not logged in/,
  );
});

test("runProcess rejects with aborted when its signal fires", async () => {
  const controller = new AbortController();
  const pending = runProcess(
    process.execPath,
    ["-e", "setTimeout(() => {}, 5000)"],
    { cwd: process.cwd(), signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, /aborted/);
});

test("aborting a shell command kills the whole process group", async (t) => {
  if (process.platform === "win32") {
    t.skip("process-group kill is POSIX-only");
    return;
  }
  const dir = await mkdtemp(path.join(tmpdir(), "council-group-kill-"));
  const marker = path.join(dir, "grandchild.txt");
  // The shell backgrounds a grandchild that writes the marker after 0.6s, then
  // the shell stays alive. Killing only the shell would orphan the grandchild;
  // a process-group kill must take the grandchild with it.
  const command = `sleep 0.6 && touch ${JSON.stringify(marker)} & sleep 5`;
  const controller = new AbortController();
  const pending = runShellCommand(command, { cwd: dir, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, /aborted/);
  await delay(900);
  await assert.rejects(() => readFile(marker, "utf8"));
});
