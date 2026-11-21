import { useEffect, useRef, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { api, enc } from './api';
import { usePoll } from '@/lib/poll';
import { cn } from '@/lib/utils';
import type { LogPage } from './types';

const MAX_LINES = 5000;

/** One log line: "HH:MM:SS <step, padded to 14> <text>" (engine.log_line). */
function parse(raw: string): { time: string; step: string; text: string } {
  const line = raw.replace(/\r$/, ''), match = /^(\d\d:\d\d:\d\d) (\S+)\s+(.*)$/.exec(line);
  return match ? { time: match[1]!, step: match[2]!, text: match[3]! } : { time: '', step: '', text: line };
}
function tone(text: string): string {
  if (/\bfailed\b|FAILED|\berror\b|exit [1-9]/i.test(text)) return 'text-danger';
  if (/^WAITING\b/.test(text)) return 'text-attention';
  if (/^(ai|script|write|gate|run|route|loop|fanout|join|parallel) (done|approve|kept)\b/.test(text)) return 'text-success';
  if (/^says: /.test(text)) return 'text-foreground';
  return 'text-fg-2';
}

/**
 * The run's live log, tailed by byte offset: the first request reads the whole log (the server caps it), later ones
 * only the new lines. Keeps the newest line in view unless the user scrolled up.
 */
export function LiveLog({ run, active, height = 'h-[360px]' }: { run: string; active: boolean; height?: string }) {
  const [lines, setLines] = useState<string[]>([]), [error, setError] = useState(''), [follow, setFollow] = useState(true);
  const offset = useRef(0), box = useRef<HTMLDivElement>(null);
  useEffect(() => { offset.current = 0; setLines([]); setError(''); setFollow(true); }, [run]);
  usePoll(async () => {
    try {
      const from = offset.current, page = await api<LogPage>(`/api/runs/${enc(run)}/log?offset=${from}`);
      // Another request already moved the offset (two polls overlapped): drop this answer, its lines are in.
      if (from !== offset.current) return;
      // A smaller offset than ours means the log was replaced: start over.
      if (page.offset < from) { offset.current = 0; setLines([]); return; }
      offset.current = page.offset; setError('');
      if (page.lines.length) setLines(current => { const next = current.concat(page.lines); return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next; });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, active ? 1000 : 4000, [run]);
  useEffect(() => { if (follow && box.current) box.current.scrollTop = box.current.scrollHeight; }, [lines, follow]);
  return <div className="flex flex-col gap-1.5">
    {error && <p role="alert" className="m-0 flex items-center gap-1.5 text-[12px] text-danger"><CircleAlert className="size-3.5" />{error}</p>}
    <div ref={box} onScroll={event => { const el = event.currentTarget; setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24); }}
      className={cn('overflow-auto rounded-md border bg-code px-2.5 py-2 font-mono text-[11.5px] leading-[1.6]', height)} aria-live="off" aria-label="Log của run">
      {lines.length === 0 && <span className="text-faint">Chưa có dòng log nào.</span>}
      {lines.map((line, index) => { const item = parse(line); return <div key={index} className="flex gap-2 whitespace-pre-wrap break-words">
        <span className="shrink-0 tabular-nums text-faint">{item.time}</span><span className="w-[110px] shrink-0 truncate text-muted-foreground" title={item.step}>{item.step}</span>
        <span className={cn('min-w-0 flex-1', tone(item.text))}>{item.text}</span></div>; })}
    </div>
    <div className="flex items-center gap-3 text-[11.5px] text-muted-foreground"><span>{lines.length} dòng{active ? ' · cập nhật mỗi giây' : ''}</span>
      {!follow && <button type="button" className="cursor-pointer border-0 bg-transparent p-0 font-sans text-[11.5px] text-foreground underline" onClick={() => setFollow(true)}>Cuộn xuống dòng mới nhất</button>}</div>
  </div>;
}
