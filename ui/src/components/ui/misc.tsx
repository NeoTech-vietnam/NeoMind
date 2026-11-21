import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Separator({ className, vertical }: { className?: string; vertical?: boolean }) {
  return <div role="separator" className={cn('shrink-0 bg-border', vertical ? 'h-5 w-px' : 'h-px w-full', className)} />;
}
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('h-2.5 animate-pulse rounded bg-muted', className)} />;
}
export function Kbd({ className, ...props }: ComponentProps<'kbd'>) {
  return <kbd className={cn('inline-grid h-[18px] min-w-[18px] place-items-center rounded border border-b-2 px-1 font-mono text-[10.5px] text-muted-foreground', className)} {...props} />;
}
/** Centered message for a page or section with nothing to show yet; `action` holds at most one primary button. */
export function EmptyState({ icon, title, children, action, className }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  return <div className={cn('flex flex-col items-center gap-1.5 px-6 py-12 text-center text-muted-foreground', className)}>
    {icon && <div className="mb-1.5 grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-5">{icon}</div>}
    <h3 className="m-0 text-[14px] font-semibold text-foreground">{title}</h3>
    {children && <div className="max-w-md text-[12.5px] leading-relaxed">{children}</div>}
    {action && <div className="mt-3 flex flex-wrap justify-center gap-2">{action}</div>}
  </div>;
}
/** Neutral hint, attention, danger or success message; red is for real errors, not for steps not done yet. */
export function Callout({ tone = 'hint', icon, className, children }: { tone?: 'hint' | 'attention' | 'danger' | 'success'; icon?: ReactNode; className?: string; children: ReactNode }) {
  const tones = { hint: 'border-border bg-muted text-fg-2', attention: 'border-transparent bg-attention/12 text-fg-2 [&>svg]:text-attention',
    danger: 'border-transparent bg-danger/12 text-fg-2 [&>svg]:text-danger', success: 'border-transparent bg-success/12 text-fg-2 [&>svg]:text-success' };
  return <div role={tone === 'danger' ? 'alert' : undefined} className={cn('flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-[12.5px] leading-relaxed [&>svg]:mt-0.5 [&>svg]:size-[15px] [&>svg]:shrink-0 [&>svg]:text-muted-foreground', tones[tone], className)}>
    {icon}<div className="min-w-0 flex-1">{children}</div>
  </div>;
}
