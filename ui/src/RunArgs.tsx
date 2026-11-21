/**
 * The run-argument fields shared by "Run mới" (Workflows.tsx) and "Thêm lịch" (Schedules.tsx).
 * Each field explains itself from the workflow's arg spec (GET /api/workflows → args, from argspec.py): help text,
 * example or default as placeholder, a select for choices, path suggestions from GET /api/paths for path / dir fields,
 * chips for a list of paths. Optional args sit in a collapsed section and are sent only when filled (else the
 * workflow's own default applies). "Dùng lại tham số…" fills the form from the newest run (last_args).
 * The parent keeps the state ({values, extra}) and uses collectArgs / checkArgs for the command preview and submit.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { ChevronRight, File, Folder, History, Minus, Plus, X } from 'lucide-react';
import { api } from './api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { usePortalContainer } from '@/lib/portal';
import { cn } from '@/lib/utils';
import { relativeTime } from './format';
import type { ArgSpec, LastArgs, PathSuggestions, Workflow } from './types';

export type ExtraArg = { key: string; value: string };
export type ArgValues = Record<string, string>;

/** The workflow's arg specs; an older server without `args` gives one plain text field per required key. */
export function argSpecs(workflow: Workflow | null | undefined): ArgSpec[] {
  if (!workflow) return [];
  const specs = workflow.args?.length ? [...workflow.args] : [];
  for (const key of workflow.required) if (!specs.some(spec => spec.key === key)) specs.push({ key, required: true, kind: 'text' });
  return specs.map(spec => ({ ...spec, required: spec.required || workflow.required.includes(spec.key) }));
}

const SPLIT = /[,;]/;
/** Separator of a "paths" field: ";" only when its help / example uses ";" and no ",". */
const sepOf = (spec: ArgSpec) => { const text = `${spec.help ?? ''} ${spec.example ?? ''} ${spec.default ?? ''}`; return text.includes(';') && !text.includes(',') ? ';' : ','; };
const NUMBER = /^-?\d+(\.\d+)?$/;

/** The value as the workflow gets it: trimmed; a paths list without empty items; a folder without a trailing "/". */
export function cleanValue(spec: ArgSpec, raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (spec.kind === 'paths') return value.split(SPLIT).map(item => item.trim()).filter(Boolean).join(sepOf(spec));
  if (spec.kind === 'dir') return value.replace(/[\\/]+$/, '');
  return value;
}

/** key=value pairs in order: every required arg, the filled optional ones, then the extra rows. */
export function collectArgs(specs: ArgSpec[], values: ArgValues, extra: ExtraArg[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (const spec of specs) {
    const value = cleanValue(spec, values[spec.key]);
    if (spec.required || value) pairs.push([spec.key, value]);
  }
  for (const item of extra) if (item.key.trim()) pairs.push([item.key.trim(), item.value]);
  return pairs;
}

export type ArgCheck = { missing: string[]; notNumber: string[]; badExtra: boolean; dupExtra: string[]; ok: boolean; note: string };
export function checkArgs(specs: ArgSpec[], values: ArgValues, extra: ExtraArg[]): ArgCheck {
  const missing = specs.filter(spec => spec.required && !cleanValue(spec, values[spec.key])).map(spec => spec.key);
  const notNumber = specs.filter(spec => spec.kind === 'number' && cleanValue(spec, values[spec.key]) && !NUMBER.test(cleanValue(spec, values[spec.key]))).map(spec => spec.key);
  const keys = extra.map(item => item.key.trim()).filter(Boolean);
  const badExtra = keys.some(key => !/^[\w.*-]+$/.test(key));
  const dupExtra = keys.filter(key => specs.some(spec => spec.key === key));
  const note = [missing.length ? `Còn thiếu: ${missing.join(', ')}.` : '', notNumber.length ? `Phải là số: ${notNumber.join(', ')}.` : ''].filter(Boolean).join(' ');
  return { missing, notNumber, badExtra, dupExtra, ok: !missing.length && !notNumber.length && !badExtra && !dupExtra.length, note };
}

/** Quote an argument for the command preview the way a shell user would type it. */
export const quote = (arg: string) => /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
export const commandLine = (workflow: string, run: string, pairs: [string, string][]) =>
  `langflow ${['start', workflow, run.trim(), ...pairs.map(([key, value]) => `${key}=${value}`)].filter(Boolean).map(quote).join(' ')}`;

const text = (value: unknown) => value === null || value === undefined ? '' : typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
/** The form state from the newest run: spec keys into their fields, every other arg into an extra row. */
export function fromLastArgs(specs: ArgSpec[], last: LastArgs): { values: ArgValues; extra: ExtraArg[] } {
  const values: ArgValues = {}, extra: ExtraArg[] = [];
  for (const [key, raw] of Object.entries(last.args ?? {})) {
    const spec = specs.find(item => item.key === key), value = text(raw);
    if (!spec) extra.push({ key, value });
    else values[key] = spec.kind === 'paths' && cleanValue(spec, value) ? cleanValue(spec, value) + sepOf(spec) : value;  // every path a chip
  }
  return { values, extra };
}

// ---------------------------------------------------------------- path input with suggestions

/** Path / dir / paths input: suggestions from GET /api/paths as you type (a folder continues into it); `base` is
 * shown as a prefix and only scopes the suggestions; for "paths" each chosen path becomes a chip. */
function PathInput({ spec, id, value, placeholder, invalid, onChange }: { spec: ArgSpec; id: string; value: string; placeholder: string; invalid: boolean; onChange(value: string): void }) {
  const multi = spec.kind === 'paths', sep = sepOf(spec);
  const parts = multi ? value.split(SPLIT) : [value];
  const current = parts[parts.length - 1] ?? '', chips = multi ? parts.slice(0, -1).map(item => item.trim()).filter(Boolean) : [];
  const join = (list: string[], tail: string) => list.length ? [...list, tail].join(sep) : tail;
  const setCurrent = (next: string) => onChange(join(chips, next));
  const [open, setOpen] = useState(false), [items, setItems] = useState<PathSuggestions['entries']>([]), [itemsFor, setItemsFor] = useState<string | null>(null), [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null), anchor = useRef<HTMLDivElement>(null), list = useRef<HTMLUListElement>(null);
  const container = usePortalContainer();
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ prefix: current.trimStart(), kind: spec.kind === 'dir' ? 'dir' : 'path' });
      if (spec.base) query.set('base', spec.base);
      api<PathSuggestions>(`/api/paths?${query.toString()}`)
        .then(result => { if (live) { setItems(result.entries ?? []); setItemsFor(current); setActive(0); setError(''); } })
        .catch(e => { if (live) { setItems([]); setItemsFor(current); setError(e instanceof Error ? e.message : String(e)); } })
        .finally(() => { if (live) setLoading(false); });
    }, 150);
    return () => { live = false; clearTimeout(timer); };
  }, [open, current, spec.base, spec.kind]);
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active]);
  const pick = (entry: { rel: string; dir: boolean }) => {
    if (entry.dir) { setCurrent(entry.rel); setOpen(true); }         // continue into the folder
    else if (multi) { onChange(join(chips, entry.rel) + sep); }       // a chip; the input is ready for the next path
    else { setCurrent(entry.rel); setOpen(false); }
    input.current?.focus();
  };
  const removeChip = (index: number) => onChange(join(chips.filter((_, i) => i !== index), current));
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); if (!open) setOpen(true); else setActive(index => Math.min(index + 1, Math.max(items.length - 1, 0))); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(index - 1, 0)); }
    else if (event.key === 'Enter' && open && items[active]) { event.preventDefault(); if (fresh) pick(items[active]!); }  // never a list of the previous text
    else if (event.key === 'Tab') setOpen(false);
    else if (event.key === 'Backspace' && multi && !current && chips.length) { event.preventDefault(); onChange(join(chips.slice(0, -1), '')); }
  };
  const fresh = itemsFor === current && !loading;
  const showList = open && (loading || !!error || items.length > 0 || !!current);
  return <PopoverPrimitive.Root open={showList} onOpenChange={next => { if (!next) setOpen(false); }}>
    <PopoverPrimitive.Anchor asChild>
      <div ref={anchor} onClick={() => input.current?.focus()}
        className={cn('flex min-h-8 w-full cursor-text flex-wrap items-center gap-1 rounded-md border border-input bg-background px-1.5 py-[3px] focus-within:ring-2 focus-within:ring-ring', invalid && 'border-danger')}>
        {spec.base && <span title={`Gợi ý bắt đầu từ ${spec.base}/; giá trị gửi đi là phần sau nó`} className="inline-flex h-5 max-w-[45%] items-center truncate rounded bg-muted px-1.5 font-mono text-[11px] text-muted-foreground">{spec.base}/</span>}
        {chips.map((chip, index) => <span key={`${chip}-${index}`} className="inline-flex h-5 max-w-full items-center gap-0.5 rounded bg-accent pl-1.5 font-mono text-[11.5px] text-foreground">
          <span className="truncate">{chip}</span>
          <button type="button" aria-label={`Bỏ ${chip}`} onClick={event => { event.stopPropagation(); removeChip(index); }}
            className="inline-flex size-5 cursor-pointer items-center justify-center rounded border-0 bg-transparent p-0 text-muted-foreground hover:text-foreground"><X className="size-3" /></button></span>)}
        <input ref={input} id={id} value={current} spellCheck={false} autoComplete="off" role="combobox" aria-expanded={showList} aria-autocomplete="list"
          placeholder={chips.length ? 'thêm đường dẫn…' : placeholder}
          onChange={event => { setCurrent(event.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onKeyDown={onKeyDown}
          className="h-6 min-w-[140px] flex-1 border-0 bg-transparent px-1 font-mono text-[12.5px] text-foreground outline-none placeholder:font-sans placeholder:text-faint" />
      </div>
    </PopoverPrimitive.Anchor>
    <PopoverPrimitive.Portal container={container}>
      <PopoverPrimitive.Content align="start" sideOffset={4} onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}
        onInteractOutside={event => { if (anchor.current?.contains(event.target as Node)) event.preventDefault(); }}
        onMouseDown={event => event.preventDefault()}  // keep the focus in the input
        className="z-50 max-h-64 w-[var(--radix-popper-anchor-width)] min-w-[240px] overflow-auto rounded-lg border bg-popover p-1 text-foreground shadow-lg outline-none">
        {error ? <p className="m-0 px-2 py-1.5 text-[12px] text-danger">{error}</p>
          : !items.length ? <p className="m-0 px-2 py-1.5 text-[12px] text-muted-foreground">{loading ? 'Đang tìm…' : spec.kind === 'dir' ? 'Không có thư mục con khớp.' : 'Không có file khớp.'}</p>
          : <ul ref={list} role="listbox" aria-busy={!fresh} className={cn('m-0 list-none p-0', !fresh && 'opacity-60')}>{items.map((entry, index) => <li key={entry.rel} role="option" aria-selected={index === active} data-index={index}
              onMouseEnter={() => setActive(index)} onClick={() => pick(entry)}
              className={cn('flex h-7 cursor-pointer items-center gap-1.5 rounded-[5px] px-2 font-mono text-[12px] text-fg-2', index === active && 'bg-accent text-foreground')}>
              {entry.dir ? <Folder className="size-3.5 shrink-0 text-muted-foreground" /> : <File className="size-3.5 shrink-0 text-muted-foreground" />}
              <span className="min-w-0 flex-1 truncate">{entry.rel}</span>{entry.dir && <ChevronRight className="size-3.5 shrink-0 text-faint" />}</li>)}</ul>}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  </PopoverPrimitive.Root>;
}

// ---------------------------------------------------------------- one field

const DEFAULT = '__default__';
const placeholderOf = (spec: ArgSpec) => spec.required ? (spec.example ? `vd: ${spec.example}` : '')
  : spec.default ? `mặc định: ${spec.default}` : spec.example ? `vd: ${spec.example}` : 'để trống: mặc định của workflow';

function ArgField({ spec, value, onChange }: { spec: ArgSpec; value: string; onChange(value: string): void }) {
  const id = useId();
  const clean = cleanValue(spec, value), notNumber = spec.kind === 'number' && !!clean && !NUMBER.test(clean);
  const placeholder = placeholderOf(spec);
  let control: ReactNode;
  if (spec.kind === 'choice' || spec.kind === 'bool') {
    const choices = [...(spec.choices?.length ? spec.choices : spec.kind === 'bool' ? ['true', 'false'] : [])];
    if (value && !choices.includes(value)) choices.push(value);  // e.g. a value from the last run
    const options = [...(spec.required ? [] : [{ value: DEFAULT, label: spec.default ? `mặc định (${spec.default})` : 'mặc định' }]), ...choices.map(choice => ({ value: choice, label: choice }))];
    control = <Select label={spec.key} value={value || (spec.required ? '' : DEFAULT)} placeholder="chọn…" options={options} onValueChange={next => onChange(next === DEFAULT ? '' : next)} className="font-mono" />;
  } else if (spec.kind === 'path' || spec.kind === 'paths' || spec.kind === 'dir') {
    control = <PathInput spec={spec} id={id} value={value} placeholder={placeholder} invalid={false} onChange={onChange} />;
  } else {
    control = <Input id={id} value={value} placeholder={placeholder} spellCheck={false} inputMode={spec.kind === 'number' ? 'decimal' : undefined}
      aria-invalid={notNumber || undefined} className={cn(spec.kind === 'number' && 'w-40 tabular-nums', notNumber && 'border-danger')} onChange={event => onChange(event.target.value)} />;
  }
  return <div className="flex flex-col gap-1">
    <label htmlFor={id} className="text-[12px] font-medium text-fg-2"><code className="font-mono">{spec.key}</code>{spec.required && <span className="text-danger"> *</span>}
      {spec.kind === 'paths' && <span className="ml-1.5 font-normal text-faint">nhiều đường dẫn, cách nhau “{sepOf(spec)}”</span>}</label>
    {spec.help && <span className="-mt-0.5 text-[11.5px] leading-snug text-muted-foreground">{spec.help}</span>}
    {control}
    {notNumber && <span role="alert" className="text-[11.5px] text-danger">Phải là số.</span>}
  </div>;
}

// ---------------------------------------------------------------- the whole block

/** Required fields, a collapsed "Tuỳ chọn (N)" section, the "Tham số thêm" rows and the "Dùng lại…" button. */
export function RunArgsFields({ workflow, values, extra, onValues, onExtra, extraHint }: { workflow: Workflow; values: ArgValues; extra: ExtraArg[];
  onValues(values: ArgValues): void; onExtra(extra: ExtraArg[]): void; extraHint?: ReactNode }) {
  const specs = argSpecs(workflow), required = specs.filter(spec => spec.required), optional = specs.filter(spec => !spec.required);
  const [showOptional, setShowOptional] = useState(false);
  useEffect(() => setShowOptional(false), [workflow.name]);
  const filled = optional.filter(spec => cleanValue(spec, values[spec.key])).length;
  const last = workflow.last_args, check = checkArgs(specs, values, extra);
  const reuse = () => {
    if (!last) return;
    const next = fromLastArgs(specs, last);
    onValues(next.values);
    onExtra(next.extra);
    if (optional.some(spec => next.values[spec.key])) setShowOptional(true);
  };
  const set = (key: string) => (value: string) => onValues({ ...values, [key]: value });
  return <div className="flex flex-col gap-3.5">
    {last && <div><Button size="sm" variant="outline" onClick={reuse} title={Object.entries(last.args ?? {}).map(([key, value]) => `${key}=${text(value)}`).join('\n')}>
      <History /><span>Dùng lại tham số của run gần nhất (<span className="font-mono">{last.run}</span>{last.updated ? `, ${relativeTime(last.updated) || last.updated}` : ''})</span></Button></div>}
    {required.map(spec => <ArgField key={spec.key} spec={spec} value={values[spec.key] ?? ''} onChange={set(spec.key)} />)}
    {optional.length > 0 && <div className="rounded-md border">
      <button type="button" aria-expanded={showOptional} onClick={() => setShowOptional(value => !value)}
        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2.5 text-left font-sans text-[12.5px] text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', showOptional && 'rotate-90')} />
        <span className="font-medium">Tuỳ chọn ({optional.length})</span>
        <span className="ml-auto truncate text-[11.5px] text-muted-foreground">{filled ? `${filled} đã đặt` : 'để trống: workflow tự dùng mặc định'}</span>
      </button>
      {showOptional && <div className="flex flex-col gap-3.5 border-t px-2.5 pb-3 pt-2.5">
        {optional.map(spec => <ArgField key={spec.key} spec={spec} value={values[spec.key] ?? ''} onChange={set(spec.key)} />)}</div>}
    </div>}
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2"><span className="text-[12px] font-medium text-fg-2">Tham số thêm</span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => onExtra([...extra, { key: '', value: '' }])}><Plus />Thêm</Button></div>
      {extra.map((item, index) => <div key={index} className="flex items-center gap-1.5">
        <Input aria-label="Tên tham số" placeholder="model.<bước>" value={item.key} className="w-[44%] font-mono" spellCheck={false}
          onChange={event => onExtra(extra.map((row, i) => i === index ? { ...row, key: event.target.value } : row))} />
        <span className="text-faint">=</span>
        <Input aria-label="Giá trị" placeholder="sonnet" value={item.value} className="flex-1 font-mono" spellCheck={false}
          onChange={event => onExtra(extra.map((row, i) => i === index ? { ...row, value: event.target.value } : row))} />
        <Button size="icon-sm" variant="ghost" aria-label="Bỏ tham số" onClick={() => onExtra(extra.filter((_, i) => i !== index))}><Minus /></Button>
      </div>)}
      {extraHint}
      {check.badExtra && <span role="alert" className="text-[11.5px] text-danger">Tên tham số chỉ gồm chữ, số, “.”, “*”, “-”, “_”.</span>}
      {check.dupExtra.length > 0 && <span role="alert" className="text-[11.5px] text-danger">{check.dupExtra.join(', ')} đã có ô riêng ở trên; điền ở đó.</span>}
    </div>
  </div>;
}

/** "Lệnh sẽ chạy": the command the form will run. */
export function CommandPreview({ workflow, run, pairs }: { workflow: string; run: string; pairs: [string, string][] }) {
  return <div className="flex flex-col gap-1"><span className="text-[12px] font-medium text-fg-2">Lệnh sẽ chạy</span>
    <code className="block whitespace-pre-wrap break-all rounded-md bg-code px-2.5 py-1.5 font-mono text-[11.5px]">{commandLine(workflow, run, pairs)}</code></div>;
}
