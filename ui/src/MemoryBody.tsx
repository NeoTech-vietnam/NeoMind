import { useLayoutEffect, useRef, useState } from 'react';
import { ExternalLink, FoldVertical } from 'lucide-react';
import { compactLegacyLessonBody, memoryTitle, sourceRunIds, splitBodyParts } from '../../src/memory/lesson-body';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/misc';
import { cn } from '@/lib/utils';

const count = (value: number) => value.toLocaleString('vi-VN');
/** Preview lines with each JSON block replaced by a short placeholder, so the few visible lines say something. */
const previewOf = (text: string) => splitBodyParts(text).map(part => part.kind === 'json' ? `[${part.summary}]` : part.text).join('\n');

/** A whole body: prose as written, JSON blocks folded and pretty-printed instead of one paragraph of thousands of characters. */
export function MemoryBodyFull({ body, className }: { body: string; className?: string }) {
  return <div className={cn('flex min-w-0 flex-col gap-2 text-[13px] leading-relaxed text-fg-2', className)}>{splitBodyParts(body).map((part, index) => part.kind === 'text'
    ? <p key={index} className="m-0 whitespace-pre-wrap break-words">{part.text}</p>
    : <details key={index} className="memory-json"><summary>{part.summary}</summary><pre>{part.pretty ?? part.raw}</pre></details>)}</div>;
}

/**
 * A memory body as a card: the first line as the title, a few lines of preview and "Xem đầy đủ" for the rest, so a
 * queue of proposals can be reviewed one card at a time however long one of them is.
 */
export function MemoryBody({ body, lines = 3, className }: { body: string; lines?: 2 | 3; className?: string }) {
  const [open, setOpen] = useState(false), [clamped, setClamped] = useState(false), previewRef = useRef<HTMLParagraphElement>(null);
  const { title, rest } = memoryTitle(body), preview = previewOf(rest), hasJson = preview !== rest && splitBodyParts(rest).some(part => part.kind === 'json');
  // Offer "Xem đầy đủ" only when the clamp actually hides something at the current width (or the preview folds JSON).
  useLayoutEffect(() => {
    const element = previewRef.current;
    if (!element) return;
    const check = () => setClamped(element.scrollHeight > element.clientHeight + 1);
    check();
    const observer = new ResizeObserver(check); observer.observe(element);
    return () => observer.disconnect();
  }, [preview, open]);
  return <div className={cn('flex min-w-0 flex-col gap-1', className)}>
    <p className="m-0 break-words text-[13.5px] font-medium leading-snug text-foreground">{title}</p>
    {rest && (open ? <MemoryBodyFull body={rest} /> : <p ref={previewRef} className={cn('m-0 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-muted-foreground', lines === 2 ? 'line-clamp-2' : 'line-clamp-3')}>{preview}</p>)}
    {(open || clamped || hasJson) && <button type="button" className="memory-more" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Thu gọn' : `Xem đầy đủ · ${count(body.length)} ký tự`}</button>}
  </div>;
}

/** Old repair lessons (raw reviewer JSON plus the agent's reply) can be rewritten as the short body new runs write. */
export function LegacyNotice({ body, busy, onCompact }: { body: string; busy?: boolean; onCompact(after: string): void }) {
  const compacted = compactLegacyLessonBody(body);
  if (!compacted) return null;
  return <Callout tone="attention"><div className="flex flex-wrap items-center gap-x-3 gap-y-1.5"><span className="min-w-0 flex-1 basis-64">Lesson theo mẫu cũ: {count(body.length)} ký tự, có JSON thô của reviewer. Bản rút gọn còn {count(compacted.body.length)} ký tự (tiêu chí, vấn đề, file); bằng chứng đầy đủ vẫn ở run nguồn.</span>
    <Button size="sm" disabled={busy} onClick={() => onCompact(compacted.body)}><FoldVertical />Rút gọn</Button></div></Callout>;
}

/** Sources in one line; runs the record came from open in place ("Mở run nguồn"). */
export function MemorySources({ sources, onOpenRun, list = true, className }: { sources: string[]; onOpenRun?(runId: string): void; list?: boolean; className?: string }) {
  const runs = sourceRunIds(sources);
  return <div className={cn('flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted-foreground', className)}>
    {onOpenRun && runs.map(runId => <button key={runId} type="button" className="memory-run-link" title={runId} onClick={() => onOpenRun(runId)}><ExternalLink className="size-3" />{runs.length > 1 ? `Mở ${runId.slice(0, 12)}…` : 'Mở run nguồn'}</button>)}
    {list && <span className="min-w-0 flex-1 truncate" title={sources.join('\n')}>Nguồn: {sources.length ? sources.join(', ') : 'không có'}</span>}
  </div>;
}
