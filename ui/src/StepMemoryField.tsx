import { useEffect, useState } from 'react';
import { Field, Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { StepMemory } from '../../src/domain/schema';

type Kind = 'context' | 'decision' | 'lesson';
export type StepMemoryRole = 'plan' | 'read' | 'write' | 'review';
const kinds: { value: Kind; label: string }[] = [{ value: 'context', label: 'Context' }, { value: 'decision', label: 'Quyết định' }, { value: 'lesson', label: 'Lesson' }];
/** Same defaults as the runtime's `roleMemoryDefaults`: planning, research and writing see everything, reviewers decisions and lessons. */
const roleTypes: Record<StepMemoryRole, Kind[]> = { plan: ['context', 'decision', 'lesson'], read: ['context', 'decision', 'lesson'], write: ['context', 'decision', 'lesson'], review: ['decision', 'lesson'] };
const roleNames: Record<StepMemoryRole, string> = { plan: 'lập kế hoạch', read: 'nghiên cứu', write: 'viết code', review: 'review' };
const kindLabel = (types: Kind[]) => types.map(type => kinds.find(item => item.value === type)!.label).join(', ');

/** What a step without its own setting receives, in words. */
export function inheritedMemoryHint(role: StepMemoryRole | undefined, roleDefaults: boolean): string {
  if (!roleDefaults || !role) return 'Nhận toàn bộ memory đã ghim của run (như flow cũ).';
  return `Theo vai trò ${roleNames[role]}: ${kindLabel(roleTypes[role])}${role === 'write' ? ', chỉ bản ghi khớp phạm vi kế hoạch' : ''}.`;
}

/**
 * Inspector field for one agent or reviewer step's memory (`memory` of the node or reviewer). `undefined` means the step
 * follows the flow default: its role's memory when the flow sets `memoryDefaults: "role"`, otherwise the whole pinned block.
 * `role` and `roleDefaults` only change the explanation shown for that default.
 */
export function StepMemoryField({ memory, onChange, role, roleDefaults = false, disabled = false }: { memory: StepMemory | undefined; onChange(next: StepMemory | undefined): void;
  role?: StepMemoryRole; roleDefaults?: boolean; disabled?: boolean }) {
  const mode = !memory ? 'default' : memory.off ? 'off' : 'custom';
  // The tag text is kept as typed (a trailing comma included) and parsed into the setting on every change.
  const parse = (text: string) => text.split(',').map(tag => tag.trim()).filter(Boolean), saved = memory?.tags?.join(', ') ?? '';
  const [tagText, setTagText] = useState(saved);
  useEffect(() => { setTagText(current => parse(current).join(', ') === saved ? current : saved); }, [saved]);
  const types = memory?.types ?? (role && roleDefaults ? roleTypes[role] : kinds.map(item => item.value));
  const update = (patch: Partial<StepMemory>) => {
    const next: StepMemory = { ...(memory && !memory.off ? memory : { types }), ...patch };
    for (const key of Object.keys(next) as (keyof StepMemory)[]) if (next[key] === undefined) delete next[key];
    onChange(next);
  };
  const toggle = (kind: Kind) => {
    const selected = types.includes(kind) ? types.filter(item => item !== kind) : kinds.map(item => item.value).filter(item => item === kind || types.includes(item));
    if (selected.length) update({ types: selected });
  };
  return <div className="flex flex-col gap-2.5" data-step-memory>
    <Field label="Memory cho bước này" help={mode === 'default' ? inheritedMemoryHint(role, roleDefaults) : mode === 'off' ? 'Agent của bước này không nhận memory nào.' : 'Lọc trên tập memory run đã ghim khi bắt đầu.'}>
      <Select label="Chế độ memory" value={mode} disabled={disabled} onValueChange={value => onChange(value === 'default' ? undefined : value === 'off' ? { off: true } : { types })}
        options={[{ value: 'default', label: roleDefaults ? 'Theo vai trò (mặc định)' : 'Như flow (mặc định)' }, { value: 'custom', label: 'Tùy chỉnh' }, { value: 'off', label: 'Tắt memory' }]} />
    </Field>
    {mode === 'custom' && <>
      <div className="flex flex-col gap-1.5"><span className="text-[12px] font-medium text-fg-2">Loại bản ghi</span>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Loại bản ghi">{kinds.map(kind => { const on = types.includes(kind.value);
          return <button key={kind.value} type="button" aria-pressed={on} disabled={disabled || (on && types.length === 1)} onClick={() => toggle(kind.value)}
            className={cn('h-7 rounded-md border px-2.5 text-[12.5px] transition-colors disabled:cursor-not-allowed', on ? 'border-primary/60 bg-primary/15 text-foreground' : 'border-input bg-background text-muted-foreground hover:text-foreground')}>{kind.label}</button>; })}</div></div>
      <div className="grid grid-cols-[minmax(0,1fr)_110px] gap-2.5">
        <Field label="Chỉ bản ghi có tag" help="Ngăn bằng dấu phẩy; để trống là mọi tag."><Input aria-label="Tag memory" disabled={disabled} value={tagText} placeholder="vd. ui, api"
          onChange={event => { setTagText(event.target.value); const tags = parse(event.target.value); update({ tags: tags.length ? tags : undefined }); }} /></Field>
        <Field label="Tối đa"><Input aria-label="Số bản ghi tối đa" type="number" min={0} max={30} disabled={disabled} value={memory?.maxRecords ?? ''} placeholder="30"
          onChange={event => { const value = event.target.value.trim(); update({ maxRecords: value === '' ? undefined : Math.max(0, Math.min(30, Math.floor(Number(value)) || 0)) }); }} /></Field>
      </div>
    </>}
  </div>;
}
