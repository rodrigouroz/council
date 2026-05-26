import type { CouncilReport, Finding } from "./types.ts";

export function renderMarkdown(report: CouncilReport): string {
  const lines = [
    "# Council Review",
    "",
    "## Summary",
    `- round: ${report.round} of ${report.maxRounds}`,
    `- artifact: ${report.artifact}`,
    `- reviewers: ${report.reviewers.length > 0 ? report.reviewers.join(", ") : "none"}`,
    `- result: ${report.nextRoundRecommended ? "next round recommended" : "no blocking findings"}`,
    "",
    ...findingSection("Blocking Findings", report.blockingFindings),
    "",
    ...findingSection("Suggestions", report.suggestions),
    "",
    ...findingSection("Questions", report.questions),
    "",
    "## Reviewer Disagreements",
    "- None detected by the v1 harness.",
    "",
    "## Harness Notes",
    ...(report.harnessNotes.length > 0 ? report.harnessNotes.map((note) => `- ${note}`) : ["- None."]),
    "",
    "## Author Checklist",
    "- Accept, reject, or explain each blocking finding.",
    "- Re-run Council after meaningful changes while rounds remain.",
    "",
  ];
  return `${lines.join("\n")}`;
}

export function renderJson(report: CouncilReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function findingSection(title: string, findings: Finding[]): string[] {
  if (findings.length === 0) {
    return [`## ${title}`, "- None."];
  }
  return [`## ${title}`, ...findings.map((finding) => `- ${finding.reviewer}: ${finding.text}`)];
}
