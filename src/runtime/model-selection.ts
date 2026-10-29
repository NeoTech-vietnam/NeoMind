import type { BindingValues, ResolvedBinding } from '../domain/resolve.js';
export interface AvailableModel { id: string; model: string; supportedReasoningEfforts: { reasoningEffort: string }[] }
export function selectAvailableBinding(binding: ResolvedBinding, models: AvailableModel[]): { values: BindingValues; fallback: boolean } {
  const available = (values: BindingValues) => values.runner === 'codex' && values.provider === 'openai' && models.some(model =>
    (model.model === values.model || model.id === values.model) && model.supportedReasoningEfforts.some(effort => effort.reasoningEffort === values.reasoning));
  if (available(binding.values)) return { values: structuredClone(binding.values), fallback: false };
  const fallback = binding.fallback.find(available);
  if (!fallback) throw new Error('Không có model/mức suy luận khả dụng trong lựa chọn chính hoặc danh sách thay thế được phép');
  return { values: structuredClone(fallback), fallback: true };
}
