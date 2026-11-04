import type { MemoryRecord } from './store.js';

const terms = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? [];
const dot = (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + value * (b[i] ?? 0), 0);
const normalize = (vector: number[]) => { const norm = Math.sqrt(dot(vector, vector)); return norm ? vector.map(value => value / norm) : vector; };

/** Corpus-local latent semantic indexing: low-rank TF-IDF, computed locally without sending project memory anywhere. */
export function semanticScores(records: MemoryRecord[], task: string): number[] {
  if (!records.length) return [];
  if (records.length > 512) throw new Error('Local semantic retrieval supports at most 512 active records; narrow scope or tags');
  const counts = records.map(record => {
    const values = new Map<string, number>();
    for (const term of terms(`${record.header.id} ${record.header.scope} ${record.header.tags.join(' ')} ${record.body}`)) values.set(term, (values.get(term) ?? 0) + 1);
    return values;
  });
  const frequencies = new Map<string, number>(); for (const document of counts) for (const term of document.keys()) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  const vocabulary = [...frequencies.keys()].sort(), idf = vocabulary.map(term => 1 + Math.log((records.length + 1) / (frequencies.get(term)! + 1)));
  const documents = counts.map(count => normalize(vocabulary.map((term, i) => Math.log1p(count.get(term) ?? 0) * idf[i]!)));
  const queryCounts = new Map<string, number>(); for (const term of terms(task)) queryCounts.set(term, (queryCounts.get(term) ?? 0) + 1);
  const query = normalize(vocabulary.map((term, i) => Math.log1p(queryCounts.get(term) ?? 0) * idf[i]!));
  const raw = documents.map(document => dot(document, query));
  if (!raw.some(value => value > 0)) return raw;
  const gram = documents.map(a => documents.map(b => dot(a, b))), axes: { vector: number[]; value: number }[] = [];
  const rank = Math.min(records.length, Math.max(1, Math.ceil(Math.sqrt(records.length))));
  for (let component = 0; component < rank; component++) {
    let vector = normalize(records.map((_, i) => 1 + ((i * 17 + component * 11) % 23) / 23));
    for (let step = 0; step < 40; step++) {
      let next = gram.map(row => dot(row, vector));
      for (const axis of axes) { const projection = dot(next, axis.vector); next = next.map((value, i) => value - projection * axis.vector[i]!); }
      vector = normalize(next);
    }
    const value = dot(vector, gram.map(row => dot(row, vector)));
    if (value < 1e-8) break;
    axes.push({ vector, value });
  }
  const projectedQuery = axes.map(axis => dot(raw, axis.vector) / Math.sqrt(axis.value));
  const q = normalize(projectedQuery);
  return records.map((_, i) => Math.max(0, dot(normalize(axes.map(axis => Math.sqrt(axis.value) * axis.vector[i]!)), q)));
}

/** Suppression is deterministic and non-destructive; the records remain available in the memory browser. */
export function activeMemory(records: MemoryRecord[], now = Date.now()) {
  const excluded: { id: string; reason: string }[] = [], superseded = new Set(records.filter(record => !record.header.expiresAt || Date.parse(record.header.expiresAt) > now).flatMap(record => (record.header.supersedes ?? []).map(id => `${record.header.type}/${id}`)));
  const fingerprints = new Set<string>();
  const active = [...records].sort((a, b) => b.header.updatedAt.localeCompare(a.header.updatedAt) || a.header.id.localeCompare(b.header.id)).filter(record => {
    let reason = record.header.expiresAt && Date.parse(record.header.expiresAt) <= now ? 'expired' : superseded.has(`${record.header.type}/${record.header.id}`) ? 'superseded' : '';
    const key = JSON.stringify([record.header.type, record.header.scope, [...record.header.tags].sort(), record.body.normalize('NFKC').trim().replace(/\s+/gu, ' ')]);
    if (!reason && fingerprints.has(key)) reason = 'duplicate';
    if (reason) { excluded.push({ id: record.header.id, reason }); return false; }
    fingerprints.add(key); return true;
  });
  return { active, excluded };
}
