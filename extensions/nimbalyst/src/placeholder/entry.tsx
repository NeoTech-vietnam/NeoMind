/**
 * Stand-in for the langflow UI (W:\projects\AI\langflow\ui) while it does not exist: a plain run list and gate form on
 * the same API, so the extension's backend and transport can be tested on their own. vite.panel.config.ts uses it
 * only when ../../ui/src/App.tsx is missing.
 */
import { useCallback, useEffect, useState } from 'react';

export type ApiTransport = (endpoint: string, method: string, body?: unknown) => Promise<{ status: number; body: unknown }>;
let transport: ApiTransport = async () => ({ status: 503, body: { error: 'no transport' } });
export function setApiTransport(next: ApiTransport): void { transport = next; }
/** The real UI opens files through this; the stand-in has nothing to open. */
export function setHostHooks(_hooks: { openFile?: (path: string) => void }): void {}
async function api<T>(endpoint: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await transport(endpoint, method, body), data = response.body as T & { error?: string };
  if (response.status >= 400) throw new Error(data?.error ?? `HTTP ${response.status}`);
  return data;
}

export const styles = `
:host { font-family: system-ui, sans-serif; font-size: 13px; color: var(--nim-text, #ddd); }
.lf { padding: 12px 16px; height: 100%; overflow: auto; box-sizing: border-box; }
.lf table { border-collapse: collapse; width: 100%; }
.lf td, .lf th { text-align: left; padding: 4px 8px; border-bottom: 1px solid #8884; }
.lf tr.sel { background: #4a90e233; }
.lf tr { cursor: pointer; }
.lf .gate { margin-top: 12px; padding: 10px; border: 1px solid #e2a14a; border-radius: 6px; }
.lf textarea, .lf input { width: 100%; box-sizing: border-box; margin: 4px 0; background: transparent; color: inherit; border: 1px solid #8886; padding: 4px; }
.lf button { margin-right: 8px; padding: 4px 12px; }
.lf .err { color: #e06c6c; white-space: pre-wrap; }
`;

interface RunRow { run: string; workflow: string; status: string; step?: string; gate?: string; question?: string; error?: string; updated?: string; busy?: boolean }

export function App(_props: { shell?: string }) {
  const [project, setProject] = useState<{ name?: string; approver?: string } | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState<string>();
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState('');
  const [result, setResult] = useState<string>();

  const refresh = useCallback(async () => {
    try { setRuns(await api<RunRow[]>('/api/runs')); setError(undefined); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => {
    api<{ name?: string; approver?: string }>('/api/project').then(setProject).catch(e => setError(String(e)));
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  const run = runs.find(r => r.run === selected);
  const answer = async (decision: 'approve' | 'reject') => {
    if (!run) return;
    try {
      await api(`/api/runs/${encodeURIComponent(run.run)}/answer`, 'POST', { decision, note, confirm });
      setResult(`${decision}: accepted`); setNote(''); setConfirm(''); refresh();
    } catch (e) { setResult(e instanceof Error ? e.message : String(e)); }
  };

  return <div className="lf">
    <h3>langflow: {project?.name ?? '…'} {project?.approver ? `(approver: ${project.approver})` : ''}</h3>
    <p style={{ opacity: 0.7 }}>Placeholder panel: the langflow UI (ui/) is not built into this extension yet.</p>
    {error && <div className="err">{error}</div>}
    <table><thead><tr><th>run</th><th>workflow</th><th>status</th><th>step</th><th>updated</th></tr></thead><tbody>
      {runs.map(r => <tr key={r.run} className={r.run === selected ? 'sel' : ''} onClick={() => { setSelected(r.run); setResult(undefined); }}>
        <td>{r.run}</td><td>{r.workflow}</td><td>{r.status}{r.busy ? ' (busy)' : ''}</td><td>{r.gate ?? r.step ?? ''}</td><td>{r.updated ?? ''}</td></tr>)}
    </tbody></table>
    {run?.status === 'waiting' && <div className="gate">
      <b>Gate {run.gate}</b><div style={{ whiteSpace: 'pre-wrap' }}>{run.question}</div>
      <textarea rows={3} placeholder="note" value={note} onChange={e => setNote(e.target.value)} />
      <input placeholder={`type the run name (${run.run}) to confirm`} value={confirm} onChange={e => setConfirm(e.target.value)} />
      <button disabled={confirm !== run.run} onClick={() => answer('approve')}>Approve</button>
      <button disabled={confirm !== run.run} onClick={() => answer('reject')}>Reject</button>
    </div>}
    {run?.error && <div className="err">{run.error}</div>}
    {result && <div>{result}</div>}
  </div>;
}
