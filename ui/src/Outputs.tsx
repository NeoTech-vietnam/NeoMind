/** "Đầu ra" tab: the files a run wrote or showed at a gate, a preview of the chosen one, and each step's transcript. */
import { useEffect, useMemo, useState } from 'react';
import { CircleAlert, FileText, FolderOpen, ScrollText } from 'lucide-react';
import { api, enc } from './api';
import { Tag } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/misc';
import { usePoll } from '@/lib/poll';
import { cn } from '@/lib/utils';
import { fileName, formatBytes, shortTime } from './format';
import { FilePreview } from './FilePreview';
import type { Output, RunDetail } from './types';

export function useOutputs(run: string, active: boolean) {
  const [outputs, setOutputs] = useState<Output[] | null>(null), [error, setError] = useState('');
  useEffect(() => { setOutputs(null); setError(''); }, [run]);
  usePoll(async () => {
    try { setOutputs(await api<Output[]>(`/api/runs/${enc(run)}/outputs`)); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, active ? 4000 : 20000, [run]);
  return { outputs, error };
}

const kindLabel: Record<string, string> = { markdown: 'md', json: 'json', text: 'text', binary: 'nhị phân' };

export function OutputsTab({ run, outputs, error, openTranscript }: { run: RunDetail; outputs: Output[] | null; error: string; openTranscript(step: string): void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const list = useMemo(() => outputs ?? [], [outputs]);
  useEffect(() => { if (!selected || !list.some(item => item.path === selected)) setSelected(list.find(item => item.exists && item.kind !== 'binary')?.path ?? list[0]?.path ?? null); }, [list, selected]);
  const transcripts = Object.entries(run.transcripts ?? {});
  const current = list.find(item => item.path === selected);
  if (error && !outputs) return <p role="alert" className="m-0 flex items-center gap-1.5 text-[12.5px] text-danger"><CircleAlert className="size-3.5" />{error}</p>;
  if (!outputs) return <p className="m-0 text-[12.5px] text-muted-foreground">Đang đọc danh sách file…</p>;
  return <div className="flex flex-col gap-4">
    {!list.length ? <EmptyState icon={<FolderOpen />} title="Chưa có file đầu ra">Các bước ghi file (write) và file mà gate cho xem sẽ hiện ở đây.</EmptyState>
      : <div className="@container"><div className="grid min-h-0 grid-cols-1 gap-3 @[760px]:grid-cols-[300px_minmax(0,1fr)]">
        <ul className="m-0 flex max-h-[560px] list-none flex-col gap-px overflow-auto rounded-md border p-1" aria-label="File đầu ra">
          {list.map(item => <li key={item.path}>
            <button type="button" aria-current={item.path === selected ? 'true' : undefined} onClick={() => setSelected(item.path)} disabled={!item.exists}
              className={cn('flex w-full cursor-pointer items-start gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left font-sans hover:bg-accent disabled:cursor-not-allowed disabled:opacity-55', item.path === selected && 'bg-accent')}>
              <FileText className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium text-foreground" title={item.path}>{fileName(item.path)}</span>
                <span className="block truncate text-[11px] text-muted-foreground">{[item.step, item.exists ? formatBytes(item.size) : 'không còn file', typeof item.mtime === 'string' ? shortTime(item.mtime) : ''].filter(Boolean).join(' · ')}</span>
              </span>
              {item.kind && <Tag className="h-4 px-1 text-[10.5px]">{kindLabel[item.kind] ?? item.kind}</Tag>}
            </button>
          </li>)}
        </ul>
        <div className="min-w-0">
          {current ? <>
            <div className="mb-1.5 flex items-center gap-2 text-[12px] text-muted-foreground">
              {current.step && <span>bước <code className="font-mono text-fg-2">{current.step}</code></span>}
              {current.step && run.transcripts?.[current.step] && <Button size="sm" variant="ghost" className="ml-auto" onClick={() => openTranscript(current.step!)}><ScrollText />Transcript của bước</Button>}
            </div>
            <FilePreview path={current.path} version={current.mtime ?? current.size} bodyClassName="max-h-[520px]" />
          </> : <p className="m-0 text-[12.5px] text-muted-foreground">Chọn một file để xem.</p>}
        </div>
      </div></div>}
    {transcripts.length > 0 && <section>
      <h4 className="m-0 mb-1.5 text-[12.5px] font-semibold">Transcript theo bước <span className="font-normal text-faint">{transcripts.length}</span></h4>
      <div className="flex flex-wrap gap-1.5">{transcripts.map(([step, item]) => <Button key={step} size="sm" onClick={() => openTranscript(step)}>
        <ScrollText /><span className="font-mono">{step}</span>{item.agent && <span className="text-faint">{item.agent}</span>}</Button>)}</div>
    </section>}
  </div>;
}
