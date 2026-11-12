import { flowSchema, projectPolicySchema, type Flow, type ProjectPolicy } from './schema.js';
import path from 'node:path';
import { templates } from './templates.js';

/** Omitted `severity` means `error`: only errors make a flow invalid; warnings never block publish or start. */
export interface Diagnostic { code: string; message: string; nodeId?: string; severity?: 'error' | 'warning' }
export type Compilation =
  | { ok: true; flow: Flow; order: string[]; warnings?: Diagnostic[] }
  | { ok: false; diagnostics: Diagnostic[]; warnings?: Diagnostic[] };

// Phrases that ask an agent to run something; only Codex sessions have a shell.
export const runsCommands = /\bre-?run\b|\b(?:run|execute)\s+(?:(?:all|the|these|those|your|own|it|them|every)\s+)*(?:unit\s+)?(?:tests?|test\s+suite|checks?|commands?|builds?|programs?|scripts?|code|pytest|npm|python|node)\b|\bchạy\s+(?:lại\s+)?(?:các\s+|những\s+)?(?:test|lệnh|kiểm thử|chương trình)/i;
export const bomInstruction = /\b(?:without|no)\s+(?:a\s+)?BOM\b|\bBOM-?less\b|không\s+(?:có\s+)?BOM\b/i;
const writesFile = /\b(?:write|save|store|export)\b[^.;\n]{0,40}?\b(?:to|into|in|as)\s+(?:a\s+|an\s+|the\s+)?(?:[\w./-]+\.(?:md|json|txt|csv|html|ya?ml)\b|(?:markdown\s+|report\s+|output\s+)?file\b)|(?:^|\s)(?:ghi|lưu|xuất)\s[^.;\n]{0,30}?(?:ra|vào)\s+(?:một\s+)?(?:file|tệp)/i;
/** One argument of a plan or review check: checks run as argv without a shell. */
export const simpleCheckArg = /^[A-Za-z0-9_./:=+,%@-]+$/;

// `<word>` placeholders; tags an instruction may quote as HTML or markdown are not placeholders.
const placeholder = /<([A-Za-z][\w-]*)>/g;
const htmlTags = new Set(['a', 'b', 'i', 'u', 'p', 'br', 'hr', 'em', 'strong', 'code', 'pre', 'kbd', 'div', 'span', 'img', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'sup', 'sub', 'details', 'summary', 'blockquote', 'html', 'head', 'body', 'script', 'style']);
/** The sentence that starts at `index`: up to a line end, or a period or semicolon followed by a capitalised word. */
function sentenceAt(text: string, index: number): string {
  const rest = text.slice(index, index + 400), end = rest.search(/\n|[.;!?](?=\s+[A-Z])/);
  return end < 0 ? rest : rest.slice(0, end);
}
/** Inline code blanked out, so words inside a command (`git diff --check`) do not start a sentence. */
const withoutCode = (text: string) => text.replace(/`[^`\n]*`/g, code => ' '.repeat(code.length));
/** The whitespace-, quote- or bracket-delimited token around `index`. */
function tokenAt(text: string, index: number): string {
  const stop = /[\s`'"()[\]]/;
  let start = index, end = index;
  while (start > 0 && !stop.test(text[start - 1]!)) start--;
  while (end < text.length && !stop.test(text[end]!)) end++;
  return text.slice(start, end).replace(/[,;:.]+$/, '');
}
/**
 * A check a plan step may copy that cannot run as argv: a `<word>` placeholder inside a path (`c/<topic>/…`,
 * `<id>_<slug>`) or inline code anywhere in the text, or an inline-code command that is not plain argv (pipe, redirect,
 * quote, `&&`) or an unquoted `&&`/`||` in a sentence about checks. Heuristic: placeholders standing alone in prose
 * and commands outside backticks in other sentences are not seen.
 */
export function planCheckProblem(text: string): string | undefined {
  for (const match of text.matchAll(placeholder)) {
    if (htmlTags.has(match[1]!.toLowerCase())) continue;
    const before = text[match.index - 1] ?? '', after = text.slice(match.index + match[0].length, match.index + match[0].length + 2);
    if (/[/\\_.-]/.test(before) || /^[/\\_-]|^\.[A-Za-z0-9]/.test(after)) return `the placeholder path "${tokenAt(text, match.index)}"`;
  }
  for (const code of text.matchAll(/`([^`\n]+)`/g)) {
    // Only code that looks like a command or path: `Array<string>` is a type, not a placeholder.
    if (/[\s/]/.test(code[1]!) && [...code[1]!.matchAll(placeholder)].some(item => !htmlTags.has(item[1]!.toLowerCase()))) return `the placeholder in \`${code[1]}\``;
  }
  for (const word of withoutCode(text).matchAll(/(?<![\p{L}\p{N}_-])(?:checks?|kiểm tra)(?![\p{L}\p{N}_])/giu)) {
    const sentence = sentenceAt(text, word.index);
    for (const code of sentence.matchAll(/`([^`\n]+)`/g)) if (code[1]!.trim().split(/\s+/).some(arg => !simpleCheckArg.test(arg))) return `the check \`${code[1]}\``;
    const shell = sentence.replace(/`[^`\n]*`/g, '').match(/\S*(?:&&|\|\|)\S*/);
    if (shell) return `"${shell[0]}" in "${sentence.slice(0, 80)}"`;
  }
  return undefined;
}
export const planCheckAdvice = 'Plan checks run as argv without a shell (each argument only letters, digits and _ . / : = + , % @ -), so a placeholder, pipe, redirect, quote or && cannot run and automatic approval leaves the run waiting. Ask the plan to list checks with the concrete paths filled in, and give a concrete example in the goal (e.g. `gcc -std=c11 -fsyntax-only c/two-pointers/0125_valid-palindrome/test.c`).';

const isRootScope = (scope: string) => ['.', './', ''].includes(scope.trim());
const scopeWords = /(?<![\p{L}\p{N}_])(?:scopes?|phạm vi)(?![\p{L}\p{N}_])/giu;
/**
 * Whether the text names a directory inside one of `scopes` (the scope itself or a path below it) where it talks about
 * scope: in a sentence starting with "scope" when it has one, anywhere otherwise. A path counts only as a whole token,
 * so `c` matches `c`, `c/` and `c/two-pointers` but not `cpp/` or `c/<topic>/`.
 */
export function namesScopeWithin(text: string, scopes: readonly string[]): boolean {
  const patterns = scopes.map(scope => new RegExp(`(?<![\\w./<>\\\\-])${scope.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:/[\\w.-]+)*/?(?![\\w./<>\\\\-])`));
  const sentences = [...withoutCode(text).matchAll(scopeWords)].map(match => sentenceAt(text, match.index));
  return (sentences.length ? sentences : [text]).some(sentence => patterns.some(pattern => pattern.test(sentence)));
}

/** Text an author wrote for the flow or one step: the places agents take instructions from. */
function authoredText(flow: Flow): { nodeId?: string; text: string }[] {
  const texts: { nodeId?: string; text: string }[] = [{ text: `${flow.name}\n${flow.description}\n${flow.definition.outputContract}` }];
  for (const node of flow.definition.nodes) {
    const parts = node.type === 'agent_task' ? [node.goal, node.instructionsOverride ?? ''] : node.type === 'integration' ? [node.instructionsOverride ?? '']
      : node.type === 'approval' ? [node.purpose] : node.type === 'review_group' ? [...node.criteria, ...node.reviewers.map(reviewer => reviewer.instructionsOverride ?? '')] : [];
    if (parts.some(Boolean)) texts.push({ nodeId: node.id, text: parts.join('\n') });
  }
  return texts;
}

/**
 * Rules learned from runs that failed after a clean validation. They apply only while a flow is authored (validate,
 * draft, publish) so versions published before them still start; warnings point at likely mistakes without blocking.
 */
function authoringRules(flow: Flow, incoming: Map<string, string[]>, issue: (code: string, message: string, nodeId?: string) => void, warn: (code: string, message: string, nodeId?: string) => void) {
  const byId = new Map(flow.definition.nodes.map(node => [node.id, node]));
  const isPlan = (id: string) => { const node = byId.get(id); return node?.type === 'agent_task' && node.outputContract === 'plan'; };
  for (const node of flow.definition.nodes) {
    // A plan is recorded without a file baseline, so its review blocks with "no execution baseline to review".
    if (node.type === 'review_group' && isPlan(node.targetNodeId)) issue('review_target_plan', `Review target ${node.targetNodeId} is a plan step, which leaves nothing to review. Target the step that writes files or produces the report.`, node.id);
    // Automatic approval approves the plan of its direct predecessor; anything else waits for the user forever.
    if (node.type === 'approval' && node.mode === 'auto' && !(incoming.get(node.id) ?? []).some(isPlan)) issue('auto_approval_without_plan', 'Automatic approval needs an agent step with outputContract "plan" directly before it (plan → approval → implement, as in Fast).', node.id);
  }
  const texts = authoredText(flow);
  for (const { nodeId, text } of texts) {
    if (bomInstruction.test(text)) warn('bom_instruction', 'Asking for "UTF-8 without BOM" made an agent write the system code page on Windows. Say "keep non-ASCII characters intact (UTF-8)" instead.', nodeId);
  }
  const writes = flow.definition.nodes.some(node => node.type === 'integration' || (node.type === 'agent_task' && node.permissions.write));
  const fileAsk = writes ? undefined : texts.find(item => writesFile.test(item.text));
  if (fileAsk) warn('read_only_output_file', 'The flow asks for a file but no step may write one: the result only exists in the run transcript. Add a write step with a narrow writeScopes, or drop the file request.', fileAsk.nodeId);

  const outgoing = new Map<string, string[]>();
  for (const edge of flow.definition.edges) outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  for (const plan of flow.definition.nodes) {
    if (plan.type !== 'agent_task' || plan.outputContract !== 'plan') continue;
    const text = `${plan.goal}\n${plan.instructionsOverride ?? ''}`, problem = planCheckProblem(text);
    // A plan check is parsed as argv before approval; one that is not plain argv blocks automatic approval.
    if (problem) warn('plan_check_placeholder', `Plan step ${plan.id} may copy ${problem} into its checks. ${planCheckAdvice}`, plan.id);
    // Writers claim the approved plan scope, which must lie inside their writeScopes (else "Writer … lacks a valid declared scope").
    const narrow: { id: string; scopes: string[] }[] = [], seen = new Set<string>(), queue = [...(outgoing.get(plan.id) ?? [])];
    while (queue.length) {
      const id = queue.shift()!, node = byId.get(id);
      if (seen.has(id) || !node) continue;
      seen.add(id); queue.push(...(outgoing.get(id) ?? []));
      const scopes = node.type === 'integration' || (node.type === 'agent_task' && node.permissions.write) ? node.writeScopes : [];
      if (scopes.length && !scopes.some(isRootScope) && !namesScopeWithin(text, scopes)) narrow.push({ id, scopes });
    }
    if (narrow.length) warn('plan_scope_outside_write_scope', `Plan step ${plan.id} does not name a scope inside ${narrow.map(item => `writer ${item.id}'s writeScopes (${item.scopes.join(', ')})`).join(' or ')}. A plan scope outside them stops the writer ("Writer ${narrow[0]!.id} lacks a valid declared scope"), and one that is not an existing directory blocks approval. Pin the plan scope in the goal to an existing directory inside writeScopes, e.g. "Scope: exactly \`${narrow[0]!.scopes[0]}\`".`, plan.id);
  }
}

/** Validate a persisted graph before it can be published or dispatched. `authoring` adds the rules for flows being edited. */
export function compileFlow(input: unknown, policyInput: unknown, options: { legacyExceptions?: boolean; aiAuthored?: boolean; authoring?: boolean } = {}): Compilation {
  const parsed = flowSchema.safeParse(input);
  const parsedPolicy = projectPolicySchema.safeParse(policyInput);
  if (!parsed.success || !parsedPolicy.success) {
    const diagnostics: Diagnostic[] = [];
    if (!parsed.success) diagnostics.push(...parsed.error.issues.map(i => ({ code: 'schema', message: `${i.path.join('.')}: ${i.message}` })));
    if (!parsedPolicy.success) diagnostics.push(...parsedPolicy.error.issues.map(i => ({ code: 'policy_schema', message: `${i.path.join('.')}: ${i.message}` })));
    return { ok: false, diagnostics };
  }
  const flow = parsed.data;
  const policy: ProjectPolicy = parsedPolicy.data;
  const { nodes, edges, startNodeId, limits, bindings, sessionGroups } = flow.definition;
  const diagnostics: Diagnostic[] = [];
  const issue = (code: string, message: string, nodeId?: string) => {
    diagnostics.push(nodeId === undefined ? { code, message } : { code, message, nodeId });
  };
  // A flow reviewed by the user outside the flow has no review gate; the project policy can forbid that exception.
  const humanReview = flow.definition.review === 'human';
  if (humanReview && (policy.allowHumanReview === false || (!options.legacyExceptions && policy.requireIndependentReviewForCode && policy.allowHumanReview !== true))) issue('human_review_denied', 'Project policy requires independent review; explicitly allow human review to use this flow.');
  const requireReview = policy.requireIndependentReviewForCode && !humanReview;
  const byId = new Map(nodes.map(n => [n.id, n]));
  if (byId.size !== nodes.length) issue('duplicate_node', 'Node IDs must be unique.');
  const groups = new Map(sessionGroups.map(g => [g.id, g]));
  if (groups.size !== sessionGroups.length) issue('duplicate_session_group', 'Session group IDs must be unique.');
  for (const group of sessionGroups) if (!(group.bindingId in bindings)) issue('missing_binding', `Session group ${group.id} refers to a missing binding.`);
  if (nodes.filter(n => n.type === 'start').length !== 1 || byId.get(startNodeId)?.type !== 'start') issue('invalid_start', 'Exactly one start node must match startNodeId.');
  if (!nodes.some(n => n.type === 'finish')) issue('missing_finish', 'At least one finish node is required.');
  if (limits.maxConcurrency > policy.maxConcurrency) issue('concurrency_limit', 'Flow concurrency exceeds project policy.');
  if (limits.maxRepairRounds > policy.maxRepairRounds) issue('repair_limit', 'Flow repair budget exceeds project policy.');
  if (options.aiAuthored && limits.activeTimeSeconds > Math.min(templates.dev.definition.limits.activeTimeSeconds, policy.maxActiveTimeSeconds ?? Infinity)) issue('ai_limit_exceeded', 'AI-authored flow time exceeds the project or Dev limit.');

  const outgoing = new Map(nodes.map(n => [n.id, [] as string[]]));
  const incoming = new Map(nodes.map(n => [n.id, [] as string[]]));
  const seenEdges = new Set<string>();
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) { issue('missing_edge_node', `Edge ${edge.from} → ${edge.to} refers to a missing node.`); continue; }
    const key = JSON.stringify(edge);
    if (seenEdges.has(key)) issue('duplicate_edge', `Duplicate edge ${edge.from} → ${edge.to}.`);
    seenEdges.add(key);
    outgoing.get(edge.from)?.push(edge.to);
    incoming.get(edge.to)?.push(edge.from);
    if (byId.get(edge.from)?.type === 'finish') issue('edge_after_finish', 'A finish node cannot have outgoing edges.', edge.from);
    if (byId.get(edge.to)?.type === 'start') issue('edge_before_start', 'The start node cannot have incoming edges.', edge.to);
  }
  for (const node of nodes) {
    if (node.type !== 'finish' && (outgoing.get(node.id)?.length ?? 0) === 0) issue('dead_end', 'Non-finish node has no outgoing edge.', node.id);
    if (node.type === 'agent_task') {
      const group = groups.get(node.sessionGroup);
      if (!(node.bindingId in bindings) || !group || group.bindingId !== node.bindingId) issue('invalid_binding', 'Task binding and session group must exist and agree.', node.id);
      if (node.permissions.write && node.writeScopes.length === 0) issue('missing_write_scope', 'Writer must declare a write scope.', node.id);
      if (!node.permissions.write && node.writeScopes.length > 0) issue('unexpected_write_scope', 'Read-only task cannot declare write scopes.', node.id);
      if (node.permissions.gitCommit) issue('agent_commit_forbidden', 'Only a core-controlled git_commit node can commit.', node.id);
    }
    if (node.type === 'integration') {
      const agentFields = [node.profileId, node.profileVersion, node.sessionGroup, node.bindingId];
      if (agentFields.some(value => value !== undefined) && agentFields.some(value => value === undefined)) issue('incomplete_integration_agent', 'Integration agent needs profile, version, session group and binding together.', node.id);
      const group = node.sessionGroup ? groups.get(node.sessionGroup) : undefined;
      if (node.bindingId && (!(node.bindingId in bindings) || !group || group.bindingId !== node.bindingId)) issue('invalid_binding', 'Integration binding and session group must exist and agree.', node.id);
    }
    if (node.type === 'agent_task' || node.type === 'integration') {
      for (const scope of node.writeScopes) {
        const normalized = scope.replaceAll('\\', '/');
        if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(scope) || /^[A-Za-z]:/.test(scope) || normalized.split('/').includes('..')) {
          issue('invalid_write_scope', 'Write scope must be workspace-relative and must not traverse parents.', node.id);
        }
      }
    }
    if (node.type === 'git_commit' && !policy.allowGitCommit) issue('permission_denied', 'Git commit exceeds project policy.', node.id);
    if (node.type === 'git_commit' && humanReview) issue('human_review_commit', 'A flow reviewed by the user outside the flow cannot commit; the user applies its changes.', node.id);
    if (node.type === 'approval' && node.mode === 'auto' && (policy.allowAutoApproval === false || (!options.legacyExceptions && policy.requireApprovalBeforeWrite && policy.allowAutoApproval !== true))) issue('auto_approval_denied', 'Project policy requires user approval; explicitly allow automatic approval to use this flow.', node.id);
    if (node.type === 'review_group') {
      const target = byId.get(node.targetNodeId);
      if (!target || !['agent_task', 'integration'].includes(target.type)) issue('invalid_review_target', 'Review target must be an agent task or integration node.', node.id);
      if (policy.requireIndependentReviewForCode && !node.reviewers.some(r => r.required)) issue('missing_required_reviewer', 'Review group needs a required reviewer.', node.id);
      if (new Set(node.reviewers.map(r => r.id)).size !== node.reviewers.length) issue('duplicate_reviewer', 'Reviewer IDs must be unique within a review group.', node.id);
      if (new Set(node.reviewers.map(r => r.sessionGroup)).size !== node.reviewers.length) issue('shared_reviewer_session', 'Reviewers must use separate session groups.', node.id);
      for (const reviewer of node.reviewers) {
        if (!groups.has(reviewer.sessionGroup)) issue('missing_session_group', 'Reviewer session group is missing.', node.id);
        if ((target?.type === 'agent_task' || target?.type === 'integration') && reviewer.sessionGroup === target.sessionGroup) issue('non_independent_review', 'Reviewer cannot share the target agent session.', node.id);
      }
    }
    if (node.type === 'repair_scope') {
      if (byId.get(node.targetReviewId)?.type !== 'review_group') issue('invalid_repair_target', 'Repair scope must target a review group.', node.id);
      if (node.maxRounds > limits.maxRepairRounds) issue('repair_limit', 'Repair scope exceeds flow repair budget.', node.id);
      for (const owner of node.ownerNodeIds) {
        const ownerNode = byId.get(owner);
        if (ownerNode?.type !== 'agent_task' && !(ownerNode?.type === 'integration' && ownerNode.bindingId)) issue('invalid_repair_owner', `Repair owner ${owner} must be an agent task or an integration node with an agent.`, node.id);
      }
    }
    if (node.type === 'fork' && (outgoing.get(node.id)?.length ?? 0) < 2) issue('invalid_fork', 'Fork needs at least two outgoing branches.', node.id);
    if (node.type === 'join') {
      if (new Set(node.requiredBranches).size !== node.requiredBranches.length) issue('duplicate_join_branch', 'Required join branches must be unique.', node.id);
      for (const branch of node.requiredBranches) if (!incoming.get(node.id)?.includes(branch)) issue('invalid_join_branch', `Required branch ${branch} must be an incoming node.`, node.id);
    }
    if (node.type === 'condition') {
      const outcomes = edges.filter(e => e.from === node.id).map(e => e.outcome);
      if (!outcomes.includes('true') || !outcomes.includes('false')) issue('condition_outcomes', 'Condition requires both true and false outcomes.', node.id);
    }
  }

  const degree = new Map(nodes.map(n => [n.id, incoming.get(n.id)?.length ?? 0]));
  const queue = nodes.filter(n => degree.get(n.id) === 0).map(n => n.id);
  const order: string[] = [];
  while (queue.length) {
    const current = queue.shift()!;
    order.push(current);
    for (const next of outgoing.get(current) ?? []) {
      const remaining = (degree.get(next) ?? 0) - 1;
      degree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  if (order.length !== byId.size) issue('cycle', 'Execution edges must form a DAG; repair loops use repair_scope.');

  const reachable = new Set<string>();
  const visit = (current: string) => {
    if (reachable.has(current)) return;
    reachable.add(current);
    for (const next of outgoing.get(current) ?? []) visit(next);
  };
  visit(startNodeId);
  for (const node of nodes) if (!reachable.has(node.id)) issue('unreachable', 'Node is not reachable from start.', node.id);
  for (const node of nodes) {
    if (node.type === 'join') {
      const required = new Set(node.requiredBranches);
      for (const parent of incoming.get(node.id) ?? []) {
        if (required.has(parent)) continue;
        const visited = new Set<string>();
        const hasWriter = (current: string): boolean => {
          if (visited.has(current)) return false;
          visited.add(current);
          const item = byId.get(current);
          if (item?.type === 'fork') return false;
          if (item?.type === 'integration' || (item?.type === 'agent_task' && item.permissions.write)) return true;
          return (incoming.get(current) ?? []).some(hasWriter);
        };
        if (hasWriter(parent)) issue('optional_writer_branch', `Branch ${parent} contains a writer and cannot be optional.`, node.id);
      }
    }
    if (node.type !== 'review_group' || !byId.has(node.targetNodeId)) continue;
    const ancestors = new Set<string>();
    const visitParent = (current: string) => {
      if (ancestors.has(current)) return;
      ancestors.add(current);
      for (const parent of incoming.get(current) ?? []) visitParent(parent);
    };
    for (const parent of incoming.get(node.id) ?? []) visitParent(parent);
    if (!ancestors.has(node.targetNodeId)) issue('review_target_not_upstream', 'Review target must be upstream of the review group.', node.id);
    for (const reviewer of node.reviewers) {
      for (const ancestor of ancestors) {
        const writer = byId.get(ancestor);
        if (((writer?.type === 'agent_task' && writer.permissions.write) || writer?.type === 'integration') && writer.sessionGroup === reviewer.sessionGroup) {
          issue('non_independent_review', 'Reviewer cannot share a session with an upstream writer.', node.id);
        }
      }
    }
  }

  // Track every reachable path: a branch cannot bypass the project approval/review gates.
  if (order.length === byId.size && byId.has(startNodeId)) {
    const states = new Map<string, Set<string>>([[startNodeId, new Set([JSON.stringify([false, false, null])])]]);
    for (const current of order) {
      const node = byId.get(current)!;
      for (const state of states.get(current) ?? []) {
        const decoded = JSON.parse(state) as [boolean, boolean, string | null];
        const approved = decoded[0];
        let reviewed = decoded[1];
        let lastWriter = decoded[2];
        const writes = (node.type === 'agent_task' && node.permissions.write) || node.type === 'integration';
        if (writes && policy.requireApprovalBeforeWrite && !approved) issue('approval_bypass', 'A path reaches a writer without approval.', current);
        if (writes) { reviewed = false; lastWriter = current; }
        if (node.type === 'git_commit' && requireReview && !reviewed) issue('review_bypass', 'A path reaches commit without independent review after the latest write.', current);
        if (node.type === 'finish' && lastWriter && requireReview && !reviewed) issue('review_bypass', 'A path finishes after a write without independent review.', current);
        for (const edge of edges.filter(e => e.from === current && byId.has(e.to))) {
          const edgeApproved = approved || (node.type === 'approval' && edge.outcome === 'pass');
          const edgeReviewed = reviewed || (node.type === 'review_group' && node.targetNodeId === lastWriter && edge.outcome === 'pass' && node.reviewers.some(r => r.required));
          const encoded = JSON.stringify([edgeApproved, edgeReviewed, lastWriter]);
          const nextStates = states.get(edge.to) ?? new Set<string>();
          nextStates.add(encoded); states.set(edge.to, nextStates);
        }
      }
    }
  }
  const warnings: Diagnostic[] = [];
  if (options.authoring) authoringRules(flow, incoming, issue, (code, message, nodeId) => { warnings.push({ code, message, ...(nodeId === undefined ? {} : { nodeId }), severity: 'warning' }); });
  if (diagnostics.length) return { ok: false, diagnostics, ...(warnings.length ? { warnings } : {}) };
  return { ok: true, flow, order, ...(warnings.length ? { warnings } : {}) };
}
