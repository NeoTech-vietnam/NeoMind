/**
 * Step panel sections for phase 2b: the role and skills a step is bound to now (with "Sửa"), and in a run, the
 * binding the run used (short hashes) with "đã đổi từ lúc chạy" when a file changed since.
 */
import { useState, type ReactNode } from 'react';
import { BookOpen, Bot, PencilLine, RotateCcw, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/misc';
import { Tooltip } from '@/components/ui/tooltip';
import { asRecorded, bindingChanges, cliDiffers, isNative, ORIGIN_LABEL, shortHash, skillWarnings, useCatalog, useWorkflowBindings, type BindingChange } from './api';
import { ContractOffTag, OverrideTag, RetryModeBadge, RoleBadge, RoleModeBadge, SkillBadge, SkillViaBadge } from './BindingBadges';
import { BindingPicker } from './BindingPicker';
import type { CatalogSelection } from './CatalogPage';
import { FALLBACK_LABEL, MODE_KEYS, MODE_ORIGIN_LABEL, roleChannelLabel, ROLE_SOURCE_LABEL, skillChannelLabel, type ModeKey } from './types';

type OpenCatalog = ((selection: CatalogSelection) => void) | undefined;

const Section = ({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children: ReactNode }) => <section className="flex flex-col gap-1.5">
  <div className="flex min-h-6 items-center gap-2"><h4 className="m-0 text-[12px] font-semibold text-fg-2">{title}</h4><span className="ml-auto flex items-center gap-1">{actions}</span></div>
  {children}
</section>;
const Line = ({ label, children }: { label: string; children: ReactNode }) => <div className="flex items-start gap-2 text-[12px]"><span className="w-12 shrink-0 pt-px text-muted-foreground">{label}</span><span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">{children}</span></div>;

const FANOUT_VIA: Record<string, string> = { declared: 'khai báo trong fanout(..., role=, skills=)', worker: 'từ langflow_step của hàm worker', probe: 'đọc từ bước ai mà worker tạo ra' };

/** The binding of an ai step in a workflow (graph / steps table): effective role and skills, origin, and "Sửa". */
export function StepBindingSection({ workflow, step, onOpenCatalog, editable = true, title = 'Role và skill', note }: {
  workflow: string; step: string; onOpenCatalog?: OpenCatalog; editable?: boolean; title?: string; note?: ReactNode }) {
  const { row, rows, defaults, error } = useWorkflowBindings(workflow);
  const { catalog } = useCatalog();
  const [editing, setEditing] = useState(false);
  const current = row(step);
  if (error) return <Section title={title}><p className="m-0 text-[12px] text-danger">Không đọc được binding: {error}</p></Section>;
  if (!rows) return <Section title={title}><p className="m-0 text-[12px] text-muted-foreground">Đang đọc…</p></Section>;
  if (!current) return null; // not an ai step
  const { effective } = current, from = effective.from;
  const roleEntry = effective.role ? catalog?.roles.find(item => item.id === effective.role) : undefined;
  const missingRole = !!effective.role && !!catalog && (!roleEntry || !!roleEntry.missing);
  const missingSkill = (id: string) => !!catalog && !catalog.skills.some(item => item.id === id && !item.missing);
  const roleOverridden = from ? from.role !== 'code' : current.override?.role !== undefined;
  const skillsOverridden = from ? from.skills !== 'code' : current.override?.skills !== undefined || !!current.override?.skills_add?.length;
  // Native phase 1: how the role and skills reach the CLI (catalog.modes / step_detail); absent on an older server.
  const modes = current.modes, warnings = current.warnings ?? [];
  const detail = (id: string) => effective.skills_detail?.find(item => item.id === id);
  const modesOverridden = MODE_KEYS.filter(key => { const origin = from?.[key]; return origin === 'bindings' || origin === 'run'; });
  // every warning but the mode note (shown under the role line); skill lines are also the tooltip of their skill's icon
  const otherWarnings = warnings.filter(line => line !== modes?.note);
  const codeModes = MODE_KEYS.map(key => modeText(key, current.code[key])).filter(Boolean);
  const nativeStep = modes?.skill_mode === 'native' && effective.skills.length > 0;
  return <Section title={title} actions={<>
    <RetryModeBadge mode={modes?.retry_mode} from={modes?.from.retry_mode} />
    {modes && !modes.contract && <ContractOffTag from={modes.from.contract} />}
    {editable && <Button size="sm" variant="ghost" onClick={() => setEditing(true)}><PencilLine />Sửa</Button>}</>}>
    {note && <p className="m-0 text-[11px] text-muted-foreground">{note}</p>}
    {current.fanout && <p className="m-0 text-[11px] text-muted-foreground">Áp dụng cho mọi worker của fan-out <code className="font-mono">{current.step}</code>
      {' '}({FANOUT_VIA[current.fanout] ?? current.fanout}).</p>}
    <Line label="Role">{effective.role ? <>
        <RoleBadge id={effective.role} missing={missingRole} {...(onOpenCatalog ? { onClick: () => onOpenCatalog({ kind: 'role', id: effective.role! }) } : {})} />
        {modes?.role_mode ? <RoleModeBadge mode={modes.role_mode} from={modes.from.role_mode} note={modes.note} />
          : roleEntry && !missingRole && <span className="text-[11px] text-faint">{isNative(roleEntry, current.agent) ? `native (${ROLE_SOURCE_LABEL[current.agent ?? ''] ?? current.agent})` : 'đưa vào prompt'}</span>}
      </> : <span className="text-muted-foreground">không có</span>}
      {roleOverridden && <OverrideTag from={from?.role} />}</Line>
    {modes?.note && <p className="m-0 pl-14 text-[11px] text-attention">{modes.note}</p>}
    <Line label="Skill">{effective.skills.length ? effective.skills.map(id => { const use = detail(id), notes = skillWarnings(warnings, id);
        return <span key={id} className="inline-flex max-w-full items-center gap-0.5">
          <SkillBadge id={id} missing={missingSkill(id)} {...(onOpenCatalog ? { onClick: () => onOpenCatalog({ kind: 'skill', id }) } : {})} />
          {use && <SkillViaBadge via={use.via} warnings={notes} fallbackReason={use.fallback_reason} cliPath={use.cli && cliDiffers(use) ? `${use.cli.path} #${shortHash(use.cli.sha256)}` : null} />}
        </span>; })
      : <span className="text-muted-foreground">không có</span>}
      {skillsOverridden && <OverrideTag from={from?.skills} />}</Line>
    {nativeStep && <p className="m-0 pl-14 text-[11px] text-muted-foreground">skill_mode native{modes.from.skill_mode ? ` (${MODE_ORIGIN_LABEL[modes.from.skill_mode] ?? modes.from.skill_mode})` : ''}
      {' '}· <span title={FALLBACK_LABEL[modes.native_fallback ?? 'system'] ?? ''}>không nạp được thì <code className="font-mono">{modes.native_fallback ?? 'system'}</code>
        {modes.from.native_fallback && modes.from.native_fallback !== 'default' ? ` (${MODE_ORIGIN_LABEL[modes.from.native_fallback] ?? modes.from.native_fallback})` : ''}</span></p>}
    {(roleOverridden || skillsOverridden || modesOverridden.length > 0) && <p className="m-0 text-[11px] text-muted-foreground">
      Trong code: {current.code.role ? <code className="font-mono">role {current.code.role}</code> : 'không role'}, {current.code.skills.length ? <code className="font-mono">{current.code.skills.join(', ')}</code> : 'không skill'}
      {codeModes.length > 0 && <>, <code className="font-mono">{codeModes.join(', ')}</code></>}
      {' '}· đổi ở {ORIGIN_LABEL[(roleOverridden ? from?.role : skillsOverridden ? from?.skills : from?.[modesOverridden[0]!]) ?? 'bindings'] ?? 'bindings.toml'}
      {modesOverridden.length > 0 && <> ({modesOverridden.map(key => modeText(key, effective[key])).join(', ')})</>}.</p>}
    {otherWarnings.length > 0 && <Callout tone="attention" icon={<TriangleAlert />}><ul className="m-0 pl-4">{otherWarnings.map(item => <li key={item} className="break-words font-mono text-[11px]">{item}</li>)}</ul></Callout>}
    {current.problems?.length ? <Callout tone="danger" icon={<TriangleAlert />}>Run sẽ không bắt đầu (<code className="font-mono">langflow start</code> kiểm tra trước):
      <ul className="m-0 mt-1 pl-4">{current.problems.map(item => <li key={item} className="break-words font-mono text-[11px]">{item}</li>)}</ul></Callout>
      : (missingRole || effective.skills.some(missingSkill)) && <Callout tone="danger" icon={<TriangleAlert />}>Có role hoặc skill không tìm thấy file; <code className="font-mono">langflow start</code> sẽ từ chối workflow này.</Callout>}
    {editable && <BindingPicker workflow={workflow} row={current} defaults={defaults} open={editing} onOpenChange={setEditing} />}
  </Section>;
}

/** "role_mode append", "contract off", "retry_mode resume" for the "Trong code" line. */
function modeText(key: ModeKey, value: unknown): string {
  if (value === undefined || value === null) return '';
  if (key === 'contract') return value ? 'contract on' : 'contract off';
  return `${key} ${String(value)}`;
}

/** The role_channel values each role_mode can end in (a fallback, e.g. Codex without its launcher, is flagged).
 *  OpenCode append goes where [agents.opencode] role_channel says (instructions, or prompt by default): no flag. */
const channelsOf = (mode: string, agent?: string | null): string[] => agent === 'opencode' && mode === 'append' ? ['instructions', 'prompt']
  : ({ append: ['append', 'append-file', 'developer_instructions', 'instructions'], agent: ['agent'], prompt: ['prompt'] } as Record<string, string[]>)[mode] ?? [];

const changeText: Record<BindingChange['state'], string> = { changed: 'đã đổi từ lúc chạy', missing: 'file không còn', moved: 'bản khác đang được dùng' };

/**
 * The binding a run used for one step (`binding` from info[step] or its start event). `serverChanges`: the server's
 * own comparison (catalog.changes) when it sends one; otherwise the hashes are compared with the catalog here.
 */
export function RunBindingSection({ binding, serverChanges, onOpenCatalog, ran }: { binding: unknown; serverChanges?: string[] | null | undefined; onOpenCatalog?: OpenCatalog;
  /** Native phase 1: info[step].role_mode / contract (start event) and role_channel (done event: what really ran).
   *  Phase 2: skill_channel / skills_loaded (done event), native_fallback (ids that fell back in the run) and agent
   *  (the CLI, for the channel labels). */
  ran?: RanWith }) {
  const { catalog } = useCatalog();
  const recorded = asRecorded(binding);
  if (!recorded) return null;
  const changes = bindingChanges(recorded, catalog) ?? [];
  const changeOf = (kind: 'role' | 'skill', id: string) => changes.find(item => item.kind === kind && item.id === id);
  const flag = (change: BindingChange | undefined) => change && <Tooltip label={change.state === 'moved' ? `Run dùng ${change.path}; giờ ${change.now} được dùng` : change.path}>
    <span><Badge status={change.state === 'missing' ? 'danger' : 'attention'}>{changeText[change.state]}</Badge></span></Tooltip>;
  const anyChange = changes.length > 0 || !!serverChanges?.length;
  const mode = ran?.role_mode ?? recorded.role?.mode ?? null, channel = ran?.role_channel ?? null, agent = ran?.agent ?? null;
  const loaded = Array.isArray(ran?.skills_loaded) ? ran.skills_loaded : null, fellBack = ran?.native_fallback ?? [];
  return <Section title="Role và skill run đã dùng" actions={ran?.contract === false && <ContractOffTag />}>
    {recorded.role && <Line label="Role">
      <RoleBadge id={recorded.role.id} {...(onOpenCatalog ? { onClick: () => onOpenCatalog({ kind: 'role', id: recorded.role!.id }) } : {})} />
      <span className="font-mono text-[10.5px] text-faint" title={`${recorded.role.path}\nsha256 ${recorded.role.sha256}`}>{ROLE_SOURCE_LABEL[recorded.role.source] ?? recorded.role.source} #{shortHash(recorded.role.sha256)}{recorded.role.native ? ' · native' : ''}</span>
      {mode && <RoleModeBadge mode={mode} />}
      {flag(changeOf('role', recorded.role.id))}</Line>}
    {recorded.role && channel && <Line label="Đã qua"><Tooltip label="Kênh role thật sự đi tới model (role_channel ở sự kiện done)">
      <code className="font-mono text-[11px]">{roleChannelLabel(channel, agent)}</code></Tooltip>
      {mode && !channelsOf(mode, agent).includes(channel) && <span className="text-[11px] text-attention">khác role_mode {mode}</span>}</Line>}
    {recorded.skills.length > 0 && <div className="flex flex-col gap-1">{recorded.skills.map((skill, index) => <Line key={skill.id} label={index ? '' : 'Skill'}>
      <SkillBadge id={skill.id} {...(onOpenCatalog ? { onClick: () => onOpenCatalog({ kind: 'skill', id: skill.id }) } : {})} />
      <span className="font-mono text-[10.5px] text-faint" title={`${skill.path}\nsha256 ${skill.sha256}`}>#{shortHash(skill.sha256)}</span>
      <SkillViaBadge via={skill.via} cliPath={skill.cli ? `${skill.cli.path} #${shortHash(skill.cli.sha256)}` : null}
        fallbackReason={skill.fallback_reason ?? (fellBack.includes(skill.id) ? 'CLI không nạp skill native này (sự kiện native fallback)' : null)}
        {...(skill.via === 'native' && loaded ? { loaded: loaded.includes(skill.id) } : {})}
        warnings={skill.cli ? [`${skill.id}: CLI tự nạp ${skill.cli.source === 'personal' ? 'bản cá nhân ' : ''}${skill.cli.path} #${shortHash(skill.cli.sha256)}, không phải ${skill.path} #${shortHash(skill.sha256)} mà langflow gửi`] : undefined} />
      {flag(changeOf('skill', skill.id))}</Line>)}</div>}
    {ran?.skill_channel && <Line label="Skill qua"><Tooltip label="Nơi skill system / native đi tới model (skill_channel ở sự kiện done)">
      <code className="font-mono text-[11px]">{skillChannelLabel(ran.skill_channel)}</code></Tooltip></Line>}
    {fellBack.length > 0 && <Callout tone="attention" icon={<TriangleAlert />}>CLI không nạp skill native <code className="font-mono">{fellBack.join(', ')}</code>; bước đã gọi lại một lần (mới) với {ran?.fallback_via ? <code className="font-mono">{ran.fallback_via}</code> : 'native_fallback'}.</Callout>}
    {anyChange && <Callout tone="attention" icon={<TriangleAlert />}>File role/skill đã đổi sau khi bước này chạy; <code className="font-mono">langflow continue</code> sẽ dùng bản mới.
      {serverChanges?.length ? <ul className="m-0 mt-1 pl-4">{serverChanges.map(item => <li key={item} className="font-mono text-[11px]">{item}</li>)}</ul> : null}</Callout>}
  </Section>;
}

/** What a run's step ran with besides its recorded binding (StepPanel ranWith). */
export type RanWith = { role_mode?: string | null | undefined; contract?: boolean | null | undefined; role_channel?: string | null | undefined;
  agent?: string | null | undefined; skill_channel?: string | null | undefined; skills_loaded?: string[] | null | undefined;
  native_fallback?: string[] | null | undefined; fallback_via?: string | null | undefined };

/** Icon pair for compact rows (steps table): "🤖 role [mode] · 📖 n". `mode`: the role_mode (run info or bindings
 *  modes); `contractOff`: the step contract is off; `warn`: the server's warnings for this step (tooltip);
 *  `skillMode`: shown after the skill count when not inject; `resume`: retry_mode resume. */
export function BindingSummary({ role, skills, mode, contractOff, warn, skillMode, resume }: { role?: string | null | undefined; skills?: string[] | null | undefined;
  mode?: string | null | undefined; contractOff?: boolean | undefined; warn?: string[] | undefined; skillMode?: string | null | undefined; resume?: boolean | undefined }) {
  if (!role && !skills?.length) return <span className="text-faint">—</span>;
  return <span className="inline-flex items-center gap-2 text-[11.5px] text-fg-2">
    {role && <span className="inline-flex items-center gap-1 font-mono"><Bot className="size-3 text-muted-foreground" />{role}{mode && <span className="text-faint">[{mode}]</span>}</span>}
    {contractOff && <span className="text-[10.5px] text-muted-foreground" title="Step contract tắt">no contract</span>}
    {!!warn?.length && <span className="inline-flex text-attention" title={warn.join('\n')}><TriangleAlert className="size-3" /></span>}
    {!!skills?.length && <span className="inline-flex items-center gap-1" title={skills.join(', ')}><BookOpen className="size-3 text-muted-foreground" />{skills.length}
      {skillMode && skillMode !== 'inject' && <span className="text-faint">[{skillMode}]</span>}</span>}
    {resume && <span className="inline-flex items-center gap-0.5 text-[10.5px] text-muted-foreground" title="retry_mode resume: lần sửa theo check tiếp tục session"><RotateCcw className="size-3" />resume</span>}
  </span>;
}
