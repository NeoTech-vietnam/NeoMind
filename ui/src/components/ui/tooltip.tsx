import type { ReactNode } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { usePortalContainer } from '@/lib/portal';

export const TooltipProvider = TooltipPrimitive.Provider;

export function Tooltip({ label, side = 'top', children }: { label: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right'; children: ReactNode }) {
  const container = usePortalContainer();
  return <TooltipPrimitive.Root>
    <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
    <TooltipPrimitive.Portal container={container}>
      <TooltipPrimitive.Content side={side} sideOffset={6} className="z-50 max-w-72 rounded-md bg-primary px-2 py-1 text-[11.5px] leading-snug text-primary-foreground shadow-md">{label}</TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  </TooltipPrimitive.Root>;
}
