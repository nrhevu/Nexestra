import type { WorkBrief } from "./contracts.js";

export function formatWorkBrief(brief?: WorkBrief): string {
  if (!brief) return "";
  return [
    `Current work brief (revision ${brief.revision}, ${brief.status}; work type: ${brief.kind}):`,
    `Title: ${brief.title}`,
    `Desired outcome: ${brief.outcome || "Not specified"}`,
    `Deliverables:\n${brief.deliverables.map((item) => `- ${item}`).join("\n") || "Not specified"}`,
    `Constraints: ${brief.constraints || "Not specified"}`,
    `Out of scope: ${brief.nonGoals || "Not specified"}`,
    `Success criteria:\n${brief.acceptanceCriteria.map((item) => `- ${item.behavior}\n  Check: ${item.verification}`).join("\n") || "Not specified"}`,
    `Open questions: ${brief.openQuestions || "None recorded"}`,
    "This brief is shared working context. Confirmation records agreement on scope; it does not grant tool permissions, start execution, or prove completion. Follow the user's current message when refining it.",
  ].join("\n\n");
}
