/** Component gallery for reviewing the base components in both themes side by side (dev only, /__gallery/). */
import { useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { CircleAlert, CircleCheck, Copy, Info, MoreHorizontal, Pencil, Play, Trash2, TriangleAlert, Workflow } from 'lucide-react';
import '../theme.css';
import { Badge, StatusDot, Tag, type Status } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogActions, DialogContent, DialogTrigger, SheetContent } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Callout, EmptyState, Kbd, Separator, Skeleton } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipProvider } from '@/components/ui/tooltip';
import { confirmAction, DialogHost } from '@/dialog';
import { PortalContainer } from '@/lib/portal';
import { cn } from '@/lib/utils';
import { StepMemoryField, type StepMemoryRole } from '@/StepMemoryField';
import type { StepMemory } from '../../../src/domain/schema';

const statuses: [Status, string][] = [['running', 'Đang chạy'], ['attention', 'Chờ duyệt'], ['danger', 'Lỗi'], ['success', 'Xong'], ['idle', 'Đã hủy']];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="flex flex-col gap-3"><h2 className="m-0 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2>{children}</section>;
}

/** The inspector's per-step memory field in its four states, each in an inspector-wide column. */
function StepMemorySamples() {
  const samples: { title: string; role: StepMemoryRole; roleDefaults: boolean; initial: StepMemory | undefined }[] = [
    { title: 'Reviewer · flow mới (theo vai trò)', role: 'review', roleDefaults: true, initial: undefined },
    { title: 'Implementer · flow cũ', role: 'write', roleDefaults: false, initial: undefined },
    { title: 'Tùy chỉnh', role: 'review', roleDefaults: true, initial: { types: ['decision', 'lesson'], tags: ['ui'], maxRecords: 5 } },
    { title: 'Tắt memory', role: 'plan', roleDefaults: true, initial: { off: true } }];
  const [values, setValues] = useState(samples.map(sample => sample.initial));
  return <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">{samples.map((sample, index) => <div key={sample.title} className="rounded-lg border bg-card p-3.5">
    <p className="m-0 mb-2.5 text-[11.5px] font-semibold text-muted-foreground">{sample.title}</p>
    <StepMemoryField memory={values[index]} role={sample.role} roleDefaults={sample.roleDefaults} onChange={next => setValues(current => current.map((value, i) => i === index ? next : value))} />
    <pre className="m-0 mt-2.5 whitespace-pre-wrap break-all rounded bg-code p-2 font-mono text-[11px] text-muted-foreground">{JSON.stringify(values[index] ?? null)}</pre></div>)}</div>;
}

function Pane({ theme, host }: { theme: 'dark' | 'light'; host: boolean }) {
  const [portal, setPortal] = useState<HTMLElement | null>(null), [runner, setRunner] = useState('claude-code'), [confirmed, setConfirmed] = useState('');
  return <div className={cn('nm-theme min-h-screen', `theme-${theme}`)}>
    <PortalContainer.Provider value={portal}><TooltipProvider delayDuration={200}>
      <div className="flex flex-col gap-7 p-7">
        <h1 className="m-0 text-[20px] font-semibold tracking-tight">Theme {theme === 'dark' ? 'tối' : 'sáng'}</h1>

        <Section title="Nút">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary">Bắt đầu run</Button><Button>Nút viền</Button><Button variant="ghost">Nút chữ</Button>
            <Button variant="danger">Hủy run</Button><Button variant="danger-solid">Xóa vĩnh viễn</Button><Button disabled>Đang khóa</Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm"><Play />Nhỏ</Button><Button size="lg" variant="primary">Lớn</Button>
            <Tooltip label="Sao chép hash"><Button size="icon" aria-label="Sao chép"><Copy /></Button></Tooltip>
            <Tooltip label="Thêm"><Button size="icon" variant="ghost" aria-label="Thêm"><MoreHorizontal /></Button></Tooltip>
          </div>
        </Section>

        <Section title="Trạng thái">
          <div className="flex flex-wrap items-center gap-2">{statuses.map(([status, label]) => <Badge key={status} status={status}>{label}</Badge>)}</div>
          <div className="flex flex-wrap items-center gap-4">{statuses.map(([status, label]) => <span key={status} className="flex items-center gap-1.5 text-[12.5px]"><StatusDot status={status} />{label}</span>)}
            <Tag>Agent task</Tag><Tag className="font-mono">v3</Tag></div>
        </Section>

        <Section title="Tabs">
          <Tabs defaultValue="all"><TabsList><TabsTrigger value="all" count={11}>Tất cả</TabsTrigger><TabsTrigger value="messages" count={0}>Tin nhắn</TabsTrigger>
            <TabsTrigger value="edits" count={3}>Sửa file</TabsTrigger><TabsTrigger value="commands" count={2}>Lệnh</TabsTrigger></TabsList>
            <TabsContent value="all" className="pt-3 text-[12.5px] text-muted-foreground">Nội dung tab Tất cả.</TabsContent>
            <TabsContent value="edits" className="pt-3 text-[12.5px] text-muted-foreground">calc.js +12 −3</TabsContent></Tabs>
        </Section>

        <Section title="Memory theo bước (StepMemoryField)"><StepMemorySamples /></Section>

        <Section title="Form">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Tên flow" help="Hiện trong danh sách flow."><Input placeholder="Ví dụ: Sửa lỗi nhanh" /></Field>
            <Field label="Flow ID" error="ID đã tồn tại."><Input className="font-mono" defaultValue="dev" /></Field>
            <Field label="Runner"><Select label="Runner" value={runner} onValueChange={setRunner} options={[{ value: 'claude-code', label: 'Claude Code · Sonnet 5.5' }, { value: 'codex', label: 'Codex · GPT-6.1 Sol' }, { value: 'luna', label: 'Codex · GPT-6 Luna' }]} /></Field>
            <Field label="Kích thước"><Input disabled value="Bị khóa" readOnly /></Field>
            <Field label="Yêu cầu" className="col-span-2"><Textarea placeholder="Thêm hàm power(a, b) vào calc.js và viết test cho nó" /></Field>
          </div>
        </Section>

        <Section title="Callout">
          <Callout icon={<Info />}><div className="flex items-center gap-3"><span className="flex-1">Flow “Viết tài liệu” chưa publish. Publish để bắt đầu run.</span><Button size="sm">Publish flow</Button></div></Callout>
          <Callout tone="attention" icon={<TriangleAlert />}>Có 2 file chưa commit trong checkout: <code className="font-mono">calc.js</code>, <code className="font-mono">README.md</code>.</Callout>
          <Callout tone="danger" icon={<CircleAlert />}>Checks thất bại: <code className="font-mono">npm test</code> thoát với mã 1.</Callout>
          <Callout tone="success" icon={<CircleCheck />}>Đã commit local <code className="font-mono">a1b2c3d</code>.</Callout>
        </Section>

        <Section title="Card và danh sách">
          <Card><CardHeader><CardTitle>Kế hoạch</CardTitle><span className="flex-1" /><Badge status="attention">Chờ duyệt</Badge></CardHeader>
            <CardContent className="flex flex-col gap-2 text-[12.5px]"><p className="m-0">Thêm hàm power(a, b) vào calc.js và viết test.</p><Skeleton className="w-3/4" /><Skeleton className="w-1/2" /></CardContent></Card>
          <div className="flex items-center gap-3 text-[12.5px] text-muted-foreground">Phím tắt: <Kbd>Ctrl K</Kbd> tìm nhanh <Separator vertical /> <Kbd>N</Kbd> run mới</div>
        </Section>

        <Section title="Overlay">
          <div className="flex flex-wrap items-center gap-2">
            <Dialog><DialogTrigger asChild><Button>Mở dialog</Button></DialogTrigger>
              <DialogContent title="Đổi tên flow" description="Tên mới hiện trong danh sách flow và trong run mới.">
                <div className="mt-3"><Input defaultValue="Dev" /></div><DialogActions><Button>Hủy</Button><Button variant="primary">Đổi tên</Button></DialogActions></DialogContent></Dialog>
            <Dialog><DialogTrigger asChild><Button>Mở sheet</Button></DialogTrigger>
              <SheetContent title="Lập kế hoạch" description="Opus 5.5 · 1 phút 20 giây · 36k tokens"><div className="p-4 text-[12.5px] text-muted-foreground">Timeline của session.</div></SheetContent></Dialog>
            {host && <Button variant="danger" onClick={() => void confirmAction({ title: 'Hủy run?', description: 'Thay đổi trong worktree của run được giữ lại.', confirmLabel: 'Hủy run', cancelLabel: 'Giữ run chạy', danger: true }).then(ok => setConfirmed(ok ? 'Đã xác nhận' : 'Đã bỏ qua'))}>Hỏi xác nhận</Button>}
            <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" aria-label="Thêm"><MoreHorizontal /></Button></DropdownMenuTrigger>
              <DropdownMenuContent><DropdownMenuItem><Pencil />Đổi tên</DropdownMenuItem><DropdownMenuItem shortcut="Ctrl S">Lưu nháp</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem danger><Trash2 />Xóa vĩnh viễn</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
            {confirmed && <span className="text-[12.5px] text-muted-foreground">{confirmed}</span>}
          </div>
        </Section>

        <Section title="Trạng thái trống">
          <Card><EmptyState icon={<Workflow />} title="Chưa có flow nào" action={<Button variant="primary">Dùng mẫu Dev</Button>}>Flow quy định các bước agent làm. Chọn một mẫu để bắt đầu.</EmptyState></Card>
        </Section>
      </div>
      {host && <DialogHost />}
    </TooltipProvider></PortalContainer.Provider>
    <div ref={setPortal} />
  </div>;
}

createRoot(document.getElementById('root')!).render(<div className="grid grid-cols-2"><Pane theme="dark" host /><Pane theme="light" host={false} /></div>);
