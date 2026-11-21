/**
 * App frame shared by the web page and the Nimbalyst panel (from NeoMind's AppShell).
 * Web: a 48px header with the logo, the two views, the project and the theme toggle.
 * Panel: a 40px tab bar only, because Nimbalyst already shows its own navigation and theme around it.
 */
import { useState, type ReactNode } from 'react';
import { BarChart3, BookOpen, CalendarClock, Moon, Play, Sun, UserRound, Workflow } from 'lucide-react';
import { DialogHost } from '@/dialog';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipProvider } from '@/components/ui/tooltip';
import { PortalContainer } from '@/lib/portal';
import { ThemeProvider, useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';
import type { Project } from '@/types';

export type ShellKind = 'web' | 'panel';
export type View = 'runs' | 'workflows' | 'catalog' | 'dashboard' | 'schedules';

const views: { id: View; label: string; icon: ReactNode }[] = [{ id: 'runs', label: 'Runs', icon: <Play /> }, { id: 'workflows', label: 'Workflows', icon: <Workflow /> },
  { id: 'catalog', label: 'Kỹ năng & Agent', icon: <BookOpen /> },
  { id: 'dashboard', label: 'Dashboard', icon: <BarChart3 /> }, { id: 'schedules', label: 'Lịch', icon: <CalendarClock /> }];

/** Theme, portal target, tooltips and in-page dialogs: everything the screens need before they render. */
export function AppRoot({ shell, children }: { shell: ShellKind; children: ReactNode }) {
  return <ThemeProvider source={shell === 'panel' ? 'host' : 'web'}><ThemeFrame shell={shell}>{children}</ThemeFrame></ThemeProvider>;
}
function ThemeFrame({ shell, children }: { shell: ShellKind; children: ReactNode }) {
  const { theme } = useTheme(), [portal, setPortal] = useState<HTMLElement | null>(null);
  // The portal target sits inside the theme wrapper so dialogs and menus get the theme tokens and base text styles.
  return <div className={cn('lf-theme', `theme-${theme}`, shell === 'panel' ? 'h-full' : 'h-screen')}>
    <PortalContainer.Provider value={portal}><TooltipProvider delayDuration={300}>
      {children}<DialogHost />
    </TooltipProvider></PortalContainer.Provider>
    <div ref={setPortal} />
  </div>;
}

function Logo() {
  return <span className="flex items-center gap-2 text-[14px] font-semibold tracking-tight">
    <span className="grid size-[22px] place-items-center rounded-md bg-brand text-white">
      <svg viewBox="0 0 24 24" className="size-[13px]" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="5" r="2" /><circle cx="18" cy="12" r="2" /><circle cx="6" cy="19" r="2" /><path d="M8 5h3a3 3 0 0 1 3 3v1M8 19h3a3 3 0 0 0 3-3v-1" /></svg>
    </span>langflow</span>;
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return <Tooltip label={theme === 'dark' ? 'Chuyển sang theme sáng' : 'Chuyển sang theme tối'}>
    <Button variant="ghost" size="icon" aria-label="Đổi theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun /> : <Moon />}</Button>
  </Tooltip>;
}

function AttentionCount({ count }: { count: number }) {
  return count > 0 ? <span className="rounded-full bg-attention/12 px-1.5 text-[11px] font-semibold tabular-nums text-attention" aria-label={`${count} run chờ duyệt`}>{count}</span> : null;
}

/** `actions`: extra header controls (the web page's notification bell). */
export type ShellProps = { shell: ShellKind; view: View; onView(view: View): void; project: Project | null; waiting: number; actions?: ReactNode; children: ReactNode };

export function Shell({ shell, view, onView, project, waiting, actions, children }: ShellProps) {
  const tab = (item: (typeof views)[number], compact: boolean) => <button key={item.id} type="button" aria-current={view === item.id ? 'page' : undefined} onClick={() => onView(item.id)}
    className={cn('-mb-px flex cursor-pointer items-center gap-1.5 border-0 border-b-2 border-solid border-transparent bg-transparent px-0 font-sans text-muted-foreground hover:text-foreground [&_svg]:size-[14px]',
      compact ? 'text-[12.5px]' : 'text-[13px]', view === item.id && 'border-foreground font-semibold text-foreground')}>
    {!compact && item.icon}{item.label}{item.id === 'runs' && <AttentionCount count={waiting} />}</button>;
  const approver = project && <Tooltip label={project.allow_agent_approval ? 'Người duyệt gate; project này cho phép agent trả lời gate' : 'Người duyệt gate'}>
    <span className="inline-flex h-[24px] items-center gap-1.5 rounded-md border px-2 text-[12px] text-fg-2"><UserRound className="size-3.5 text-muted-foreground" />{project.approver}</span></Tooltip>;
  const content = <main className="relative min-h-0 min-w-0 overflow-hidden">{children}</main>;
  if (shell === 'panel') return <div className="grid h-full grid-rows-[40px_minmax(0,1fr)]">
    <nav className="flex items-stretch gap-[18px] border-b px-4" aria-label="langflow">
      {views.map(item => tab(item, true))}
      <span className="flex-1" />
      {project && <span className="flex items-center gap-2 text-[12px] text-muted-foreground"><Tooltip label={project.root}><span className="font-medium text-fg-2">{project.name}</span></Tooltip>{approver}</span>}
    </nav>
    {content}
  </div>;
  return <div className="grid h-full grid-rows-[48px_minmax(0,1fr)]">
    <header className="flex items-stretch gap-5 border-b px-4">
      <div className="flex items-center"><Logo /></div>
      <nav className="flex items-stretch gap-[18px]" aria-label="Điều hướng">{views.map(item => tab(item, false))}</nav>
      <span className="flex-1" />
      <div className="flex items-center gap-2">
        {project && <Tooltip label={project.root}><span className="inline-flex h-[26px] max-w-[420px] items-center gap-1.5 rounded-md border px-2.5 text-[12px] text-fg-2">
          <strong className="font-medium">{project.name}</strong><span className="truncate text-faint">{project.root}</span></span></Tooltip>}
        {approver}
        {project?.version && <span className="text-[11px] text-faint">v{project.version}</span>}
        {actions}
        <ThemeToggle />
      </div>
    </header>
    {content}
  </div>;
}
