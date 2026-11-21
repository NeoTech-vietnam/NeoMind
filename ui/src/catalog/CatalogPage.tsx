/**
 * "Kỹ năng & Agent": the project's skills and roles (agent definitions), where each one is used, and a preview of
 * the SKILL.md or role file. Read-only; a step's binding is changed from its step panel ("Sửa").
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { BookOpen, Bot, CircleAlert, Code2, ExternalLink, FileText, RefreshCw, Search, TriangleAlert } from 'lucide-react';
import { CopyButton } from '@/components/CopyButton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Callout, EmptyState } from '@/components/ui/misc';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { formatBytes } from '../format';
import { hostHooks } from '../host';
import { Markdown } from '../Markdown';
import { shortHash, useCatalog, useCatalogDetail } from './api';
import { SourceBadge } from './BindingBadges';
import { ROLE_SOURCE_LABEL, type RoleDetail, type RoleEntry, type RoleSource, type SkillDetail, type SkillEntry, type StepRef } from './types';

export type CatalogKind = 'skill' | 'role';
export type CatalogSelection = { kind: CatalogKind; id: string };

/** Front matter (`---` … `---`) split from a Markdown file; values kept as text. */
export function splitFrontmatter(text: string): { meta: [string, string][]; body: string } {
  const match = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { meta: [], body: text };
  const meta: [string, string][] = [];
  for (const line of match[1]!.split(/\r?\n/)) {
    const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (pair) meta.push([pair[1]!, pair[2]!.replace(/^["']|["']$/g, '')]);
    else if (meta.length && /^\s+\S/.test(line)) meta[meta.length - 1]![1] += ` ${line.trim()}`;
  }
  return { meta, body: text.slice(match[0].length) };
}

const joinPath = (root: string | null | undefined, path: string) => root ? `${root.replace(/[\\/]+$/, '')}${root.includes('\\') ? '\\' : '/'}${path.replace(/\//g, root.includes('\\') ? '\\' : '/')}` : path;

/** "workflow › step" chips; a click opens the workflow. */
export function UsedBy({ refs, onOpen, empty = 'Chưa bước nào dùng.' }: { refs: StepRef[] | undefined; onOpen?: ((workflow: string, step: string) => void) | undefined; empty?: string }) {
  if (!refs?.length) return <span className="text-[11.5px] text-faint">{empty}</span>;
  return <span className="flex flex-wrap gap-1">{refs.map(ref => {
    const text = <><span className="text-muted-foreground">{ref.workflow}</span><span className="text-faint">›</span>{ref.step}</>;
    const cls = 'inline-flex h-[18px] items-center gap-1 whitespace-nowrap rounded border bg-background px-1.5 font-mono text-[10.5px] text-fg-2';
    return onOpen ? <button key={`${ref.workflow}.${ref.step}`} type="button" className={cn(cls, 'cursor-pointer hover:bg-accent')} title={`Mở workflow ${ref.workflow}`}
      onClick={event => { event.stopPropagation(); onOpen(ref.workflow, ref.step); }}>{text}</button>
      : <span key={`${ref.workflow}.${ref.step}`} className={cls}>{text}</span>;
  })}</span>;
}

const roleSources = (role: RoleEntry) => Object.keys(role.sources ?? {}).sort((a, b) => ['claude', 'codex', 'langflow'].indexOf(a) - ['claude', 'codex', 'langflow'].indexOf(b));
const roleSize = (role: RoleEntry) => Object.values(role.sources ?? {}).reduce((sum, item) => sum + (item?.size ?? 0), 0);

function ListItem({ selected, onClick, icon, id, name, missing, badges, size, description, usedBy, onOpenWorkflow }: {
  selected: boolean; onClick(): void; icon: ReactNode; id: string; name?: string | undefined; missing?: boolean | undefined; badges: ReactNode; size?: number | undefined;
  description?: string | undefined; usedBy?: StepRef[] | undefined; onOpenWorkflow?: ((workflow: string, step: string) => void) | undefined }) {
  return <li>
    <div role="button" tabIndex={0} aria-current={selected ? 'true' : undefined} onClick={onClick} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick(); } }}
      className={cn('flex cursor-pointer flex-col gap-1 rounded-md px-2.5 py-2 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring', selected && 'bg-accent')}>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="text-muted-foreground [&_svg]:size-3.5">{icon}</span>
        <span className="min-w-0 truncate font-mono text-[12.5px] font-medium text-foreground">{id}</span>
        {name && name !== id && <span className="min-w-0 truncate text-[11.5px] text-muted-foreground">{name}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1">{badges}{size !== undefined && size > 0 && <span className="text-[10.5px] tabular-nums text-faint">{formatBytes(size)}</span>}</span>
      </span>
      {missing ? <span className="flex items-center gap-1 text-[11.5px] text-danger"><CircleAlert className="size-3" />Có bước dùng nhưng không tìm thấy file</span>
        : description && <span className="line-clamp-2 text-[11.5px] leading-snug text-muted-foreground">{description}</span>}
      <span className="flex items-start gap-1.5 text-[11px] text-faint"><span className="shrink-0 pt-px">dùng ở</span><UsedBy refs={usedBy} onOpen={onOpenWorkflow} empty="—" /></span>
    </div>
  </li>;
}

/** Path, size, hash, copy and open-in-Nimbalyst for one file. */
function FileBar({ path, size, sha256, root, source, onSource }: { path: string; size?: number | undefined; sha256?: string | undefined; root?: string | null | undefined; source?: boolean; onSource?: (() => void) | undefined }) {
  const openFile = hostHooks().openFile, full = joinPath(root, path);
  return <div className="flex min-h-[34px] items-center gap-1.5 border-b px-2.5 py-1">
    <FileText className="size-3.5 shrink-0 text-muted-foreground" />
    <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={full}>{path}</span>
    {sha256 && <span className="shrink-0 font-mono text-[10.5px] text-faint" title={`sha256 ${sha256}`}>#{shortHash(sha256)}</span>}
    {size !== undefined && <span className="shrink-0 text-[11px] text-faint">{formatBytes(size)}</span>}
    {onSource && <Button size="sm" variant="ghost" aria-pressed={source} onClick={onSource}><Code2 />{source ? 'Xem bản đẹp' : 'Xem nguồn'}</Button>}
    {openFile && root && <Button size="sm" variant="ghost" onClick={() => openFile(full)}><ExternalLink />Mở</Button>}
    <CopyButton text={full} label="Sao chép đường dẫn" />
  </div>;
}

function Meta({ rows }: { rows: [string, ReactNode][] }) {
  const shown = rows.filter(([, value]) => value !== null && value !== undefined && value !== '');
  if (!shown.length) return null;
  return <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]">
    {shown.map(([label, value]) => <div key={label} className="contents"><dt className="text-muted-foreground">{label}</dt><dd className="m-0 min-w-0 break-words">{value}</dd></div>)}
  </dl>;
}

function SkillPreview({ entry, root, onOpenWorkflow }: { entry: SkillEntry; root?: string | null | undefined; onOpenWorkflow?: ((workflow: string, step: string) => void) | undefined }) {
  const { detail, error } = useCatalogDetail('skill', entry.missing ? null : entry.id, entry.sha256);
  const [source, setSource] = useState(false);
  const skill = detail as SkillDetail | null, parts = useMemo(() => skill ? splitFrontmatter(skill.text) : null, [skill]);
  return <div className="flex min-h-0 flex-col gap-3">
    <header className="flex flex-col gap-1.5">
      <h2 className="m-0 flex items-center gap-2 text-[16px] font-semibold"><BookOpen className="size-4 text-muted-foreground" /><span className="font-mono">{entry.id}</span>
        {entry.source && <SourceBadge kind="skill" source={entry.source} />}</h2>
      {entry.name && entry.name !== entry.id && <p className="m-0 text-[13px] font-medium text-fg-2">{entry.name}</p>}
      {entry.description && <p className="m-0 text-[12.5px] leading-relaxed text-fg-2">{entry.description}</p>}
      <Meta rows={[['Dùng ở', <UsedBy refs={entry.used_by} onOpen={onOpenWorkflow} />],
        ['File kèm', entry.files?.length ? <span className="flex flex-col gap-0.5 font-mono text-[11px]">{entry.files.slice(0, 30).map(file => <span key={file} className="truncate" title={file}>{file}</span>)}
          {entry.files.length > 30 && <span className="text-faint">… và {entry.files.length - 30} file nữa</span>}</span> : null],
        ['Bản bị che', entry.shadowed?.length ? <span className="flex flex-col gap-0.5">{entry.shadowed.map(copy => <span key={copy.path} className="font-mono text-[11px] text-muted-foreground" title="Bản trùng id ở nguồn ưu tiên thấp hơn; không được dùng">{copy.path}</span>)}</span> : null]]} />
    </header>
    {entry.missing ? <Callout tone="danger" icon={<CircleAlert />}>Không có <code className="font-mono">{entry.id}/SKILL.md</code> trong .langflow/skills, .agents/skills, .claude/skills hay skill_dirs. Run dùng skill này sẽ không bắt đầu.</Callout>
      : <div className="flex min-h-0 flex-col rounded-md border bg-background">
        <FileBar path={skill?.path ?? entry.path ?? ''} size={skill?.size ?? entry.size} sha256={skill?.sha256 ?? entry.sha256} root={root} source={source} onSource={() => setSource(value => !value)} />
        <div className="min-h-0 overflow-auto p-3">
          {error && <p role="alert" className="m-0 flex items-center gap-1.5 text-[12.5px] text-danger"><CircleAlert className="size-3.5" />Không đọc được skill: {error}</p>}
          {!skill && !error && <p className="m-0 text-[12.5px] text-muted-foreground">Đang đọc SKILL.md…</p>}
          {skill && parts && (source ? <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed">{skill.text}</pre>
            : <>{parts.meta.length > 0 && <div className="mb-3 rounded-md bg-muted px-2.5 py-2"><Meta rows={parts.meta.map(([key, value]) => [key, value])} /></div>}<Markdown text={parts.body} /></>)}
        </div>
      </div>}
  </div>;
}

function RoleSourceView({ name, file, root }: { name: string; file: RoleSource; root?: string | null | undefined }) {
  const [source, setSource] = useState(false);
  const text = file.text ?? '', markdown = name !== 'codex';
  const body = markdown ? (file.instructions ?? splitFrontmatter(text).body) : file.instructions ?? '';
  return <div className="flex min-h-0 flex-col gap-2.5">
    <Meta rows={[['Model', file.model ? <code className="font-mono">{file.model}</code> : null], ['Effort', file.effort ? <code className="font-mono">{file.effort}</code> : null],
      ['Tools', file.tools?.length ? <span className="font-mono text-[11.5px]">{file.tools.join(', ')}</span> : null]]} />
    <div className="flex min-h-0 flex-col rounded-md border bg-background">
      <FileBar path={file.path} size={file.size} sha256={file.sha256} root={root} source={source} onSource={() => setSource(value => !value)} />
      <div className="min-h-0 overflow-auto p-3">
        {!file.text && file.instructions === undefined ? <p className="m-0 text-[12.5px] text-muted-foreground">Đang đọc file…</p>
          : source ? <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed">{text}</pre>
          : body.trim() ? <Markdown text={body} /> : <p className="m-0 text-[12.5px] text-muted-foreground">File không có phần hướng dẫn.</p>}
      </div>
    </div>
  </div>;
}

function RolePreview({ entry, root, onOpenWorkflow }: { entry: RoleEntry; root?: string | null | undefined; onOpenWorkflow?: ((workflow: string, step: string) => void) | undefined }) {
  const hashes = Object.values(entry.sources ?? {}).map(item => item?.sha256 ?? '').join(',');
  const { detail, error } = useCatalogDetail('role', entry.missing ? null : entry.id, hashes);
  const role = (detail as RoleDetail | null) ?? null, names = roleSources(role ?? entry);
  const [tab, setTab] = useState(names[0] ?? '');
  useEffect(() => { if (!names.includes(tab)) setTab(names[0] ?? ''); }, [names.join(','), tab]);
  return <div className="flex min-h-0 flex-col gap-3">
    <header className="flex flex-col gap-1.5">
      <h2 className="m-0 flex items-center gap-2 text-[16px] font-semibold"><Bot className="size-4 text-muted-foreground" /><span className="font-mono">{entry.id}</span>
        {names.map(name => <SourceBadge key={name} kind="role" source={name} />)}</h2>
      {entry.name && entry.name !== entry.id && <p className="m-0 text-[13px] font-medium text-fg-2">{entry.name}</p>}
      {entry.description && <p className="m-0 text-[12.5px] leading-relaxed text-fg-2">{entry.description}</p>}
      <Meta rows={[['Dùng ở', <UsedBy refs={entry.used_by} onOpen={onOpenWorkflow} />]]} />
      {!entry.missing && <p className="m-0 text-[11.5px] leading-relaxed text-muted-foreground">Claude đọc file Claude (chạy native bằng <code className="font-mono">--agent</code>), Codex đọc file Codex; không có file riêng thì phần hướng dẫn của file khác được đưa vào prompt. Model, effort và tools chỉ áp dụng từ file của chính CLI đó.</p>}
    </header>
    {entry.missing ? <Callout tone="danger" icon={<CircleAlert />}>Không có <code className="font-mono">.claude/agents/{entry.id}.md</code>, <code className="font-mono">.codex/agents/{entry.id}.toml</code> hay <code className="font-mono">.langflow/agents/{entry.id}.md</code>. Run dùng role này sẽ không bắt đầu.</Callout>
      : error ? <p role="alert" className="m-0 flex items-center gap-1.5 text-[12.5px] text-danger"><CircleAlert className="size-3.5" />Không đọc được role: {error}</p>
      : names.length === 1 ? <RoleSourceView name={names[0]!} file={(role ?? entry).sources![names[0]!]!} root={root} />
      : <Tabs value={tab} onValueChange={setTab}>
        <TabsList>{names.map(name => <TabsTrigger key={name} value={name}>{ROLE_SOURCE_LABEL[name] ?? name}</TabsTrigger>)}</TabsList>
        {names.map(name => <TabsContent key={name} value={name} className="pt-3"><RoleSourceView name={name} file={(role ?? entry).sources![name]!} root={root} /></TabsContent>)}
      </Tabs>}
  </div>;
}

/** The page. `selection` / `onSelect` let the parent open a given skill or role (from a step panel link). */
export function CatalogPage({ root, selection, onSelect, onOpenWorkflow }: {
  root?: string | null | undefined; selection?: CatalogSelection | null | undefined; onSelect?: ((selection: CatalogSelection) => void) | undefined;
  onOpenWorkflow?: ((workflow: string, step: string) => void) | undefined }) {
  const { catalog, error, loading, reload } = useCatalog();
  const [own, setOwn] = useState<CatalogSelection | null>(null), [query, setQuery] = useState('');
  const current = selection ?? own;
  const [tab, setTab] = useState<CatalogKind>(current?.kind ?? 'skill');
  useEffect(() => { if (current) setTab(current.kind); }, [current?.kind, current?.id]);
  useEffect(() => { void reload(); }, [reload]);
  const select = (next: CatalogSelection) => { setOwn(next); onSelect?.(next); };

  const needle = query.trim().toLowerCase();
  const match = (entry: { id: string; name?: string | undefined; description?: string | undefined }) => !needle || [entry.id, entry.name, entry.description].some(text => text?.toLowerCase().includes(needle));
  const skills = (catalog?.skills ?? []).filter(match), roles = (catalog?.roles ?? []).filter(match);

  // Nothing chosen yet: the first entry of the open tab.
  useEffect(() => {
    if (!catalog || current) return;
    const first = tab === 'skill' ? catalog.skills[0] : catalog.roles[0];
    if (first) setOwn({ kind: tab, id: first.id });
  }, [catalog, current, tab]);

  if (error && !catalog) return <EmptyState icon={<CircleAlert />} title="Không đọc được danh mục skill và agent" action={<Button onClick={() => void reload()}><RefreshCw />Thử lại</Button>}>{error}</EmptyState>;
  if (!catalog) return <p className="m-0 p-6 text-[12.5px] text-muted-foreground">Đang đọc skill và agent…</p>;

  const skill = current?.kind === 'skill' ? catalog.skills.find(item => item.id === current.id) : undefined;
  const role = current?.kind === 'role' ? catalog.roles.find(item => item.id === current.id) : undefined;

  return <div className="grid h-full min-h-0 grid-cols-[360px_minmax(0,1fr)]">
    <aside className="flex min-h-0 flex-col border-r" aria-label="Skill và agent">
      <div className="flex flex-col gap-2 px-3 pt-3">
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1"><Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
            <Input aria-label="Tìm skill hoặc agent" placeholder="Tìm theo id, tên, mô tả" value={query} onChange={event => setQuery(event.target.value)} className="pl-7" spellCheck={false} /></div>
          <Button variant="ghost" size="icon" aria-label="Đọc lại danh mục" disabled={loading} onClick={() => void reload()}><RefreshCw className={cn(loading && 'animate-spin')} /></Button>
        </div>
        <Tabs value={tab} onValueChange={value => { const kind = value as CatalogKind; setTab(kind);
          if (current?.kind !== kind) { const first = (kind === 'skill' ? skills : roles)[0]; if (first) select({ kind, id: first.id }); } }}>
          <TabsList><TabsTrigger value="skill" count={catalog.skills.length}>Kỹ năng</TabsTrigger><TabsTrigger value="role" count={catalog.roles.length}>Agent (role)</TabsTrigger></TabsList>
        </Tabs>
        <p className="m-0 text-[11px] leading-relaxed text-muted-foreground" title="[catalog] trong config.toml (hoặc mặc định); từng bước đổi được ở bindings.toml hoặc ai(...)">
          Mặc định project: skill_mode <code className="font-mono">{catalog.skill_mode ?? 'inject'}</code> · native_fallback <code className="font-mono">{catalog.native_fallback ?? 'system'}</code>
          {' '}· retry_mode <code className="font-mono">{catalog.retry_mode ?? 'fresh'}</code> · role_mode <code className="font-mono">{catalog.role_mode ?? 'tự động'}</code>
          {catalog.contract === false && <> · contract <code className="font-mono">off</code></>}</p>
      </div>
      {catalog.warnings?.length ? <div className="px-3 pt-2"><Callout tone="attention" icon={<TriangleAlert />}><ul className="m-0 pl-4">{catalog.warnings.map(item => <li key={item} className="break-words font-mono text-[11px]">{item}</li>)}</ul></Callout></div> : null}
      <ul className="m-0 flex min-h-0 flex-1 list-none flex-col gap-px overflow-auto p-2">
        {tab === 'skill' && (skills.length ? skills.map(item => <ListItem key={item.id} selected={current?.kind === 'skill' && current.id === item.id} onClick={() => select({ kind: 'skill', id: item.id })}
          icon={<BookOpen />} id={item.id} name={item.name} missing={item.missing} badges={item.source ? <SourceBadge kind="skill" source={item.source} /> : null} size={item.size}
          description={item.description} usedBy={item.used_by} onOpenWorkflow={onOpenWorkflow} />)
          : <li className="px-2 py-3 text-[12px] text-muted-foreground">{needle ? 'Không skill nào khớp.' : <>Chưa có skill. Thêm <code className="font-mono">&lt;id&gt;/SKILL.md</code> vào <code className="font-mono">.langflow/skills</code>, <code className="font-mono">.agents/skills</code> hoặc <code className="font-mono">.claude/skills</code>.</>}</li>)}
        {tab === 'role' && (roles.length ? roles.map(item => <ListItem key={item.id} selected={current?.kind === 'role' && current.id === item.id} onClick={() => select({ kind: 'role', id: item.id })}
          icon={<Bot />} id={item.id} name={item.name} missing={item.missing} badges={roleSources(item).map(name => <SourceBadge key={name} kind="role" source={name} />)} size={roleSize(item)}
          description={item.description} usedBy={item.used_by} onOpenWorkflow={onOpenWorkflow} />)
          : <li className="px-2 py-3 text-[12px] text-muted-foreground">{needle ? 'Không agent nào khớp.' : <>Chưa có agent. Thêm <code className="font-mono">.claude/agents/&lt;id&gt;.md</code>, <code className="font-mono">.codex/agents/&lt;id&gt;.toml</code> hoặc <code className="font-mono">.langflow/agents/&lt;id&gt;.md</code>.</>}</li>)}
      </ul>
    </aside>
    <div className="flex min-h-0 flex-col overflow-auto px-6 py-5">
      {skill ? <SkillPreview key={`s:${skill.id}`} entry={skill} root={root} onOpenWorkflow={onOpenWorkflow} />
        : role ? <RolePreview key={`r:${role.id}`} entry={role} root={root} onOpenWorkflow={onOpenWorkflow} />
        : <EmptyState icon={tab === 'skill' ? <BookOpen /> : <Bot />} title={current ? `Không có ${current.kind === 'skill' ? 'skill' : 'agent'} ${current.id}` : 'Chọn một mục'}>Chọn một skill hoặc agent ở cột trái để xem nội dung.</EmptyState>}
    </div>
  </div>;
}
