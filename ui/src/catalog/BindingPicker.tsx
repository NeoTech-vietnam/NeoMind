/**
 * "Sửa" for one ai step: pick its role (filtered and ordered by the step's CLI) and skills (search, multi-select),
 * then save to .langflow/bindings.toml (PUT) or go back to the code value (DELETE).
 */
import { useEffect, useMemo, useState } from 'react';
import { Check, CircleAlert, RotateCcw, Save, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogActions, DialogContent } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { Callout } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { formatBytes } from '../format';
import { isNative, overrideFor, pickSource, resetBinding, saveBinding, useCatalog, type BindingChoice } from './api';
import { SourceBadge } from './BindingBadges';
import {
  FALLBACK_LABEL, NATIVE_FALLBACKS, NATIVE_SKILL_CLIS, RESUMABLE, RETRY_MODE_LABEL, RETRY_MODES, ROLE_MODES, ROLE_SOURCE_LABEL, ROLE_SYSTEM_CLIS, SKILL_MODE_LABEL,
  SKILL_MODES, SYSTEM_SKILL_CLIS, type BindingOverride, type BindingValue, type NativeFallback, type RetryMode, type RoleMode, type SkillMode, type StepBindingRow,
  type WorkflowBindings,
} from './types';

const NONE = '__none__';

const tomlString = (value: string) => JSON.stringify(value);
/** The table the save writes, shown before saving. */
function tomlPreview(workflow: string, step: string, body: BindingOverride | null): string {
  if (!body) return `# [${workflow}.${step}] bị xóa: bước này dùng giá trị trong code`;
  const lines = [`[${workflow}.${step}]`];
  if (body.role !== undefined) lines.push(`role = ${tomlString(body.role)}${body.role ? '' : '   # không dùng role'}`);
  if (body.skills !== undefined) lines.push(`skills = [${body.skills.map(tomlString).join(', ')}]`);
  if (body.role_mode !== undefined) lines.push(`role_mode = ${tomlString(body.role_mode)}`);
  if (body.contract !== undefined) lines.push(`contract = ${body.contract}`);
  for (const key of ['skill_mode', 'native_fallback', 'retry_mode'] as const) if (body[key] !== undefined) lines.push(`${key} = ${tomlString(body[key]!)}`);
  return lines.join('\n');
}

const CODE = '__code__';
/** catalog.modes: the automatic role_mode. Claude "append" (also for a native role: --agent replaces the default
 *  system prompt and drops StructuredOutput), every other CLI "prompt". */
const autoMode = (agent: string): RoleMode => agent === 'claude' ? 'append' : 'prompt';
/** catalog.modes: a mode the CLI cannot give is changed; returns the mode that will run and why. OpenCode keeps
 *  "agent" (instance agent lf-role) and "append" ([agents.opencode] role_channel). */
function cliMode(mode: RoleMode, agent: string, native: boolean, role: string): { mode: RoleMode; note?: string } {
  if (mode === 'agent' && agent === 'claude' && !native) return { mode: 'append', note: `agent cần .claude/agents/${role}.md; sẽ dùng append` };
  if (mode === 'agent' && agent === 'codex') return { mode: 'append', note: 'Codex không có agent chính; sẽ dùng append (developer_instructions)' };
  if (mode !== 'prompt' && !ROLE_SYSTEM_CLIS.includes(agent)) return { mode: 'prompt', note: `${agent} chưa có kênh system cho role; sẽ dùng prompt` };
  return { mode };
}
const MODE_HELP: Record<RoleMode, string> = {
  append: 'system prompt của CLI (Claude: --append-system-prompt-file, Codex: developer_instructions, OpenCode: theo [agents.opencode] role_channel)',
  agent: 'role làm agent chính (Claude: --agent, tools của role chỉ dùng khi bước không có tools riêng; OpenCode: agent lf-role của instance)',
  prompt: 'đưa nội dung role vào đầu prompt',
};
/** catalog.skill_via without the per-skill copy check: what a skill_mode becomes on this CLI. Native also needs the
 *  CLI's own copy of each skill (Claude .claude/skills, Codex .agents/skills); the server checks that per skill. */
function cliSkillMode(mode: SkillMode, agent: string, fallback: NativeFallback): { mode: string; note?: string } {
  if (mode === 'system' && !SYSTEM_SKILL_CLIS.includes(agent)) return { mode: 'inject', note: `${agent} không có kênh system cho skill; sẽ dùng inject` };
  if (mode === 'native' && !NATIVE_SKILL_CLIS.includes(agent)) {
    const fb = fallback === 'system' && !SYSTEM_SKILL_CLIS.includes(agent) ? 'inject' : fallback;
    return { mode: fb, note: fb === 'fail' ? `${agent} không tự nạp skill; native_fallback fail sẽ chặn run` : `${agent} không tự nạp skill; sẽ dùng ${fb}` };
  }
  return { mode };
}
const fallbackOn = (fallback: NativeFallback, agent: string) => fallback === 'system' && !SYSTEM_SKILL_CLIS.includes(agent) ? 'inject' : fallback;

const describe = (value: BindingValue) => `${value.role ? `role ${value.role}` : 'không role'} · ${value.skills.length ? `skill ${value.skills.join(', ')}` : 'không skill'}`;

export function BindingPicker({ workflow, row, defaults, open, onOpenChange, onSaved }: {
  workflow: string; row: StepBindingRow; defaults?: WorkflowBindings['defaults'] | undefined; open: boolean; onOpenChange(open: boolean): void; onSaved?: () => void }) {
  const { catalog, error: catalogError } = useCatalog();
  const [role, setRole] = useState<string | null>(null), [skills, setSkills] = useState<string[]>([]), [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  // role_mode / contract: null = no bindings.toml value (the code's ai(role_mode=, contract=), then config, then automatic).
  const [roleMode, setRoleMode] = useState<RoleMode | null>(null), [contract, setContract] = useState<boolean | null>(null);
  // skill_mode / native_fallback / retry_mode: the same rule (null = no bindings.toml value).
  const [skillMode, setSkillMode] = useState<SkillMode | null>(null), [fallback, setFallback] = useState<NativeFallback | null>(null), [retryMode, setRetryMode] = useState<RetryMode | null>(null);
  // The picker starts from what the step runs with now (code + bindings.toml); run args are not part of it.
  useEffect(() => {
    if (!open) return;
    setRole(row.effective.role ?? null); setSkills([...row.effective.skills]); setQuery(''); setError('');
    setRoleMode(row.override?.role_mode ?? null); setContract(row.override?.contract ?? null);
    setSkillMode(row.override?.skill_mode ?? null); setFallback(row.override?.native_fallback ?? null); setRetryMode(row.override?.retry_mode ?? null);
  }, [open, row]);

  const agent = row.agent ?? 'claude';
  const roles = useMemo(() => (catalog?.roles ?? []).filter(item => !item.missing)
    .map(item => ({ item, source: pickSource(item, agent), native: isNative(item, agent) }))
    .filter(entry => entry.source)
    .sort((a, b) => Number(b.native) - Number(a.native) || a.item.id.localeCompare(b.item.id)), [catalog, agent]);
  const roleOptions = [{ value: NONE, label: 'Không dùng role' }, ...roles.map(({ item, source, native }) => ({
    value: item.id, label: `${item.id} — ${native ? `file ${ROLE_SOURCE_LABEL[agent] ?? agent} (native)` : `file ${ROLE_SOURCE_LABEL[source!] ?? source} → đưa vào prompt`}`,
  }))];
  if (role && !roles.some(entry => entry.item.id === role)) roleOptions.push({ value: role, label: `${role} — không tìm thấy file cho ${agent}` });
  const chosenRole = roles.find(entry => entry.item.id === role);
  const roleFile = chosenRole?.source ? chosenRole.item.sources?.[chosenRole.source] : undefined;

  const allSkills = (catalog?.skills ?? []).filter(item => !item.missing);
  const needle = query.trim().toLowerCase();
  const shown = needle ? allSkills.filter(item => [item.id, item.name, item.description].some(text => text?.toLowerCase().includes(needle))) : allSkills;
  const toggle = (id: string) => setSkills(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  const unknownSkills = skills.filter(id => !allSkills.some(item => item.id === id));

  const chosen: BindingChoice = { role, skills, role_mode: roleMode, contract, skill_mode: skillMode, native_fallback: fallback, retry_mode: retryMode };
  const body = overrideFor(row.code, chosen);
  const changed = (chosen.role ?? null) !== (row.effective.role ?? null) || chosen.skills.join('\n') !== row.effective.skills.join('\n')
    || roleMode !== (row.override?.role_mode ?? null) || contract !== (row.override?.contract ?? null)
    || skillMode !== (row.override?.skill_mode ?? null) || fallback !== (row.override?.native_fallback ?? null) || retryMode !== (row.override?.retry_mode ?? null);

  // What "mặc định" means for this step: the code value, else [catalog] in config.toml, else automatic.
  const native = !!chosenRole?.native;
  const baseMode = row.code.role_mode ?? defaults?.role_mode ?? null;
  const defaultModeText = row.code.role_mode ? `theo code: ${row.code.role_mode}` : defaults?.role_mode ? `theo config.toml: ${defaults.role_mode}` : `tự động: ${role ? autoMode(agent) : '—'}`;
  const pickedMode = roleMode ?? baseMode;
  const runMode = role ? (pickedMode ? cliMode(pickedMode, agent, native, role) : { mode: autoMode(agent) }) : null;
  const modeOptions = [{ value: CODE, label: `Mặc định (${defaultModeText})` }, ...ROLE_MODES.map(mode => {
    const limited = role ? cliMode(mode, agent, native, role) : { mode };
    return { value: mode, label: `${mode}${limited.mode !== mode ? ` → ${limited.mode} với ${agent}` : ''}` };
  })];
  const baseContract = row.code.contract ?? defaults?.contract ?? true;
  const contractOptions = [{ value: CODE, label: `Mặc định (${baseContract ? 'bật' : 'tắt'}${row.code.contract !== undefined ? ', theo code' : defaults?.contract === false ? ', theo config.toml' : ''})` },
    { value: 'on', label: 'Bật' }, { value: 'off', label: 'Tắt' }];
  const contractOn = contract ?? baseContract;

  // skill_mode / native_fallback / retry_mode: "Mặc định" = the code's ai(...) value, else [catalog], else the built-in default.
  const defaultText = (code: string | undefined, config: string | undefined, builtIn: string) => code ? `theo code: ${code}` : config && config !== builtIn ? `theo config.toml: ${config}` : builtIn;
  const baseFallback: NativeFallback = row.code.native_fallback ?? defaults?.native_fallback ?? 'system', pickedFallback = fallback ?? baseFallback;
  const baseSkillMode: SkillMode = row.code.skill_mode ?? defaults?.skill_mode ?? 'inject', pickedSkillMode = skillMode ?? baseSkillMode;
  const runSkillMode = cliSkillMode(pickedSkillMode, agent, pickedFallback);
  const skillModeOptions = [{ value: CODE, label: `Mặc định (${defaultText(row.code.skill_mode, defaults?.skill_mode, 'inject')})` }, ...SKILL_MODES.map(mode => {
    const limited = cliSkillMode(mode, agent, pickedFallback);
    return { value: mode, label: `${mode}${limited.mode !== mode ? ` → ${limited.mode} với ${agent}` : ''}` };
  })];
  const fallbackOptions = [{ value: CODE, label: `Mặc định (${defaultText(row.code.native_fallback, defaults?.native_fallback, 'system')})` },
    ...NATIVE_FALLBACKS.map(value => ({ value, label: `${value}${fallbackOn(value, agent) !== value ? ` → ${fallbackOn(value, agent)} với ${agent}` : ''}` }))];
  const baseRetry: RetryMode = row.code.retry_mode ?? defaults?.retry_mode ?? 'fresh', pickedRetry = retryMode ?? baseRetry;
  const canResume = RESUMABLE.includes(agent);
  const retryOptions = [{ value: CODE, label: `Mặc định (${defaultText(row.code.retry_mode, defaults?.retry_mode, 'fresh')})` },
    ...RETRY_MODES.map(value => ({ value, label: `${value}${value === 'resume' && !canResume ? ` → fresh với ${agent}` : ''}` }))];

  const run = async (action: () => Promise<void>) => {
    setSaving(true); setError('');
    try { await action(); onOpenChange(false); onSaved?.(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="flex max-h-[calc(100vh-48px)] w-[700px] flex-col" title={<>Role và skill · <code className="font-mono">{workflow} › {row.step}</code></>}
      description={<>CLI của bước: <code className="font-mono">{agent}</code>. Lưu vào <code className="font-mono">.langflow/bindings.toml</code>; code workflow không đổi. Mặc định (code): {describe(row.code)}.</>}>
      <form className="mt-4 flex min-h-0 flex-1 flex-col gap-3.5" onSubmit={event => { event.preventDefault(); if (changed) void run(() => saveBinding(workflow, row, chosen)); }}>
        {catalogError && <Callout tone="danger" icon={<CircleAlert />}>Không đọc được danh mục skill/agent: {catalogError}</Callout>}
        <Field label="Role (agent)" help={chosenRole ? <>{chosenRole.item.description || 'Không có mô tả.'}
          {roleFile && <span className="mt-0.5 block font-mono text-[11px] text-faint">{roleFile.path}{chosenRole.native && (roleFile.model || roleFile.tools?.length) ? ` · model ${roleFile.model ?? 'mặc định'}${roleFile.tools?.length ? ` · tools ${roleFile.tools.join(', ')}` : ''}` : ''}</span>}</>
          : role ? <span className="text-danger">Role {role} không có file cho {agent}; run sẽ không bắt đầu.</span> : 'Bước này chạy không có role.'}>
          <Select label="Role" value={role ?? NONE} onValueChange={value => setRole(value === NONE ? null : value)} options={roleOptions} disabled={!catalog} />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Cách đưa role (role_mode)" help={!role ? 'Không có role: role_mode không có tác dụng.'
            : <>{runMode && MODE_HELP[runMode.mode]}{runMode?.note && <span className="mt-0.5 block text-attention">{runMode.note}</span>}</>}>
            <Select label="role_mode" value={roleMode ?? CODE} onValueChange={value => setRoleMode(value === CODE ? null : value as RoleMode)} options={modeOptions} disabled={!role} />
          </Field>
          <Field label="Step contract" help={!role && !skills.length ? 'Chỉ thêm vào bước có role hoặc skill.'
            : contractOn ? 'Khối cuối prompt: trả JSON theo schema, không tự tạo/sửa file nếu bước không yêu cầu.' : 'Prompt không có khối step contract.'}>
            <Select label="contract" value={contract === null ? CODE : contract ? 'on' : 'off'} onValueChange={value => setContract(value === CODE ? null : value === 'on')} options={contractOptions} />
          </Field>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Cách đưa skill (skill_mode)" help={!skills.length ? 'Không có skill: skill_mode không có tác dụng.'
            : <>{SKILL_MODE_LABEL[runSkillMode.mode] ?? runSkillMode.mode}{runSkillMode.note && <span className="mt-0.5 block text-attention">{runSkillMode.note}</span>}</>}>
            <Select label="skill_mode" value={skillMode ?? CODE} onValueChange={value => setSkillMode(value === CODE ? null : value as SkillMode)} options={skillModeOptions} disabled={!skills.length} />
          </Field>
          <Field label="Khi native không nạp được" help={pickedSkillMode !== 'native' ? 'Chỉ dùng khi skill_mode là native.'
            : <>{FALLBACK_LABEL[pickedFallback]}{pickedFallback === 'fail' && <span className="mt-0.5 block text-attention">Server từ chối lưu nếu có skill không thể native với {agent}.</span>}</>}>
            <Select label="native_fallback" value={fallback ?? CODE} onValueChange={value => setFallback(value === CODE ? null : value as NativeFallback)} options={fallbackOptions} disabled={!skills.length} />
          </Field>
          <Field label="Lần sửa theo check (retry_mode)" help={<>{RETRY_MODE_LABEL[pickedRetry === 'resume' && !canResume ? 'fresh' : pickedRetry]}
            {pickedRetry === 'resume' && !canResume && <span className="mt-0.5 block text-attention">{agent} không resume được session; sẽ dùng fresh.</span>}</>}>
            <Select label="retry_mode" value={retryMode ?? CODE} onValueChange={value => setRetryMode(value === CODE ? null : value as RetryMode)} options={retryOptions} />
          </Field>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-1.5">
          <div className="flex items-center gap-2"><span className="text-[12px] font-medium text-fg-2">Skill</span>
            <span className="text-[11.5px] text-muted-foreground">{skills.length ? `${skills.length} đã chọn (theo thứ tự đưa vào prompt)` : 'chưa chọn'}</span></div>
          {skills.length > 0 && <div className="flex flex-wrap gap-1">{skills.map(id => <span key={id} className={cn('inline-flex h-6 items-center gap-1 rounded-full border bg-muted pl-2 pr-0.5 font-mono text-[11.5px]', unknownSkills.includes(id) && 'border-danger/40 text-danger')}>
            {id}<button type="button" aria-label={`Bỏ skill ${id}`} onClick={() => toggle(id)} className="inline-flex size-5 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground"><X className="size-3" /></button></span>)}</div>}
          <div className="relative"><Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
            <Input aria-label="Tìm skill" placeholder="Tìm theo id, tên, mô tả" value={query} onChange={event => setQuery(event.target.value)} className="pl-7" spellCheck={false} /></div>
          <ul role="listbox" aria-multiselectable="true" aria-label="Skill trong project" className="m-0 min-h-[120px] max-h-[280px] list-none overflow-auto rounded-md border p-1">
            {!catalog && !catalogError && <li className="px-2 py-1.5 text-[12px] text-muted-foreground">Đang đọc danh mục…</li>}
            {catalog && !shown.length && <li className="px-2 py-1.5 text-[12px] text-muted-foreground">{allSkills.length ? 'Không skill nào khớp.' : 'Project chưa có skill (.langflow/skills, .agents/skills, .claude/skills).'}</li>}
            {shown.map(item => { const on = skills.includes(item.id);
              return <li key={item.id} role="option" aria-selected={on} tabIndex={0} onClick={() => toggle(item.id)} onKeyDown={event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); toggle(item.id); } }}
                className={cn('flex cursor-pointer items-start gap-2 rounded-[5px] px-2 py-1.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring', on && 'bg-accent')}>
                <span className={cn('mt-0.5 inline-flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border', on && 'border-primary bg-primary text-primary-foreground')}>{on && <Check className="size-3" />}</span>
                <span className="min-w-0 flex-1"><span className="flex items-center gap-1.5"><span className="font-mono text-[12px] font-medium">{item.id}</span>
                  {item.source && <SourceBadge kind="skill" source={item.source} />}{item.size !== undefined && <span className="text-[10.5px] text-faint">{formatBytes(item.size)}</span>}</span>
                  {item.description && <span className="line-clamp-2 block text-[11.5px] text-muted-foreground">{item.description}</span>}</span>
              </li>; })}
          </ul>
        </div>

        <pre aria-label="Sẽ ghi vào bindings.toml" className="m-0 whitespace-pre-wrap rounded-md bg-code p-2 font-mono text-[11px] leading-relaxed text-fg-2">{tomlPreview(workflow, row.step, body)}</pre>
        {error && <Callout tone="danger" icon={<CircleAlert />}>{error}</Callout>}
        <DialogActions className="mt-0">
          {row.override && <Button variant="ghost" className="mr-auto" disabled={saving} onClick={() => void run(() => resetBinding(workflow, row.step))}><RotateCcw />Về mặc định</Button>}
          <Button onClick={() => onOpenChange(false)}>Hủy</Button>
          <Button type="submit" variant="primary" disabled={!changed || saving}><Save />{saving ? 'Đang lưu…' : 'Lưu'}</Button>
        </DialogActions>
      </form>
    </DialogContent>
  </Dialog>;
}
