/**
 * App frame shared by the browser editor and the Nimbalyst panel (docs/design/mockups/12-shell-v2.mockup.html).
 * Web: topbar + sidebar. Panel: a 40px tab bar only, because Nimbalyst already shows its own navigation around it.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Archive, Database, Moon, Play, Plus, Search, Sun, UserRound, Workflow } from 'lucide-react';
import { api } from '@/api';
import { DialogHost } from '@/dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Kbd } from '@/components/ui/misc';
import { Tooltip, TooltipProvider } from '@/components/ui/tooltip';
import { PortalContainer } from '@/lib/portal';
import { ThemeProvider, useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

export type ShellKind = 'web' | 'panel';
export type View = 'runs' | 'flows' | 'profiles' | 'memory';
export type FlowMeta = { flowId: string; name: string; archived: boolean };

export const views: { id: View; label: string; icon: ReactNode }[] = [
  { id: 'runs', label: 'Runs', icon: <Play /> }, { id: 'flows', label: 'Flows', icon: <Workflow /> },
  { id: 'profiles', label: 'Profiles', icon: <UserRound /> }, { id: 'memory', label: 'Memory', icon: <Database /> },
];

/** Theme, portal target, tooltips and in-page dialogs: everything the screens need before they render. */
export function AppRoot({ shell, children }: { shell: ShellKind; children: ReactNode }) {
  return <ThemeProvider source={shell === 'panel' ? 'host' : 'web'}><ThemeFrame shell={shell}>{children}</ThemeFrame></ThemeProvider>;
}
function ThemeFrame({ shell, children }: { shell: ShellKind; children: ReactNode }) {
  const { theme } = useTheme(), [portal, setPortal] = useState<HTMLElement | null>(null);
  // The portal target sits inside the theme wrapper so dialogs and menus get the theme tokens and base text styles.
  return <div className={cn('nm-theme', `theme-${theme}`, shell === 'panel' ? 'h-full' : 'h-screen')}>
    <PortalContainer.Provider value={portal}><TooltipProvider delayDuration={300}>
      {children}<DialogHost />
    </TooltipProvider></PortalContainer.Provider>
    <div ref={setPortal} />
  </div>;
}

/** Runs that wait for the user: a plan to approve or a blocked run to decide on. */
const needsYou = new Set(['waiting_approval', 'blocked']);
export function useAttentionCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let disposed = false;
    const load = () => api<{ runs: { phase: string }[] }>('/api/runs').then(({ runs }) => { if (!disposed) setCount(runs.filter(run => needsYou.has(run.phase)).length); }).catch(() => {});
    void load();
    const timer = setInterval(load, 5000);
    return () => { disposed = true; clearInterval(timer); };
  }, []);
  return count;
}

function Logo() {
  return <span className="flex items-center gap-2 text-[14px] font-semibold tracking-tight">
    <span className="grid size-[22px] place-items-center rounded-md bg-brand text-white">
      <svg viewBox="0 0 24 24" className="size-[13px]" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9" /></svg>
    </span>NeoMind</span>;
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return <Tooltip label={theme === 'dark' ? 'Chuyển sang theme sáng' : 'Chuyển sang theme tối'}>
    <Button variant="ghost" size="icon" aria-label="Đổi theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun /> : <Moon />}</Button>
  </Tooltip>;
}

function AttentionCount({ count }: { count: number }) {
  return count > 0 ? <span className="ml-auto rounded-full bg-attention/12 px-1.5 text-[11px] font-semibold tabular-nums text-attention" aria-label={`${count} run cần bạn`}>{count}</span> : null;
}

export type ShellProps = {
  shell: ShellKind; view: View; onView(view: View): void; projectName?: string | undefined; projectRoot?: string | undefined;
  flows: FlowMeta[]; currentFlowId?: string | undefined; onOpenFlow(flowId: string): void; onCreateFlow(): void; children: ReactNode;
};

export function Shell(props: ShellProps) {
  const attention = useAttentionCount(), [palette, setPalette] = useState(false);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPalette(open => !open); } };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, []);
  const content = <main className="min-h-0 min-w-0 overflow-auto">{props.children}</main>;
  const paletteDialog = <CommandPalette open={palette} onOpenChange={setPalette} {...props} />;
  if (props.shell === 'panel') return <div className="grid h-full grid-rows-[40px_minmax(0,1fr)]">
    <nav className="flex items-stretch gap-[18px] border-b px-4" aria-label="NeoMind">
      {views.map(item => <button key={item.id} type="button" aria-current={props.view === item.id ? 'page' : undefined} onClick={() => props.onView(item.id)}
        className={cn('-mb-px flex cursor-pointer items-center gap-1.5 border-0 border-b-2 border-solid border-transparent bg-transparent px-0 font-sans text-[12.5px] text-muted-foreground hover:text-foreground',
          props.view === item.id && 'border-foreground font-semibold text-foreground')}>
        {item.label}{item.id === 'runs' && <AttentionCount count={attention} />}</button>)}
      <span className="flex-1" />
      {props.view === 'flows' && <FlowSwitcher {...props} />}
      <div className="flex items-center"><Tooltip label="Tìm nhanh (Ctrl K)"><Button variant="ghost" size="icon-sm" aria-label="Tìm nhanh" onClick={() => setPalette(true)}><Search /></Button></Tooltip></div>
    </nav>
    {content}{paletteDialog}
  </div>;
  const active = props.flows.filter(flow => !flow.archived), archived = props.flows.filter(flow => flow.archived);
  return <div className="grid h-full grid-cols-[216px_minmax(0,1fr)] grid-rows-[48px_minmax(0,1fr)]">
    <header className="col-span-2 flex items-center gap-3 border-b px-4">
      <Logo />
      {props.projectName && <Tooltip label={props.projectRoot ?? props.projectName}>
        <span className="inline-flex h-[26px] max-w-[420px] items-center gap-1.5 rounded-md border px-2.5 text-[12px] text-fg-2">
          <strong className="font-medium">{props.projectName}</strong><span className="truncate text-faint">{props.projectRoot}</span></span>
      </Tooltip>}
      <span className="flex-1" />
      <Button variant="ghost" onClick={() => setPalette(true)}><Search />Tìm<Kbd>Ctrl K</Kbd></Button>
      <ThemeToggle />
    </header>
    <aside className="flex min-h-0 flex-col gap-px overflow-auto border-r px-2 py-2.5" aria-label="Điều hướng">
      {views.map(item => <button key={item.id} type="button" aria-current={props.view === item.id ? 'page' : undefined} onClick={() => props.onView(item.id)}
        className={cn('flex h-[30px] w-full cursor-pointer items-center gap-2.5 rounded-md border-0 bg-transparent px-2.5 text-left font-sans text-[13px] text-fg-2 hover:bg-accent hover:text-foreground [&_svg]:size-[15px] [&_svg]:text-muted-foreground',
          props.view === item.id && 'bg-accent font-semibold text-foreground')}>
        {item.icon}{item.label}{item.id === 'runs' && <AttentionCount count={attention} />}</button>)}
      <div className="mt-4 flex items-center justify-between px-2.5 pb-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Flows</span>
        <Tooltip label="Tạo flow"><Button variant="ghost" size="icon-sm" aria-label="Tạo flow" onClick={props.onCreateFlow}><Plus /></Button></Tooltip>
      </div>
      {active.length === 0 && <p className="m-0 px-2.5 text-[12.5px] text-muted-foreground">Chưa có flow</p>}
      {active.map(flow => <FlowLink key={flow.flowId} flow={flow} {...props} />)}
      {archived.length > 0 && <><div className="mt-3 flex items-center gap-1.5 px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"><Archive className="size-3" />Đã lưu trữ</div>
        {archived.map(flow => <FlowLink key={flow.flowId} flow={flow} {...props} />)}</>}
    </aside>
    {content}{paletteDialog}
  </div>;
}

function FlowLink({ flow, view, currentFlowId, onOpenFlow }: { flow: FlowMeta } & ShellProps) {
  const current = view === 'flows' && currentFlowId === flow.flowId;
  return <button type="button" onClick={() => onOpenFlow(flow.flowId)} aria-current={current ? 'page' : undefined}
    className={cn('flex h-7 w-full cursor-pointer items-center rounded-md border-0 bg-transparent px-2.5 text-left font-sans text-[13px] text-fg-2 hover:bg-accent hover:text-foreground', current && 'bg-accent font-semibold text-foreground', flow.archived && 'text-muted-foreground')}>
    <span className="truncate">{flow.name}</span></button>;
}

/** Panel only: there is no sidebar, so the Flows tab picks the flow from a menu. */
function FlowSwitcher({ flows, currentFlowId, onOpenFlow, onCreateFlow }: ShellProps) {
  const current = flows.find(flow => flow.flowId === currentFlowId);
  return <div className="flex items-center"><DropdownMenu>
    <DropdownMenuTrigger asChild><Button variant="ghost" size="sm"><Workflow />{current?.name ?? 'Chọn flow'}</Button></DropdownMenuTrigger>
    <DropdownMenuContent>
      {flows.filter(flow => !flow.archived).map(flow => <DropdownMenuItem key={flow.flowId} onSelect={() => onOpenFlow(flow.flowId)}>{flow.name}</DropdownMenuItem>)}
      <DropdownMenuSeparator /><DropdownMenuItem onSelect={onCreateFlow}><Plus />Tạo flow</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu></div>;
}

type Command = { id: string; group: string; label: string; hint?: string; run(): void };

/** Ctrl K: jump to a section or flow, or start a common action. */
function CommandPalette({ open, onOpenChange, ...props }: ShellProps & { open: boolean; onOpenChange(open: boolean): void }) {
  const { theme, setTheme } = useTheme(), [query, setQuery] = useState(''), [index, setIndex] = useState(0), list = useRef<HTMLDivElement>(null);
  const commands = useMemo<Command[]>(() => [
    { id: 'new-run', group: 'Hành động', label: 'Run mới', run: () => props.onView('runs') },
    { id: 'new-flow', group: 'Hành động', label: 'Tạo flow', run: props.onCreateFlow },
    { id: 'theme', group: 'Hành động', label: theme === 'dark' ? 'Chuyển sang theme sáng' : 'Chuyển sang theme tối', run: () => setTheme(theme === 'dark' ? 'light' : 'dark') },
    ...views.map(item => ({ id: `view-${item.id}`, group: 'Đi tới', label: item.label, run: () => props.onView(item.id) })),
    ...props.flows.filter(flow => !flow.archived).map(flow => ({ id: `flow-${flow.flowId}`, group: 'Flows', label: flow.name, hint: flow.flowId, run: () => props.onOpenFlow(flow.flowId) })),
  ], [props.flows, props.onView, props.onCreateFlow, props.onOpenFlow, theme, setTheme]);
  const needle = query.trim().toLocaleLowerCase();
  const shown = commands.filter(command => !needle || `${command.label} ${command.hint ?? ''} ${command.group}`.toLocaleLowerCase().includes(needle));
  useEffect(() => { setIndex(0); }, [query, open]);
  useEffect(() => { if (!open) setQuery(''); }, [open]);
  useEffect(() => { list.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' }); }, [index]);
  const choose = (command: Command | undefined) => { if (!command) return; onOpenChange(false); command.run(); };
  let lastGroup = '';
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent title="Tìm nhanh" className="top-[18%] w-[560px] translate-y-0 p-0 [&>h2]:sr-only" onKeyDown={event => {
      if (event.key === 'ArrowDown') { event.preventDefault(); setIndex(value => Math.min(value + 1, shown.length - 1)); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex(value => Math.max(value - 1, 0)); }
      else if (event.key === 'Enter') { event.preventDefault(); choose(shown[index]); }
    }}>
      <div className="flex items-center gap-2 border-b px-3.5"><Search className="size-4 text-muted-foreground" />
        <input autoFocus aria-label="Tìm flow, mục hoặc hành động" placeholder="Tìm flow, mục hoặc hành động…" value={query} onChange={event => setQuery(event.target.value)}
          className="h-11 flex-1 border-0 bg-transparent font-sans text-[13.5px] text-foreground outline-none placeholder:text-faint" /></div>
      <div ref={list} className="max-h-80 overflow-auto p-1.5" role="listbox" aria-label="Kết quả">
        {shown.length === 0 && <p className="m-0 px-3 py-6 text-center text-[12.5px] text-muted-foreground">Không có kết quả</p>}
        {shown.map((command, position) => {
          const header = command.group !== lastGroup ? command.group : ''; lastGroup = command.group;
          return <div key={command.id}>{header && <div className="px-2.5 pb-1 pt-2 text-[11px] font-semibold text-muted-foreground">{header}</div>}
            <button type="button" role="option" aria-selected={position === index} data-index={position} onMouseEnter={() => setIndex(position)} onClick={() => choose(command)}
              className={cn('flex h-8 w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2.5 text-left font-sans text-[13px] text-fg-2', position === index && 'bg-accent text-foreground')}>
              <span className="truncate">{command.label}</span>{command.hint && <span className="ml-auto truncate font-mono text-[11px] text-faint">{command.hint}</span>}</button></div>;
        })}
      </div>
      <div className="flex items-center gap-3 border-t px-3.5 py-2 text-[11px] text-muted-foreground"><span><Kbd>↑</Kbd> <Kbd>↓</Kbd> chọn</span><span><Kbd>Enter</Kbd> mở</span><span><Kbd>Esc</Kbd> đóng</span></div>
    </DialogContent>
  </Dialog>;
}
