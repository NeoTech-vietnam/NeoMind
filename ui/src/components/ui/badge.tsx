import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/** The five states; color is reserved for them (docs/design/redesign-plan.md §2). */
export type Status = 'running' | 'attention' | 'danger' | 'success' | 'idle';

const tone: Record<Status, string> = {
  running: 'bg-running/12 text-running', attention: 'bg-attention/12 text-attention', danger: 'bg-danger/12 text-danger',
  success: 'bg-success/12 text-success', idle: 'bg-idle/14 text-idle',
};
const dotTone: Record<Status, string> = { running: 'bg-running', attention: 'bg-attention', danger: 'bg-danger', success: 'bg-success', idle: 'bg-idle' };

export function StatusDot({ status, className }: { status: Status; className?: string }) {
  return <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', dotTone[status], status === 'running' && 'animate-pulse', className)} />;
}

export function Badge({ status = 'idle', dot = true, className, children, ...props }: ComponentProps<'span'> & { status?: Status; dot?: boolean }) {
  return <span className={cn('inline-flex h-5 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-[11.5px] font-semibold', tone[status], className)} {...props}>
    {dot && <StatusDot status={status} className="size-1.5" />}{children}
  </span>;
}

/** Neutral label for kinds and tags; never carries a status color. */
export function Tag({ className, ...props }: ComponentProps<'span'>) {
  return <span className={cn('inline-flex h-5 items-center whitespace-nowrap rounded bg-muted px-1.5 text-[11.5px] text-fg-2', className)} {...props} />;
}
