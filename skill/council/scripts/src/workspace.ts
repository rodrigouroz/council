import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runProcess } from "./process.ts";

export interface PrepareWorkspaceRequest {
  cwd: string;
  reviewerId: string;
  artifactPath?: string;
}

export interface PreparedWorkspace {
  path: string;
  fallback: boolean;
  note?: string;
  status(): Promise<string>;
  cleanup(): Promise<void>;
}

export async function prepareWorkspace(request: PrepareWorkspaceRequest): Promise<PreparedWorkspace> {
  const root = await gitRoot(request.cwd);
  if (!root || !(await hasGitHead(root))) {
    return copyFallback(request, root ? "git repository has no HEAD" : "not inside a git repository");
  }

  const tmpRoot = await mkdtemp(path.join(tmpdir(), `council-${safeSegment(request.reviewerId)}-`));
  const worktreePath = path.join(tmpRoot, "repo");
  try {
    await runProcess("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], { cwd: root });
    await applyDirtyDiff(root, worktreePath);
    await copyUntracked(root, worktreePath);
    await copyArtifactIfNeeded(request.artifactPath, worktreePath);
    return {
      path: worktreePath,
      fallback: false,
      async status() {
        const { stdout } = await runProcess("git", ["status", "--porcelain=v1", "-uall"], { cwd: worktreePath });
        return stdout.trim();
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
    return copyFallback(request, `git worktree setup failed: ${(error as Error).message}`);
  }
}

async function gitRoot(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await runProcess("git", ["rev-parse", "--show-toplevel"], { cwd });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

async function hasGitHead(root: string): Promise<boolean> {
  try {
    await runProcess("git", ["rev-parse", "--verify", "HEAD"], { cwd: root });
    return true;
  } catch {
    return false;
  }
}

async function applyDirtyDiff(root: string, worktreePath: string): Promise<void> {
  const { stdout } = await runProcess("git", ["diff", "--binary", "HEAD", "--"], { cwd: root });
  if (!stdout.trim()) return;
  await runProcess("git", ["apply", "--binary", "--whitespace=nowarn"], { cwd: worktreePath, input: stdout });
}

async function copyUntracked(root: string, worktreePath: string): Promise<void> {
  const { stdout } = await runProcess("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root });
  for (const rel of stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    await copyFilePreservingDirs(path.join(root, rel), path.join(worktreePath, rel));
  }
}

async function copyArtifactIfNeeded(artifactPath: string | undefined, worktreePath: string): Promise<void> {
  if (!artifactPath) return;
  await copyFilePreservingDirs(artifactPath, path.join(worktreePath, ".council", "artifact.md"));
}

async function copyFallback(request: PrepareWorkspaceRequest, reason: string): Promise<PreparedWorkspace> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), `council-copy-${safeSegment(request.reviewerId)}-`));
  const workspacePath = path.join(tmpRoot, "repo");
  await cp(request.cwd, workspacePath, {
    recursive: true,
    filter: (source) => !shouldExcludeCopyPath(source),
  });
  await copyArtifactIfNeeded(request.artifactPath, workspacePath);
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
  return ![".git", "node_modules", ".next", "dist", "build", "coverage"].includes(base);
}

async function copyFilePreservingDirs(source: string, destination: string): Promise<void> {
  const sourceStat = await stat(source);
  if (sourceStat.isDirectory()) {
    await cp(source, destination, { recursive: true });
    return;
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, await readFile(source));
}

function safeSegment(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]/g, "-");
}
