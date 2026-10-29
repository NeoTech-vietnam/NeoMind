import type { BindingValues } from '../domain/resolve.js';

export type CapabilityLevel = 'supported_verified' | 'instructions_only' | 'unsupported' | 'unknown';
export interface CapabilityReport {
  runner: string;
  version: string;
  auth: 'ready' | 'not_ready' | 'unknown';
  models: { provider: string; id: string; reasoning: string[] }[];
  delegation: CapabilityLevel;
  stopConfirmation: CapabilityLevel;
  workspaceWriteScope: CapabilityLevel;
}
export interface Requirements {
  requireDelegationEnforcement: boolean;
  allowInstructionsOnly: boolean;
  requireStopConfirmation: boolean;
  requireWorkspaceWriteScope: boolean;
}
export interface PreflightResult { ok: boolean; blockers: string[]; warnings: string[] }

/** Adapter reports are inputs from a trusted capability probe, not from agent output. */
export function checkCapabilities(binding: BindingValues, report: CapabilityReport, requirements: Requirements): PreflightResult {
  const blockers: string[] = [], warnings: string[] = [];
  if (binding.runner !== report.runner) blockers.push('runner_mismatch');
  if (report.auth !== 'ready') blockers.push(`auth_${report.auth}`);
  const model = report.models.find(m => m.provider === binding.provider && m.id === binding.model);
  if (!model) blockers.push('model_unavailable');
  else if (!model.reasoning.includes(binding.reasoning)) blockers.push('reasoning_unavailable');
  if (requirements.requireDelegationEnforcement && report.delegation !== 'supported_verified') {
    if (report.delegation === 'instructions_only' && requirements.allowInstructionsOnly) warnings.push('delegation_instructions_only');
    else blockers.push(`delegation_${report.delegation}`);
  }
  if (requirements.requireStopConfirmation && report.stopConfirmation !== 'supported_verified') blockers.push(`stop_${report.stopConfirmation}`);
  if (requirements.requireWorkspaceWriteScope && report.workspaceWriteScope !== 'supported_verified') blockers.push(`workspace_scope_${report.workspaceWriteScope}`);
  return { ok: blockers.length === 0, blockers, warnings };
}

export type FallbackReason = 'binding_unavailable' | 'auth_unavailable' | 'policy_denied' | 'effect_unknown';
export type FallbackResult = { selected: BindingValues; reason: 'binding_unavailable'; index: number } | { selected: null; reason: string };

/** Deterministic, auditable allowlist only. Auth/policy/unknown effects never auto-fallback. */
export function selectFallback(reason: FallbackReason, allowed: BindingValues[], reports: CapabilityReport[], requirements: Requirements): FallbackResult {
  if (reason !== 'binding_unavailable') return { selected: null, reason };
  for (const [index, candidate] of allowed.entries()) {
    const report = reports.find(item => item.runner === candidate.runner);
    if (report && checkCapabilities(candidate, report, requirements).ok) return { selected: structuredClone(candidate), reason, index };
  }
  return { selected: null, reason: 'no_allowed_binding_available' };
}
