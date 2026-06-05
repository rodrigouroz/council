export type Format = "markdown" | "json";
export type DiffMode = "auto" | "local" | "branch" | "commit";
export type ReviewerId = "codex" | "claude";
export type TestProofStatus = "passed" | "failed";

export interface ReviewRequest {
  command: "review";
  cwd: string;
  artifactPath?: string;
  includeDiff: boolean;
  diffMode?: DiffMode;
  baseRef?: string;
  commitRef?: string;
  timeoutMs?: number;
  testTimeoutMs?: number;
  author?: ReviewerId;
  authorSource?: string;
  reviewers?: ReviewerId[];
  allowSandboxedReviewers?: boolean;
  parallelTests?: string;
  maxRounds: number;
  round: number;
  changeSummary: string;
  format: Format;
  reviewCommand?: string;
}

export interface Reviewer {
  id: ReviewerId;
  executable: string;
}

export interface Discovery {
  reviewers: Reviewer[];
  warnings: string[];
}

export interface Finding {
  reviewer: string;
  text: string;
}

export interface ReviewerResult {
  reviewer: string;
  rawOutput?: string;
  blockingFindings: Finding[];
  suggestions: Finding[];
  questions: Finding[];
  pass: boolean;
  error?: string;
  workspaceStatus?: string;
}

export interface CouncilReport {
  round: number;
  maxRounds: number;
  artifact: string;
  reviewers: string[];
  blockingFindings: Finding[];
  suggestions: Finding[];
  questions: Finding[];
  harnessNotes: string[];
  reviewerResults: ReviewerResult[];
  incomplete: boolean;
  incompleteReasons: string[];
  nextRoundRecommended: boolean;
  reviewCommand?: string;
  testProof?: TestProof;
}

export interface TestProof {
  command: string;
  status: TestProofStatus;
  summary: string;
}
