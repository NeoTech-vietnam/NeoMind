import type { ComponentProps, ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePortalContainer } from '@/lib/portal';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

function Overlay() {
  return <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-overlay" />;
}

/** Centered dialog with title, optional description and an action row. */
export function DialogContent({ title, description, children, className, ...props }: ComponentProps<typeof DialogPrimitive.Content> & { title: ReactNode; description?: ReactNode }) {
  const container = usePortalContainer();
  return <DialogPrimitive.Portal container={container}><Overlay />
    <DialogPrimitive.Content className={cn('fixed left-1/2 top-1/2 z-50 w-[440px] max-w-[calc(100%-32px)] -translate-x-1/2 -translate-y-1/2 rounded-[10px] border bg-popover p-[18px] text-foreground shadow-2xl outline-none', className)}
      {...(description ? {} : { 'aria-describedby': undefined })} {...props}>
      <DialogPrimitive.Title className="m-0 pr-8 text-[15px] font-semibold">{title}</DialogPrimitive.Title>
      {description && <DialogPrimitive.Description className="m-0 mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">{description}</DialogPrimitive.Description>}
      {children}
      <DialogPrimitive.Close aria-label="Đóng" className="absolute right-2.5 top-2.5 inline-flex size-7 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground"><X className="size-4" /></DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>;
}
export function DialogActions({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('mt-4 flex justify-end gap-2', className)} {...props} />;
}

/** Panel sliding in from the right, used for session views and details beside the current page. */
export function SheetContent({ title, description, children, className, ...props }: ComponentProps<typeof DialogPrimitive.Content> & { title: ReactNode; description?: ReactNode }) {
  const container = usePortalContainer();
  return <DialogPrimitive.Portal container={container}><Overlay />
    <DialogPrimitive.Content className={cn('fixed inset-y-0 right-0 z-50 flex w-[420px] max-w-full flex-col border-l bg-background text-foreground shadow-2xl outline-none', className)}
      {...(description ? {} : { 'aria-describedby': undefined })} {...props}>
      <div className="flex items-start gap-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1"><DialogPrimitive.Title className="m-0 text-[15px] font-semibold">{title}</DialogPrimitive.Title>
          {description && <DialogPrimitive.Description className="m-0 mt-0.5 text-[12px] text-muted-foreground">{description}</DialogPrimitive.Description>}</div>
        <DialogPrimitive.Close aria-label="Đóng" className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground"><X className="size-4" /></DialogPrimitive.Close>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>;
}
