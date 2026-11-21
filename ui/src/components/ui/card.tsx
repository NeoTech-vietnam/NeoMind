import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function Card({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('rounded-lg border bg-card text-foreground', className)} {...props} />;
}
export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex items-center gap-2 border-b px-4 py-3', className)} {...props} />;
}
export function CardTitle({ className, ...props }: ComponentProps<'h3'>) {
  return <h3 className={cn('m-0 text-[14px] font-semibold', className)} {...props} />;
}
export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('px-4 py-3.5', className)} {...props} />;
}
