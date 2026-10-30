import { flowSchema, projectPolicySchema, type Flow, type ProjectPolicy } from './schema.js';
import path from 'node:path';

export interface Diagnostic { code: string; message: string; nodeId?: string }
export type Compilation =
  | { ok: true; flow: Flow; order: string[] }
  | { ok: false; diagnostics: Diagnostic[] };

/** Validate a persisted graph before it can be published or dispatched. */
export function compileFlow(input: unknown, policyInput: unknown): Compilation {
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
  if (humanReview && policy.allowHumanReview === false) issue('human_review_denied', 'Project policy requires independent review inside the flow.');
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
    if (node.type === 'approval' && node.mode === 'auto' && policy.allowAutoApproval === false) issue('auto_approval_denied', 'Project policy does not allow automatic plan approval.', node.id);
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
  if (diagnostics.length) return { ok: false, diagnostics };
  return { ok: true, flow, order };
}
