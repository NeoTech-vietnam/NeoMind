export interface JsonChange { path: string; before: unknown; after: unknown }

/** Ordered, bounded structural differences; never mutates either document. */
export function jsonChanges(before: unknown, after: unknown, limit = 200): { changes: JsonChange[]; truncated: boolean } {
  const changes: JsonChange[] = []; let truncated = false;
  const objects = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  function visit(a: unknown, b: unknown, path: string) {
    if (Object.is(a, b)) return;
    if (Array.isArray(a) && Array.isArray(b)) { for (let i = 0; i < Math.max(a.length, b.length); i++) { if (truncated) break; visit(a[i], b[i], `${path}[${i}]`); } return; }
    if (objects(a) && objects(b)) { for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) { if (truncated) break; visit(a[key], b[key], path ? `${path}.${key}` : key); } return; }
    if (changes.length >= limit) { truncated = true; return; }
    changes.push({ path: path || '$', before: a, after: b });
  }
  visit(before, after, ''); return { changes, truncated };
}
