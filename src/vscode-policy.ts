import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { requireRoutingPolicy, roleModelPolicy } from './routing.js';
import { resolveCatalogModel } from './model-catalog.js';

/** Resolve catalog labels to stable VS Code vendor/ID selectors, never endpoint credentials. */
export function vscodeSelection(root: string, role: string, id: string): { vendor: string; id: string } {
  const policy = requireRoutingPolicy(root);
  const spec = roleModelPolicy(root, role);
  if (!spec.models.includes(id)) throw new Error('Requested model is outside the role policy.');
  const provider = spec.provider;
  if (provider === 'copilot') return { vendor: 'copilot', id };
  if (!policy.language_models_file) return { vendor: provider ?? 'copilot', id };
  const path = isAbsolute(policy.language_models_file)
    ? policy.language_models_file : resolve(root, policy.language_models_file);
  if (!existsSync(path)) throw new Error('VS Code language model catalog is unavailable.');
  const catalog: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(catalog)) throw new Error('VS Code language model catalog must be an array.');
  const model = resolveCatalogModel(catalog, id, provider);
  if (!model || !model.vendor || !model.id?.trim())
    throw new Error('VS Code model ID must resolve to exactly one catalog vendor.');
  return { vendor: model.vendor, id: model.id };
}
