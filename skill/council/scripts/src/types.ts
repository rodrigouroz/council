export type Format = "markdown" | "json";
export type ReviewerId = "codex" | "claude";

export interface ReviewRequest {
  command: "review";
  cwd: string;
  artifactPath?: string;
  includeDiff: boolean;
  author?: ReviewerId;
  maxRounds: number;
  round: number;
  changeSummary: string;
  format: Format;
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
  nextRoundRecommended: boolean;
}
