import type { ComponentProps } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/** One `primary` per screen (docs/design/redesign-plan.md §2); everything else is outline, ghost or danger. */
export const buttonVariants = cva(
  'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-sans text-[12.5px] font-medium leading-none transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-45 [&_svg]:size-[15px] [&_svg]:shrink-0',
  { variants: {
      variant: {
        primary: 'border-primary bg-primary text-primary-foreground hover:opacity-90',
        outline: 'border-border bg-background text-foreground hover:bg-accent',
        ghost: 'border-transparent bg-transparent text-fg-2 hover:bg-accent hover:text-foreground',
        danger: 'border-border bg-background text-danger hover:bg-accent',
        'danger-solid': 'border-danger-solid bg-danger-solid text-white hover:opacity-90',
      },
      size: { md: 'h-[30px] px-3', sm: 'h-6 px-2 text-[11.5px]', lg: 'h-9 px-4 text-[13px]', icon: 'size-[30px]', 'icon-sm': 'size-6' },
    },
    defaultVariants: { variant: 'outline', size: 'md' } },
);

export function Button({ className, variant, size, type = 'button', ...props }: ComponentProps<'button'> & VariantProps<typeof buttonVariants>) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
