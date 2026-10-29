import type { MaterializedRun } from '../domain/materialize.js';
import type { BindingValues } from '../domain/resolve.js';
export function effectiveBinding(snapshot: MaterializedRun, selections: { key: string; values: BindingValues }[], key: string): BindingValues | undefined {
  return [...selections].reverse().find(selection => selection.key === key)?.values ?? snapshot.configuration.bindings[key]?.values;
}
