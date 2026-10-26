import { readConfig } from './storage.js';
import { readRouterConfiguration } from './model-control.js';

export type CodexRoutingMode = 'inherit' | '9router';
export type CodexRoutingConfiguration = { mode: 'inherit' } | {
  mode: '9router'; provider: 'neomind_9router'; base_url: string;
  env_key: string; wire_api: 'responses'; catalog_provider: string;
};

/** Configuration only: no credentials, catalog import, network request or compatibility claim. */
export function readCodexRouting(root: string, mode?: CodexRoutingMode): CodexRoutingConfiguration {
  const selected = mode ?? readConfig(root).codex_routing ?? 'inherit';
  if (selected === 'inherit') return { mode: 'inherit' };
  if (selected !== '9router') throw new Error('Codex routing must be inherit or 9router.');
  const router = readRouterConfiguration(root);
  if (!router) throw new Error('Configure the local 9router endpoint and API-key environment reference before selecting Codex 9router routing.');
  return { mode: '9router', provider: 'neomind_9router', base_url: router.base_url,
    env_key: router.api_key_env, wire_api: 'responses', catalog_provider: router.catalog_provider };
}
