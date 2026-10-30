import type { BindingValues, ResolvedBinding } from '../domain/resolve.js';
import type { AvailableRunnerModel } from '../runners/agent-runner.js';
/** Models reported by the runners of the binding, each already filtered by NeoMind's per-runner allowlist. */
export function selectAvailableBinding(binding: ResolvedBinding, models: AvailableRunnerModel[]): { values: BindingValues; fallback: boolean } {
  const available = (values: BindingValues) => models.some(model => model.runner === values.runner && model.provider === values.provider &&
    model.model === values.model && model.reasoning.includes(values.reasoning));
  if (available(binding.values)) return { values: structuredClone(binding.values), fallback: false };
  const fallback = binding.fallback.find(available);
  if (!fallback) throw new Error('Không có model/mức suy luận khả dụng trong lựa chọn chính hoặc danh sách thay thế được phép');
  return { values: structuredClone(fallback), fallback: true };
}
/** Runners named by a binding's primary values and its allowed fallbacks. */
export function bindingRunners(bindings: Record<string, ResolvedBinding>): string[] {
  return [...new Set(Object.values(bindings).flatMap(binding => [binding.values.runner, ...binding.fallback.map(item => item.runner)]))];
}
