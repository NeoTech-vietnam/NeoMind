interface Candidate {
  code: unknown; path: unknown[]; expected: unknown;
  minimum: unknown; maximum: unknown; origin: unknown; inclusive: unknown;
}
const data = (value: object, key: string): unknown => {
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; }
};
/** Expand the closest declared union branch before the caller applies its fixed
 * safe field/type/message allowlists. Never inspect messages, values or enum data. */
export function expandControlledSchemaIssues<T>(value: unknown, project: (issue: Candidate) => T): T[] {
  let nodes = 256;
  const active = new Set<object>();
  function list(input: unknown, prefix: unknown[], depth: number, relative = true): Candidate[] {
    if (!Array.isArray(input) || depth > 6) return [];
    const result: Candidate[] = [];
    for (const issue of input.slice(0, 32)) {
      if (nodes-- <= 0 || result.length >= 8) break;
      if (!issue || typeof issue !== 'object') continue;
      const rawPath = data(issue, 'path'), own = Array.isArray(rawPath) ? rawPath.slice(0, 8) : [];
      const path = (!relative && prefix.every((part, index) => own[index] === part) ? own : [...prefix, ...own]).slice(0, 8);
      const leaf = { code: data(issue, 'code'), path, expected: data(issue, 'expected'),
        minimum: data(issue, 'minimum'), maximum: data(issue, 'maximum'),
        origin: data(issue, 'origin'), inclusive: data(issue, 'inclusive') };
      if (leaf.code !== 'invalid_union' || depth === 6 || active.has(issue)) { result.push(leaf); continue; }
      active.add(issue);
      const errors = data(issue, 'errors'), legacy = data(issue, 'unionErrors');
      const branches = Array.isArray(errors) ? errors : Array.isArray(legacy) ? legacy : [];
      let best: Candidate[] | undefined, score = Infinity;
      for (const branch of branches.slice(0, 16)) {
        if (nodes <= 0) break;
        const candidates = list(Array.isArray(branch) ? branch : branch && typeof branch === 'object' ? data(branch, 'issues') : [],
          path, depth + 1, Array.isArray(errors));
        const cost = candidates.length ? candidates.reduce((sum, candidate) => sum + (candidate.code === 'invalid_union' ? 9 : 1), 0) : Infinity;
        if (cost < score) { best = candidates; score = cost; }
        if (score === 1) break;
      }
      active.delete(issue);
      result.push(...(best ?? [leaf]));
    }
    return result.slice(0, 8);
  }
  return list(value, [], 0).map(project);
}
