import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/** A row that opens to reveal detail; keeps rarely needed content out of the way (logs, technical details, advanced options). */
export function Disclosure({ title, hint, count, defaultOpen = false, className, children }: { title: ReactNode; hint?: ReactNode; count?: number; defaultOpen?: boolean; className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return <div className={className}>
    <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}
      className="flex min-h-9 w-full cursor-pointer items-center gap-2.5 border-0 bg-transparent px-4 py-2 text-left font-sans text-[13px] text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
      <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
      <span className="font-medium">{title}</span>
      {count !== undefined && <small className="text-[11px] tabular-nums text-faint">{count}</small>}
      {hint && <span className="ml-auto truncate text-[12px] text-muted-foreground">{hint}</span>}
    </button>
    {open && <div className="px-4 pb-3.5 pt-1">{children}</div>}
  </div>;
}
