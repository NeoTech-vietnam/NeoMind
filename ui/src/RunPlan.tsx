import type { ReactNode } from 'react';
import { Square } from 'lucide-react';
import type { Plan } from './runTypes';

/** The agent often writes the approach as numbered lines; show those as a list, anything else as a paragraph. */
function Approach({ text }: { text: string }) {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean), numbered = lines.length > 1 && lines.every(line => /^\d+[.)]\s/.test(line));
  return numbered ? <ol className="m-0 flex list-none flex-col gap-1 p-0">{lines.map((line, index) => <li key={index} className="flex gap-2"><span className="w-4 shrink-0 text-right text-muted-foreground">{index + 1}.</span><span>{line.replace(/^\d+[.)]\s/, '')}</span></li>)}</ol>
    : <p className="m-0 whitespace-pre-line">{text}</p>;
}

const Chip = ({ children }: { children: ReactNode }) => <code className="inline-flex max-w-full items-center break-all rounded bg-muted px-1.5 py-0.5 font-mono text-[12px] text-foreground">{children}</code>;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-1 border-b px-4 py-3 last:border-b-0 sm:grid-cols-[132px_minmax(0,1fr)] sm:gap-4"><dt className="text-[12px] text-muted-foreground">{label}</dt><dd className="m-0 min-w-0 text-[13px] leading-relaxed">{children}</dd></div>;
}

/** The plan as a definition list: goal, approach, files, criteria, checks and risks. */
export function PlanBody({ plan }: { plan: Plan }) {
  return <dl className="m-0">
    <Row label="Mục tiêu">{plan.goal}</Row>
    <Row label="Cách làm"><Approach text={plan.approach} /></Row>
    <Row label="File dự kiến sửa"><div className="flex flex-wrap gap-1.5">{plan.scope.map(item => <Chip key={item}>{item === '.' ? 'Toàn bộ project' : item}</Chip>)}</div></Row>
    <Row label="Tiêu chí hoàn thành"><ul className="m-0 flex list-none flex-col gap-1.5 p-0">{plan.acceptanceCriteria.map(item => <li key={item} className="flex gap-2"><Square className="mt-1 size-3.5 shrink-0 text-faint" />{item}</li>)}</ul></Row>
    <Row label="Checks">{plan.checks.length ? <div className="flex flex-wrap items-center gap-1.5">{plan.checks.map(item => <Chip key={item}>{item}</Chip>)}<span className="text-[12px] text-muted-foreground">chạy trong sandbox Codex sau khi thực hiện</span></div> : <span className="text-muted-foreground">Không có check</span>}</Row>
    {plan.riskChanges.length > 0 && <Row label="Rủi ro"><ul className="m-0 list-disc pl-4">{plan.riskChanges.map(item => <li key={item}>{item}</li>)}</ul></Row>}
  </dl>;
}
