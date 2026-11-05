import type { Plan } from './approval.js';

export interface PlanMarkdownContext { runId: string; phase?: string | undefined; planHash: string; approved?: boolean | undefined }

// Plan text comes from a model: keep each list item on one line so it cannot open a new heading or list.
const inline = (text: string) => text.replace(/\r?\n+/g, ' ').trim();
const list = (items: string[], empty: string) => items.length ? items.map(item => `- ${inline(item)}`).join('\n') : `_${empty}_`;

/** Readable view of a plan for reviewers; the plan hash identifies exactly which version an approval would cover. */
export function renderPlanMarkdown(plan: Plan, context: PlanMarkdownContext): string {
  const lines = [
    `# Plan ${plan.planId} (v${plan.version})`, '',
    `- Run: \`${context.runId}\``,
    ...(context.phase ? [`- Phase: ${context.phase}`] : []),
    ...(context.approved === undefined ? [] : [`- Status: ${context.approved ? 'approved' : 'awaiting approval'}`]),
    `- Plan hash: \`${context.planHash}\``, '',
    '## Goal', '', plan.goal.trim(), '',
    '## Approach', '', plan.approach.trim(), '',
    '## Acceptance criteria', '', list(plan.acceptanceCriteria, 'None'), '',
    '## Checks', '', list(plan.checks, 'None'), '',
    '## Risks', '', list(plan.riskChanges, 'None'), '',
    '## Scope', '', list(plan.scope, 'None'),
  ];
  if (plan.workPackets?.length) {
    lines.push('', '## Work packets');
    for (const packet of plan.workPackets) lines.push('', `### ${packet.nodeId}`, '', inline(packet.goal), '', list(packet.scope, 'None'));
  }
  return lines.join('\n') + '\n';
}
