import type { ComponentProps } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cn } from '@/lib/utils';
import { usePortalContainer } from '@/lib/portal';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;

export function PopoverContent({ className, align = 'start', ...props }: ComponentProps<typeof PopoverPrimitive.Content>) {
  const container = usePortalContainer();
  return <PopoverPrimitive.Portal container={container}>
    <PopoverPrimitive.Content align={align} sideOffset={6} className={cn('z-50 w-72 rounded-lg border bg-popover p-3.5 text-foreground shadow-lg outline-none', className)} {...props} />
  </PopoverPrimitive.Portal>;
}
