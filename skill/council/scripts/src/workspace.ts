import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runProcess } from "./process.ts";

export interface PrepareWorkspaceRequest {
  cwd: string;
  reviewerId: string;
  artifactPath?: string;
  signal?: AbortSignal;
}

export interface PreparedWorkspace {
  path: string;
  fallback: boolean;
  note?: string;
  status(): Promise<string>;
  cleanup(): Promise<void>;
}

export async function prepareWorkspace(request: PrepareWorkspaceRequest): Promise<PreparedWorkspace> {
  const signal = request.signal;
  const root = await gitRoot(request.cwd, signal);
  if (!root || !(await hasGitHead(root, signal))) {
    return copyFallback(request, root ? "git repository has no HEAD" : "not inside a git repository");
  }

  const tmpRoot = await mkdtemp(path.join(tmpdir(), `council-${safeSegment(request.reviewerId)}-`));
  const worktreePath = path.join(tmpRoot, "repo");
  try {
    await runProcess("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], { cwd: root, signal });
    await applyDirtyDiff(root, worktreePath, signal);
    await copyUntracked(root, worktreePath, signal);
    await copyArtifactIfNeeded(request.artifactPath, worktreePath, signal);
    // Snapshot the content Council itself produced (applied dirty diff, copied
    // untracked files, .council/artifact.md) as a git tree, so status() reports
    // any reviewer change on top of it — including further edits to files that
    // were already dirty or untracked, which a status-line baseline would hide.
    // Snapshot through throwaway index files (siblings of the worktree, removed
    // with tmpRoot) so the reviewer's real index is never staged — a reviewer
    // inspecting the workspace must still see the author's changes via git diff.
    const baselineIndex = path.join(tmpRoot, "baseline.index");
    const statusIndex = path.join(tmpRoot, "status.index");
    const baselineTree = await snapshotTree(worktreePath, baselineIndex, signal);
    return {
      path: worktreePath,
      fallback: false,
      async status() {
        return changesSinceTree(worktreePath, baselineTree, statusIndex, signal);
      },
      async cleanup() {
        try {
          await runProcess("git", ["worktree", "remove", "--force", worktreePath], { cwd: root });
        } finally {
          await rm(tmpRoot, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await rm(tmpRoot, { recursive: true, force: true });
    // A deadline abort during setup must not be masked by an unbounded
    // directory-copy fallback; propagate it so the run is recorded as cancelled.
    if (signal?.aborted) {
      throw error;
    }
    return copyFallback(request, `git worktree setup failed: ${(error as Error).message}`);
  }
}

async function gitRoot(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const { stdout } = await runProcess("git", ["rev-parse", "--show-toplevel"], { cwd, signal });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

async function hasGitHead(root: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await runProcess("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, signal });
    return true;
  } catch {
    return false;
  }
}

async function applyDirtyDiff(root: string, worktreePath: string, signal?: AbortSignal): Promise<void> {
  const { stdout } = await runProcess("git", ["diff", "--binary", "HEAD", "--"], { cwd: root, signal });
  if (!stdout.trim()) return;
  await runProcess("git", ["apply", "--binary", "--whitespace=nowarn"], { cwd: worktreePath, input: stdout, signal });
}

async function copyUntracked(root: string, worktreePath: string, signal?: AbortSignal): Promise<void> {
  const { stdout } = await runProcess("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root, signal });
  for (const rel of stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    throwIfAborted(signal);
    await copyFilePreservingDirs(path.join(root, rel), path.join(worktreePath, rel), signal);
  }
}

async function copyArtifactIfNeeded(
  artifactPath: string | undefined,
  worktreePath: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!artifactPath) return;
  throwIfAborted(signal);
  await copyFilePreservingDirs(artifactPath, path.join(worktreePath, ".council", "artifact.md"), signal);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("aborted");
  }
}

async function copyFallback(request: PrepareWorkspaceRequest, reason: string): Promise<PreparedWorkspace> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), `council-copy-${safeSegment(request.reviewerId)}-`));
  const workspacePath = path.join(tmpRoot, "repo");
  try {
    await cp(request.cwd, workspacePath, {
      recursive: true,
      // cp has no AbortSignal option, so bound the copy through the per-entry
      // filter: once the run deadline aborts, the next entry throws and cp stops.
      filter: (source) => {
        if (request.signal?.aborted) {
          throw new Error("aborted");
        }
        return source === request.cwd || !shouldExcludeCopyPath(source);
      },
    });
    await copyArtifactIfNeeded(request.artifactPath, workspacePath, request.signal);
  } catch (error) {
    // A failed/aborted copy must not leave a partial /tmp workspace behind.
    await rm(tmpRoot, { recursive: true, force: true });
    throw error;
  }
  return {
    path: workspacePath,
    fallback: true,
    note: `used directory-copy isolation fallback: ${reason}`,
    async status() {
      return "";
    },
    async cleanup() {
      await rm(tmpRoot, { recursive: true, force: true });
    },
  };
}

function shouldExcludeCopyPath(source: string): boolean {
  const base = path.basename(source);
  return [".git", "node_modules", ".next", "dist", "build", "coverage"].includes(base);
}

async function copyFilePreservingDirs(source: string, destination: string, signal?: AbortSignal): Promise<void> {
  const sourceStat = await stat(source);
  if (sourceStat.isDirectory()) {
    await cp(source, destination, {
      recursive: true,
      filter: (entry) => {
        if (signal?.aborted) {
          throw new Error("aborted");
        }
        return entry === source || !shouldExcludeCopyPath(entry);
      },
    });
    return;
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, await readFile(source));
}

// Capture the current worktree content as a git tree, using a throwaway index
// so the reviewer's real index stays untouched. Comparing against this tree
// later detects any content change, not just git status-line categories.
async function snapshotTree(cwd: string, indexFile: string, signal?: AbortSignal): Promise<string> {
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  await runProcess("git", ["add", "-A"], { cwd, env, signal });
  const { stdout } = await runProcess("git", ["write-tree"], { cwd, env, signal });
  return stdout.trim();
}

async function changesSinceTree(
  cwd: string,
  baselineTree: string,
  indexFile: string,
  signal?: AbortSignal,
): Promise<string> {
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  await runProcess("git", ["add", "-A"], { cwd, env, signal });
  const { stdout } = await runProcess("git", ["diff", "--cached", "--name-status", baselineTree], { cwd, env, signal });
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => line.replace(/\t/g, " "))
    .join("\n")
    .trim();
}

function safeSegment(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]/g, "-");
}
