/**
 * Preview of a project file through GET /api/file: markdown rendered, JSON pretty-printed, text as is, binary named
 * only. Used by the gate card (gate_files) and the "Đầu ra" tab (run outputs).
 */
import { useEffect, useMemo, useState } from 'react';
import { CircleAlert, Code2, ExternalLink, FileText } from 'lucide-react';
import { api, enc } from './api';
import { CopyButton } from '@/components/CopyButton';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { fileName, formatBytes } from './format';
import { hostHooks } from './host';
import { Markdown } from './Markdown';
import type { FileContent } from './types';

/** Reads a file; `version` re-reads it (e.g. when the run moves on and rewrites the draft). */
export function useFile(path: string | null, version?: unknown) {
  const [loaded, setLoaded] = useState<{ path: string; file: FileContent } | null>(null), [error, setError] = useState('');
  useEffect(() => {
    if (!path) { setLoaded(null); setError(''); return; }
    let current = true; setError('');
    api<FileContent>(`/api/file?path=${enc(path)}`).then(file => { if (current) setLoaded({ path, file }); })
      .catch(e => { if (current) { setLoaded(null); setError(e instanceof Error ? e.message : String(e)); } });
    return () => { current = false; };
  }, [path, version]);
  // A re-read keeps the old content on screen; another path shows "loading" instead of the previous file.
  return { file: loaded && loaded.path === path ? loaded.file : null, error };
}

function pretty(text: string): string { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } }

/** The content of one file with a small toolbar (path, size, copy, source toggle, open in Nimbalyst). */
export function FilePreview({ path, version, className, bodyClassName }: { path: string; version?: unknown; className?: string; bodyClassName?: string }) {
  const { file, error } = useFile(path, version), [source, setSource] = useState(false);
  const openFile = hostHooks().openFile;
  const body = useMemo(() => {
    if (!file) return null;
    if (file.kind === 'binary' || file.text === null) return <p className="m-0 text-[12.5px] text-muted-foreground">File nhị phân ({formatBytes(file.size)}); không xem trước được.</p>;
    if (file.kind === 'markdown' && !source) return <Markdown text={file.text} />;
    if (file.kind === 'json') return <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed">{pretty(file.text)}</pre>;
    return <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed">{file.text}</pre>;
  }, [file, source]);
  return <div className={cn('flex min-h-0 flex-col rounded-md border bg-background', className)}>
    <div className="flex min-h-[34px] items-center gap-1.5 border-b px-2.5 py-1">
      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={file?.path ?? path}>{file?.rel || fileName(path)}</span>
      {file && <span className="shrink-0 text-[11px] text-faint">{formatBytes(file.size)}</span>}
      {file?.kind === 'markdown' && <Button size="sm" variant="ghost" aria-pressed={source} onClick={() => setSource(value => !value)}><Code2 />{source ? 'Xem bản đẹp' : 'Xem nguồn'}</Button>}
      {openFile && <Button size="sm" variant="ghost" onClick={() => openFile(file?.path ?? path)}><ExternalLink />Mở</Button>}
      <CopyButton text={file?.path ?? path} label="Sao chép đường dẫn" />
    </div>
    <div className={cn('min-h-0 flex-1 overflow-auto p-3', bodyClassName)}>
      {error && <p role="alert" className="m-0 flex items-center gap-1.5 text-[12.5px] text-danger"><CircleAlert className="size-3.5" />Không đọc được file: {error}</p>}
      {!file && !error && <p className="m-0 text-[12.5px] text-muted-foreground">Đang đọc file…</p>}
      {file?.truncated && <p className="m-0 mb-2 rounded-md bg-attention/12 px-2 py-1 text-[11.5px] text-fg-2">File dài hơn giới hạn xem trước (512 kB); chỉ hiện phần đầu.</p>}
      {body}
    </div>
  </div>;
}

/** Several files: one tab per file name; a single file without tabs. */
export function FileTabs({ paths, version, bodyClassName }: { paths: string[]; version?: unknown; bodyClassName?: string }) {
  const [tab, setTab] = useState(paths[0] ?? '');
  useEffect(() => { if (!paths.includes(tab)) setTab(paths[0] ?? ''); }, [paths, tab]);
  if (!paths.length) return null;
  if (paths.length === 1) return <FilePreview path={paths[0]!} version={version} {...(bodyClassName ? { bodyClassName } : {})} />;
  return <Tabs value={tab} onValueChange={setTab}>
    <TabsList className="flex-wrap gap-x-4 gap-y-0">{paths.map(path => <TabsTrigger key={path} value={path} title={path} className="font-mono text-[11.5px]">{fileName(path)}</TabsTrigger>)}</TabsList>
    {paths.map(path => <TabsContent key={path} value={path} className="pt-2"><FilePreview path={path} version={version} {...(bodyClassName ? { bodyClassName } : {})} /></TabsContent>)}
  </Tabs>;
}
