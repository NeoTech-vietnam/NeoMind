import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

const control = 'w-full rounded-md border border-input bg-background px-2.5 font-sans text-[13px] font-normal text-foreground outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(control, 'h-8', className)} {...props} />;
}
export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(control, 'min-h-20 resize-y py-2 leading-normal', className)} {...props} />;
}
/** Label, control and an optional help or error line, stacked. */
export function Field({ label, help, error, className, children }: { label: ReactNode; help?: ReactNode; error?: ReactNode; className?: string; children: ReactNode }) {
  return <label className={cn('flex flex-col gap-1.5', className)}>
    <span className="text-[12px] font-medium text-fg-2">{label}</span>{children}
    {error ? <span role="alert" className="text-[11.5px] text-danger">{error}</span> : help && <span className="text-[11.5px] text-muted-foreground">{help}</span>}
  </label>;
}
