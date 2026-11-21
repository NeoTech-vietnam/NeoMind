/** Small badges for a step's role and skills: graph nodes, step tables, step panels. */
import { BookOpen, Bot, Check, CornerDownRight, FileWarning, PenLine, RotateCcw, TriangleAlert } from 'lucide-react';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { GroupBinding } from '../groups';
import { MODE_ORIGIN_LABEL, RETRY_MODE_LABEL, ROLE_MODE_LABEL, ROLE_SOURCE_LABEL, SKILL_MODE_LABEL, SKILL_SOURCE_LABEL, type BindingValue, type NodeBinding } from './types';

const chip = 'inline-flex h-[18px] max-w-full items-center gap-1 whitespace-nowrap rounded border px-1 font-mono text-[10.5px] leading-none text-fg-2 [&_svg]:size-3 [&_svg]:shrink-0';

/** Role chip: bot icon + id. `onClick` opens its preview. */
export function RoleBadge({ id, missing, onClick, className }: { id: string; missing?: boolean; onClick?: () => void; className?: string }) {
  const body = <><Bot /><span className="min-w-0 truncate">{id}</span></>;
  const cls = cn(chip, 'bg-background', missing && 'border-danger/40 text-danger', onClick && 'cursor-pointer hover:bg-accent', className);
  const label = missing ? `Role ${id}: không tìm thấy file` : `Role (agent): ${id}`;
  return <Tooltip label={label}>{onClick ? <button type="button" className={cls} aria-label={label} onClick={event => { event.stopPropagation(); onClick(); }}>{body}</button> : <span className={cls} aria-label={label}>{body}</span>}</Tooltip>;
}

/** Skill chip: book icon + id. */
export function SkillBadge({ id, missing, onClick, className }: { id: string; missing?: boolean; onClick?: () => void; className?: string }) {
  const body = <><BookOpen /><span className="min-w-0 truncate">{id}</span></>;
  const cls = cn(chip, 'bg-muted border-transparent', missing && 'border-danger/40 bg-danger/12 text-danger', onClick && 'cursor-pointer hover:bg-accent', className);
  const label = missing ? `Skill ${id}: không tìm thấy SKILL.md` : `Skill: ${id}`;
  return <Tooltip label={label}>{onClick ? <button type="button" className={cls} aria-label={label} onClick={event => { event.stopPropagation(); onClick(); }}>{body}</button> : <span className={cls} aria-label={label}>{body}</span>}</Tooltip>;
}

/** Skill count only (graph nodes are small): "📖 2", tooltip lists the ids. */
export function SkillCount({ skills, className }: { skills: string[]; className?: string }) {
  if (!skills.length) return null;
  return <Tooltip label={<>Skill: {skills.join(', ')}</>}>
    <span className={cn(chip, 'border-transparent bg-muted', className)} aria-label={`${skills.length} skill: ${skills.join(', ')}`}><BookOpen />{skills.length}</span>
  </Tooltip>;
}

/** "override" marker: bindings.toml (or a run arg) changes the value written in the workflow code. */
export function OverrideTag({ from, className }: { from?: string | undefined; className?: string }) {
  const label = from === 'run' ? 'Tham số run thay giá trị trong code' : 'bindings.toml thay giá trị trong code';
  return <Tooltip label={label}><span className={cn('inline-flex h-[18px] items-center gap-1 rounded bg-attention/12 px-1 text-[10.5px] font-semibold text-attention [&_svg]:size-3', className)}><PenLine />{from === 'run' ? 'run' : 'override'}</span></Tooltip>;
}

/** The compact badge row a graph node shows: role chip + skill count. Nothing when the step has neither. */
export function NodeBindingBadges({ binding, overridden, className }: { binding: NodeBinding | BindingValue | null | undefined; overridden?: boolean; className?: string }) {
  const role = binding?.role || null, skills = binding?.skills ?? [];
  if (!role && !skills.length) return null;
  return <span className={cn('flex min-w-0 items-center gap-1', className)}>
    {role && <RoleBadge id={role} className="min-w-0" />}
    <SkillCount skills={skills} />
    {overridden && <span aria-label="override" title="bindings.toml thay giá trị trong code" className="size-1.5 shrink-0 rounded-full bg-attention" />}
  </span>;
}

/** A collapsed group's summary: the first role chip (+N more roles) and the count of distinct skills; the tooltip
 *  lists each inner step's binding. */
export function GroupBindingBadges({ binding, className }: { binding: GroupBinding | null | undefined; className?: string }) {
  if (!binding || (!binding.roles.length && !binding.skills.length)) return null;
  const [first, ...more] = binding.roles;
  const tip = <span className="flex flex-col gap-0.5">{binding.steps.map(step => <span key={step.id} className="font-mono text-[11px]">
    {step.id}: {[step.role ? `role ${step.role}` : '', step.skills.length ? `skill ${step.skills.join(', ')}` : ''].filter(Boolean).join(' · ')}</span>)}</span>;
  return <Tooltip label={tip}>
    <span className={cn('flex min-w-0 items-center gap-1', className)} aria-label={`Bước bên trong: ${binding.roles.length} role, ${binding.skills.length} skill`}>
      {first && <span className={cn(chip, 'min-w-0 bg-background')}><Bot /><span className="min-w-0 truncate">{first}</span></span>}
      {more.length > 0 && <span className={cn(chip, 'bg-background')}>+{more.length}</span>}
      {binding.skills.length > 0 && <span className={cn(chip, 'border-transparent bg-muted')}><BookOpen />{binding.skills.length}</span>}
    </span>
  </Tooltip>;
}

/** Source badge in the catalog lists: which folder a skill came from, or which CLIs a role has a file for. */
export function SourceBadge({ source, kind, className }: { source: string; kind: 'skill' | 'role'; className?: string }) {
  const label = kind === 'skill' ? SKILL_SOURCE_LABEL[source] ?? source : ROLE_SOURCE_LABEL[source] ?? source;
  return <span className={cn('inline-flex h-[18px] items-center whitespace-nowrap rounded bg-muted px-1.5 font-mono text-[10.5px] text-fg-2', className)}>{label}</span>;
}

/** role_mode chip: "append" / "agent" / "prompt". `from`: where the mode came from (code, bindings, run, config,
 *  default); `note`: the server changed a mode the CLI cannot give (then the chip is amber). */
export function RoleModeBadge({ mode, from, note, className }: { mode: string; from?: string | null | undefined; note?: string | null | undefined; className?: string }) {
  const label = <span className="flex flex-col gap-0.5">
    <span>role_mode <b>{mode}</b>: {ROLE_MODE_LABEL[mode] ?? mode}</span>
    {from && <span className="text-[11px] opacity-80">đặt ở: {MODE_ORIGIN_LABEL[from] ?? from}</span>}
    {note && <span className="text-[11px]">{note}</span>}</span>;
  return <Tooltip label={label}><span aria-label={`role_mode ${mode}`} className={cn(chip, 'border-dashed bg-background', note && 'border-attention/50 text-attention', className)}>
    {note && <TriangleAlert />}{mode}{from === 'default' && <span className="text-faint">·auto</span>}</span></Tooltip>;
}

/** How a skill reaches the model (`via`: inject / system / native / name) plus a warning icon when the step's CLI
 *  loads another copy itself. `fallbackReason`: the skill_mode could not be used (catalog.skill_via, or a native skill
 *  that did not load in a run): the chip is amber with ↪ and the reason is the tooltip. `warnings`: the server's
 *  lines about this skill. `loaded`: a run's after-call check (`skills_loaded`) for a native skill. */
export function SkillViaBadge({ via, warnings, cliPath, fallbackReason, loaded, className }: { via?: string | null | undefined; warnings?: string[] | undefined;
  cliPath?: string | null | undefined; fallbackReason?: string | null | undefined; loaded?: boolean | undefined; className?: string }) {
  const warn = !!warnings?.length, fell = !!fallbackReason;
  if (!via && !warn) return null;
  const label = <span className="flex flex-col gap-0.5">
    {via && <span>{fell ? 'dùng' : 'skill_mode'} <b>{via}</b>: {SKILL_MODE_LABEL[via] ?? via}</span>}
    {fell && <span className="text-[11px]">↪ không dùng được skill_mode đã chọn: {fallbackReason}</span>}
    {loaded !== undefined && <span className="text-[11px]">{loaded ? 'CLI đã nạp skill này (kiểm tra sau lần gọi)' : 'CLI chưa nạp skill này'}</span>}
    {cliPath && <span className="font-mono text-[11px]">CLI tự nạp: {cliPath}</span>}
    {warnings?.filter(line => !fell || !line.includes(fallbackReason!)).map(line => <span key={line} className="font-mono text-[11px]">{line}</span>)}</span>;
  return <Tooltip label={label}><span aria-label={`skill ${via ?? ''}${fell ? `, dự phòng: ${fallbackReason}` : ''}${warn ? ', có cảnh báo' : ''}`}
    className={cn(chip, 'border-transparent bg-transparent px-0.5 text-faint', via !== 'inject' && 'text-fg-2', (warn || fell) && 'text-attention', className)}>
    {fell ? <CornerDownRight /> : warn && <FileWarning />}{via}{loaded && <Check className="text-success" />}</span></Tooltip>;
}

/** "resume": a guardrail retry continues the CLI session (retry_mode resume). `from`: where the mode was set. */
export function RetryModeBadge({ mode, from, className }: { mode?: string | null | undefined; from?: string | null | undefined; className?: string }) {
  if (mode !== 'resume') return null;
  return <Tooltip label={<span className="flex flex-col gap-0.5"><span>retry_mode <b>resume</b>: {RETRY_MODE_LABEL.resume}</span>
    {from && <span className="text-[11px] opacity-80">đặt ở: {MODE_ORIGIN_LABEL[from] ?? from}</span>}</span>}>
    <span aria-label="retry_mode resume" className={cn(chip, 'border-dashed bg-background', className)}><RotateCcw />resume</span></Tooltip>;
}

/** "contract off": the step contract block (catalog.CONTRACT) is not added to this step's prompt. */
export function ContractOffTag({ from, className }: { from?: string | null | undefined; className?: string }) {
  return <Tooltip label={<>Step contract tắt: prompt của bước không có khối "Step contract (langflow)" ở cuối{from ? ` · đặt ở ${MODE_ORIGIN_LABEL[from] ?? from}` : ''}.</>}>
    <span className={cn('inline-flex h-[18px] items-center gap-1 whitespace-nowrap rounded bg-muted px-1 text-[10.5px] font-semibold text-muted-foreground', className)}>contract off</span></Tooltip>;
}
