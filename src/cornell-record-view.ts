import { resolve } from 'node:path';
import { loadRecords } from './storage.js';
import type { ProjectRecord } from './types.js';

export interface CornellRecordView {
  get(id: string): ProjectRecord;
  all(): ProjectRecord[];
}
// Only scope identity/lifetime metadata is retained here, never record data.
// A copied method, reflected key or Proxy cannot manufacture an active view.
const scopes = new WeakMap<CornellRecordView, { project: string; active: boolean }>();
export function assertCornellRecordView(root: string, view: CornellRecordView): void {
  const state = view && typeof view === 'object' ? scopes.get(view) : undefined;
  if (!state?.active || state.project !== resolve(root))
    throw new Error('Cornell read view is expired, unrecognized or belongs to another project. Use an active synchronous validation.');
}

/** One fresh full inventory for a synchronous read-only operation. Storage's
 * duplicate-ID and malformed-record guards run before any lookup. The scope
 * expires before this function returns, including exceptional/async callers. */
export function withCornellRecordView<T>(root: string, action: (view: CornellRecordView) => T): T {
  const project = resolve(root), records = new Map(loadRecords(root).map(record => [record.meta.id, record]));
  const state = { project, active: true };
  const assertActive = (target = project) => {
    if (!state.active || resolve(target) !== project) throw new Error('Cornell read view is expired or belongs to another project.');
  };
  const view: CornellRecordView = Object.freeze({
    get(id: string) {
      assertActive();
      const record = records.get(id);
      if (!record) throw new Error(`Record not found: ${id}`);
      return structuredClone(record);
    },
    all() { assertActive(); return structuredClone([...records.values()]); },
  });
  scopes.set(view, state);
  try {
    const result = action(view);
    if (result && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') {
      void Promise.resolve(result).catch(() => {});
      throw new Error('Cornell read views cannot cross an asynchronous boundary.');
    }
    return result;
  } finally { state.active = false; scopes.delete(view); records.clear(); }
}
