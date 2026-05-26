import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { prepareWorkspace } from "../src/workspace.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "council-repo-"));
  await git(dir, ["init"]);
  await git(dir, ["config", "user.email", "council@example.test"]);
  await git(dir, ["config", "user.name", "Council Test"]);
  await writeFile(path.join(dir, "tracked.txt"), "base\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "initial"]);
  return dir;
}

test("prepareWorkspace applies tracked dirty diff", async () => {
  const repo = await initRepo();
  await writeFile(path.join(repo, "tracked.txt"), "changed\n");

  const prepared = await prepareWorkspace({ cwd: repo, reviewerId: "codex" });
  try {
    assert.equal(await readFile(path.join(prepared.path, "tracked.txt"), "utf8"), "changed\n");
    assert.equal(await readFile(path.join(repo, "tracked.txt"), "utf8"), "changed\n");
  } finally {
    await prepared.cleanup();
  }
});

test("prepareWorkspace copies untracked files", async () => {
  const repo = await initRepo();
  await writeFile(path.join(repo, "new.txt"), "new\n");

  const prepared = await prepareWorkspace({ cwd: repo, reviewerId: "claude" });
  try {
    assert.equal(await readFile(path.join(prepared.path, "new.txt"), "utf8"), "new\n");
  } finally {
    await prepared.cleanup();
  }
});

test("prepared workspace reports reviewer mutations without touching source", async () => {
  const repo = await initRepo();
  const prepared = await prepareWorkspace({ cwd: repo, reviewerId: "codex" });
  try {
    await writeFile(path.join(prepared.path, "tracked.txt"), "reviewer edit\n");
    const status = await prepared.status();
    assert.match(status, /M tracked.txt/);
    assert.equal(await readFile(path.join(repo, "tracked.txt"), "utf8"), "base\n");
  } finally {
    await prepared.cleanup();
  }
});

test("prepareWorkspace copy fallback copies source files and excludes generated directories", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "council-copy-source-"));
  await writeFile(path.join(dir, "source.txt"), "source\n");
  await mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });
  await writeFile(path.join(dir, "node_modules", "pkg", "ignored.txt"), "ignored\n");

  const prepared = await prepareWorkspace({ cwd: dir, reviewerId: "codex" });
  try {
    assert.equal(prepared.fallback, true);
    assert.equal(await readFile(path.join(prepared.path, "source.txt"), "utf8"), "source\n");
    await assert.rejects(() => readFile(path.join(prepared.path, "node_modules", "pkg", "ignored.txt"), "utf8"));
  } finally {
    await prepared.cleanup();
  }
});
