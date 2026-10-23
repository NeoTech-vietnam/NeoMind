/** Catalog metadata only; endpoint settings and credentials must never escape resolution. */
export interface ModelCatalogEntry {
  id?: string;
  name?: string;
  vendor?: string;
}

/** Resolve one entry in provider scope, preferring literal IDs over names and aliases. */
export function resolveCatalogModel(
  catalog: readonly unknown[],
  requested: string,
  provider?: string,
): ModelCatalogEntry | undefined {
  const entries: ModelCatalogEntry[] = [];
  for (const value of catalog) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const group = value as Record<string, unknown>;
    if (provider && group['name'] !== provider && group['vendor'] !== provider) continue;
    const vendor = typeof group['vendor'] === 'string' && group['vendor'].trim()
      ? group['vendor'] : undefined;
    if (Array.isArray(group['models'])) {
      for (const value of group['models']) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const model = value as Record<string, unknown>;
        entries.push({
          id: typeof model['id'] === 'string' ? model['id'] : undefined,
          name: typeof model['name'] === 'string' ? model['name'] : undefined,
          vendor,
        });
      }
    }
    const settings = group['settings'];
    if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
      for (const id of Object.keys(settings)) entries.push({ id, name: id, vendor });
    }
  }
  // Never strip parentheses: they may be part of a literal ID or display name.
  let matches = entries.filter((entry) => entry.id === requested);
  if (!matches.length) matches = entries.filter((entry) => entry.name === requested);
  if (!matches.length) {
    matches = entries.filter((entry) => entry.vendor !== undefined && (
      (entry.id !== undefined && `${entry.id} (${entry.vendor})` === requested) ||
      (entry.name !== undefined && `${entry.name} (${entry.vendor})` === requested)
    ));
  }
  return matches.length === 1 ? matches[0] : undefined;
}
