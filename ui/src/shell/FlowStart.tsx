/** Creating flows: the template picker shown when a project has no flow yet, and the "Tạo flow" dialog. */
import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, Workflow } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogActions, DialogContent } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Tag } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/misc';
import { cn } from '@/lib/utils';

export type Template = 'dev' | 'parallel' | 'fast' | 'research';

/** Step chains of src/domain/templates.ts, in words. */
export const templates: { id: Template; name: string; description: string; steps: string[]; suggested?: boolean }[] = [
  { id: 'dev', name: 'Dev', description: 'Phát triển tính năng hoặc sửa lỗi, có duyệt kế hoạch và review độc lập.', steps: ['Lập kế hoạch', 'Duyệt', 'Thực hiện', 'Review', 'Commit'], suggested: true },
  { id: 'parallel', name: 'Dev song song', description: 'Chia việc cho hai agent ghi song song rồi tích hợp.', steps: ['Lập kế hoạch', 'Duyệt', 'Thực hiện ×2', 'Tích hợp', 'Review', 'Commit'] },
  { id: 'fast', name: 'Fast', description: 'Kế hoạch nhanh, agent làm luôn; bạn tự review, không commit.', steps: ['Kế hoạch nhanh', 'Tự duyệt', 'Thực hiện'] },
  { id: 'research', name: 'Research', description: 'Nghiên cứu, kiểm tra nguồn và viết báo cáo; không sửa code.', steps: ['Tìm hiểu', 'Kiểm tra nguồn', 'Báo cáo'] },
];

export function slug(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);
}

/** Shown only when the project has no flow at all; with flows, the Flows view opens one directly. */
export function NoFlows({ onPick }: { onPick(template: Template): void }) {
  return <div className="mx-auto max-w-[860px] px-6 py-10">
    <EmptyState icon={<Workflow />} title="Chưa có flow nào" className="py-6">
      Flow quy định các bước agent làm: lập kế hoạch, bạn duyệt, thực hiện, review rồi commit. Chọn một mẫu để bắt đầu, sau đó chỉnh trong Flow Studio.
    </EmptyState>
    <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3">
      {templates.map(template => <div key={template.id} className={cn('flex flex-col gap-2 rounded-lg border bg-card p-4', template.suggested && 'border-fg-2/40')}>
        <div className="flex items-center gap-2"><strong className="text-[14px] font-semibold">{template.name}</strong>{template.suggested && <Tag>Gợi ý</Tag>}</div>
        <p className="m-0 text-[12.5px] leading-relaxed text-muted-foreground">{template.description}</p>
        <p className="m-0 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-[11.5px] text-fg-2">{template.steps.map((step, index) =>
          <span key={step} className="whitespace-nowrap">{index > 0 && <ArrowRight className="mr-1 inline size-3 text-faint" />}{step}</span>)}</p>
        <div className="mt-auto pt-1"><Button variant={template.suggested ? 'primary' : 'outline'} onClick={() => onPick(template.id)}>Dùng mẫu {template.name}</Button></div>
      </div>)}
    </div>
  </div>;
}

export function CreateFlowDialog({ open, onOpenChange, initialTemplate, busy, onCreate }: {
  open: boolean; onOpenChange(open: boolean): void; initialTemplate: Template; busy: boolean; onCreate(input: { id: string; name: string; template: Template }): void }) {
  const [name, setName] = useState(''), [id, setId] = useState(''), [template, setTemplate] = useState<Template>(initialTemplate);
  useEffect(() => { if (open) { setName(''); setId(''); setTemplate(initialTemplate); } }, [open, initialTemplate]);
  const submit = (event: FormEvent) => { event.preventDefault(); if (id && name) onCreate({ id, name, template }); };
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent title="Tạo flow mới" description="Bắt đầu từ một mẫu, rồi chỉnh các bước trong Flow Studio.">
      <form className="mt-4 flex flex-col gap-3.5" onSubmit={submit}>
        <Field label="Tên flow"><Input autoFocus required value={name} placeholder="Ví dụ: Sửa lỗi nhanh" onChange={event => { setName(event.target.value); setId(slug(event.target.value)); }} /></Field>
        <Field label="Flow ID" help="Chữ thường, số và dấu gạch ngang; dùng trong CLI và tên file."><Input required className="font-mono" value={id} placeholder="sua-loi-nhanh" onChange={event => setId(event.target.value)} /></Field>
        <Field label="Mẫu"><Select label="Mẫu" value={template} onValueChange={value => setTemplate(value as Template)}
          options={templates.map(item => ({ value: item.id, label: `${item.name} · ${item.steps.join(' → ')}` }))} /></Field>
        <DialogActions><Button onClick={() => onOpenChange(false)}>Hủy</Button><Button type="submit" variant="primary" disabled={busy || !id || !name}>Tạo bản nháp</Button></DialogActions>
      </form>
    </DialogContent>
  </Dialog>;
}
