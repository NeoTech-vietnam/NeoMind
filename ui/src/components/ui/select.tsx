import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePortalContainer } from '@/lib/portal';

export type SelectOption = { value: string; label: string; disabled?: boolean };

export function Select({ value, onValueChange, options, placeholder, label, className, disabled }: {
  value: string; onValueChange(value: string): void; options: SelectOption[]; placeholder?: string; label: string; className?: string; disabled?: boolean }) {
  const container = usePortalContainer();
  return <SelectPrimitive.Root value={value} onValueChange={onValueChange} {...(disabled ? { disabled } : {})}>
    <SelectPrimitive.Trigger aria-label={label} className={cn('inline-flex h-8 w-full cursor-pointer items-center justify-between gap-2 rounded-md border border-input bg-background px-2.5 text-left font-sans text-[13px] font-normal text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 data-[placeholder]:text-faint [&>span:first-child]:min-w-0 [&>span:first-child]:truncate', className)}>
      <SelectPrimitive.Value {...(placeholder ? { placeholder } : {})} /><SelectPrimitive.Icon><ChevronDown className="size-4 text-muted-foreground" /></SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
    <SelectPrimitive.Portal container={container}>
      <SelectPrimitive.Content position="popper" sideOffset={4} className="z-50 max-h-[min(var(--radix-select-content-available-height),320px)] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border bg-popover p-1 text-foreground shadow-lg">
        <SelectPrimitive.Viewport>{options.map(option =>
          <SelectPrimitive.Item key={option.value} value={option.value} {...(option.disabled ? { disabled: true } : {})} className="relative flex h-7 cursor-pointer select-none items-center rounded-[5px] pl-7 pr-2 text-[12.5px] text-fg-2 outline-none data-[disabled]:opacity-45 data-[highlighted]:bg-accent data-[highlighted]:text-foreground">
            <SelectPrimitive.ItemIndicator className="absolute left-2 inline-flex"><Check className="size-3.5" /></SelectPrimitive.ItemIndicator>
            <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
          </SelectPrimitive.Item>)}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  </SelectPrimitive.Root>;
}
