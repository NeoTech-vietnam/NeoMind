import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleAlert, MousePointerClick } from 'lucide-react';
import { api, ApiError } from './api';
import { Callout, EmptyState } from '@/components/ui/misc';
import { usePoll } from '@/lib/poll';
import { DashboardPage } from './Dashboard';
import { NotifyButton, ToastHost, useBrowserNotifications, useGateAlerts } from './notify';
import { RunList } from './RunList';
import { RunView } from './RunView';
import { SchedulesPage } from './Schedules';
import { AppRoot, Shell, type ShellKind, type View } from './shell/AppShell';
import { StartRunDialog, WorkflowsPage } from './Workflows';
import { CatalogPage, type CatalogSelection } from './catalog/CatalogPage';
import { setCatalogNav } from './catalog/nav';
import type { Project, RunSummary, Workflow } from './types';

type Route = { view: View; run?: string | undefined; workflow?: string | undefined; step?: string | undefined; catalog?: CatalogSelection | undefined };
const pages: View[] = ['workflows', 'catalog', 'dashboard', 'schedules'];
/** Web only: the URL hash keeps the view and the open run, so a reload or a shared link opens the same run. */
function readHash(): Route {
  const [view, ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  if (view === 'catalog' && (rest[0] === 'skill' || rest[0] === 'role') && rest.length > 1) return { view, catalog: { kind: rest[0], id: decodeURIComponent(rest.slice(1).join('/')) } };
  if (view === 'workflows' && rest.length) return { view, workflow: decodeURIComponent(rest[0]!), step: rest[1] ? decodeURIComponent(rest[1]) : undefined };
  if (pages.includes(view as View)) return { view: view as View };
  return { view: 'runs', run: rest.length ? decodeURIComponent(rest.join('/')) : undefined };
}
function writeHash(route: Route) {
  const next = route.view === 'catalog' && route.catalog ? `#/catalog/${route.catalog.kind}/${encodeURIComponent(route.catalog.id)}`
    : route.view === 'workflows' && route.workflow ? `#/workflows/${encodeURIComponent(route.workflow)}${route.step ? `/${encodeURIComponent(route.step)}` : ''}`
    : route.view !== 'runs' ? `#/${route.view}` : route.run ? `#/runs/${encodeURIComponent(route.run)}` : '#/runs';
  if (location.hash !== next) history.replaceState(null, '', next);
}

function Main({ shell }: { shell: ShellKind }) {
  const [route, setRoute] = useState<Route>(() => shell === 'web' ? readHash() : { view: 'runs' });
  const [project, setProject] = useState<Project | null>(null), [runs, setRuns] = useState<RunSummary[]>([]), [loaded, setLoaded] = useState(false);
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null), [workflowError, setWorkflowError] = useState('');
  const [error, setError] = useState<{ message: string; status: number } | null>(null);
  const [starting, setStarting] = useState<{ open: boolean; workflow: string | null }>({ open: false, workflow: null });

  useEffect(() => { if (shell === 'web') writeHash(route); }, [route, shell]);
  useEffect(() => {
    if (shell !== 'web') return;
    const onHash = () => setRoute(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [shell]);

  const loadRuns = useCallback(async () => {
    try { setRuns(await api<RunSummary[]>('/api/runs')); setLoaded(true); setError(null); }
    catch (e) { setError({ message: e instanceof Error ? e.message : String(e), status: e instanceof ApiError ? e.status : 0 }); }
  }, []);
  usePoll(loadRuns, 2000, []);
  usePoll(async () => { if (project) return; setProject(await api<Project>('/api/project')); }, project ? 60000 : 5000, [project === null]);
  const loadWorkflows = useCallback(async () => {
    try { setWorkflows(await api<Workflow[]>('/api/workflows')); setWorkflowError(''); }
    catch (e) { setWorkflowError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void loadWorkflows(); }, [loadWorkflows]);
  useEffect(() => { if (route.view === 'workflows' || route.view === 'schedules') void loadWorkflows(); }, [route.view, loadWorkflows]);

  // After a delete the user is back on the run list with no run open; do not auto-open another one until they pick.
  const stayOnList = useRef(false);
  // Inside the panel there is no URL: open the run that waits for the user, else the newest one.
  useEffect(() => {
    if (route.view !== 'runs' || route.run || !runs.length || stayOnList.current) return;
    if (shell === 'panel' || !location.hash.startsWith('#/runs/')) setRoute({ view: 'runs', run: (runs.find(item => item.status === 'waiting') ?? runs[0])!.run });
  }, [runs, route, shell]);

  const openRun = useCallback((run: string) => { stayOnList.current = false; setRoute({ view: 'runs', run }); }, []);
  /** Runs were deleted (run header, "Xoá đã chọn", "Dọn run cũ"): drop them at once, close the open one if it went, reload the list. */
  const runsDeleted = useCallback((names: string[]) => {
    setRuns(current => current.filter(item => !names.includes(item.run)));
    setRoute(current => current.view === 'runs' && current.run && names.includes(current.run) ? (stayOnList.current = true, { view: 'runs' }) : current);
    void loadRuns();
  }, [loadRuns]);
  // Skill/role chips in step panels open the catalog; "dùng ở" chips open the workflow (phase 2b).
  const openCatalog = useCallback((catalog: CatalogSelection) => setRoute({ view: 'catalog', catalog }), []);
  const openWorkflow = useCallback((workflow: string, step?: string) => setRoute({ view: 'workflows', workflow, step }), []);
  useEffect(() => { setCatalogNav({ openCatalog, openWorkflow }); return () => setCatalogNav({}); }, [openCatalog, openWorkflow]);
  const startNew = (workflow: string | null = null) => { void loadWorkflows(); setStarting({ open: true, workflow }); };
  const browser = useBrowserNotifications();
  const waiting = useGateAlerts({ runs, loaded, shell, browser: shell === 'web' ? browser : null, openRun });

  const banner = error && <div className="px-4 pt-3"><Callout tone="danger" icon={<CircleAlert />}>
    {error.status === 401 ? <span>Server từ chối yêu cầu: token sai hoặc đã cũ (mỗi lần <code className="font-mono">langflow web</code> khởi động lại có token mới).{' '}
      {shell === 'web' && <button type="button" className="cursor-pointer border-0 bg-transparent p-0 font-sans text-[12.5px] text-foreground underline" onClick={() => location.reload()}>Tải lại trang</button>}</span>
      : `Không kết nối được langflow web: ${error.message}`}</Callout></div>;

  const page = route.view === 'runs' ? <div className="grid h-full min-h-0 grid-cols-[280px_minmax(0,1fr)]">
    <RunList runs={runs} selected={route.run} open={openRun} startNew={() => startNew()} loaded={loaded} onDeleted={runsDeleted} />
    <div className="min-h-0 overflow-auto">
      {route.run ? <RunView key={route.run} name={route.run} approver={project?.approver} answeredAs={project?.user ? `${shell}:${project.user}` : undefined} onChanged={() => void loadRuns()} onDeleted={run => runsDeleted([run])} />
        : <EmptyState icon={<MousePointerClick />} title={loaded && !runs.length ? 'Chưa có run' : 'Chọn một run'}>
          {loaded && !runs.length ? 'Bắt đầu một run từ trang Workflows hoặc nút “Run mới”.' : 'Chọn một run ở cột trái để xem sơ đồ, log và memory.'}</EmptyState>}
    </div>
  </div> : route.view === 'dashboard' ? <DashboardPage />
    : route.view === 'schedules' ? <SchedulesPage workflows={workflows} />
    : route.view === 'catalog' ? <CatalogPage root={project?.root} selection={route.catalog} onSelect={openCatalog} onOpenWorkflow={openWorkflow} />
    : <WorkflowsPage workflows={workflows} error={workflowError} startRun={workflow => startNew(workflow.name)}
      selected={route.workflow} step={route.step} onSelect={(workflow, step) => setRoute({ view: 'workflows', workflow, step })} />;

  return <Shell shell={shell} view={route.view} onView={view => setRoute(view === 'runs' ? { view, run: route.run ?? runs[0]?.run } : { view })} project={project} waiting={waiting}
    {...(shell === 'web' ? { actions: <NotifyButton notifications={browser} /> } : {})}>
    <div className="flex h-full min-h-0 flex-col">
      {banner}
      <div className="min-h-0 flex-1">{page}</div>
    </div>
    <ToastHost openRun={openRun} />
    <StartRunDialog workflows={workflows ?? []} initial={starting.workflow} open={starting.open} onOpenChange={open => setStarting(current => ({ ...current, open }))}
      onStarted={run => { void loadRuns(); openRun(run); }} />
  </Shell>;
}

/** The langflow UI. `shell="web"` for `langflow web`; `shell="panel"` inside the Nimbalyst extension (no URL, host theme). */
export default function App({ shell = 'web' }: { shell?: ShellKind }) {
  return <AppRoot shell={shell}><Main shell={shell} /></AppRoot>;
}
