import type { ComponentProps, ReactNode } from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '@/lib/utils';

/** Text tabs with an underline: the one control for switching views (segmented controls are for settings only). */
export const Tabs = TabsPrimitive.Root;
export const TabsContent = TabsPrimitive.Content;
export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn('flex gap-4 border-b', className)} {...props} />;
}
export function TabsTrigger({ className, count, children, ...props }: ComponentProps<typeof TabsPrimitive.Trigger> & { count?: number; children: ReactNode }) {
  return <TabsPrimitive.Trigger className={cn('-mb-px flex cursor-pointer items-baseline gap-1.5 border-0 border-b-2 border-solid border-transparent bg-transparent px-0 pb-2 pt-1.5 font-sans text-[12.5px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:border-foreground data-[state=active]:font-semibold data-[state=active]:text-foreground', count === 0 && 'opacity-50', className)} {...props}>
    {children}{count !== undefined && <small className="text-[11px] tabular-nums text-faint">{count}</small>}
  </TabsPrimitive.Trigger>;
}
