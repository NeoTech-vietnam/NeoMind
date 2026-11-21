import type { ComponentProps, ReactNode } from 'react';
import * as MenuPrimitive from '@radix-ui/react-dropdown-menu';
import { cn } from '@/lib/utils';
import { usePortalContainer } from '@/lib/portal';

export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;

export function DropdownMenuContent({ className, align = 'end', ...props }: ComponentProps<typeof MenuPrimitive.Content>) {
  const container = usePortalContainer();
  return <MenuPrimitive.Portal container={container}>
    <MenuPrimitive.Content align={align} sideOffset={4} className={cn('z-50 min-w-48 rounded-lg border bg-popover p-1 text-foreground shadow-lg', className)} {...props} />
  </MenuPrimitive.Portal>;
}
export function DropdownMenuItem({ className, danger, shortcut, children, ...props }: ComponentProps<typeof MenuPrimitive.Item> & { danger?: boolean; shortcut?: ReactNode }) {
  return <MenuPrimitive.Item className={cn('flex h-7 cursor-pointer select-none items-center gap-2 rounded-[5px] px-2 text-[12.5px] text-fg-2 outline-none data-[disabled]:opacity-45 data-[highlighted]:bg-accent data-[highlighted]:text-foreground [&_svg]:size-[14px]', danger && 'text-danger data-[highlighted]:text-danger', className)} {...props}>
    {children}{shortcut && <span className="ml-auto text-[11px] text-faint">{shortcut}</span>}
  </MenuPrimitive.Item>;
}
export function DropdownMenuSeparator() {
  return <MenuPrimitive.Separator className="my-1 h-px bg-border" />;
}
