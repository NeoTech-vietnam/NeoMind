import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogActions, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { usePortalContainer } from '@/lib/portal';

/** A confirmation that names its consequence; the confirm button says what happens ("Hủy run", not "OK"). */
export type ConfirmRequest = { title: string; description?: ReactNode; confirmLabel: string; cancelLabel?: string; danger?: boolean };
/** One line of text; `confirmLabel` defaults to "Lưu". */
export type TextRequest = { title: string; description?: ReactNode; label?: string; initial?: string; confirmLabel?: string; danger?: boolean };

type Pending = { kind: 'confirm'; request: ConfirmRequest; resolve(value: boolean): void } | { kind: 'text'; request: TextRequest; resolve(value: string | null): void };
let show: ((pending: Pending) => void) | undefined;

/**
 * Ask for confirmation inside the page. `window.confirm`/`prompt` block the panel's renderer in Nimbalyst and cannot be
 * styled; without a mounted host (a plain test page) these fall back to them.
 */
export function confirmAction(request: ConfirmRequest): Promise<boolean> {
  return new Promise(resolve => { if (show) show({ kind: 'confirm', request, resolve }); else resolve(window.confirm(request.title)); });
}
export function askText(request: TextRequest): Promise<string | null> {
  return new Promise(resolve => { if (show) show({ kind: 'text', request, resolve }); else resolve(window.prompt(request.title, request.initial ?? '')); });
}

/** Renders the questions above; mount once inside the theme wrapper. */
export function DialogHost() {
  const [pending, setPending] = useState<Pending | null>(null), [value, setValue] = useState(''), input = useRef<HTMLInputElement>(null);
  const container = usePortalContainer();
  useEffect(() => { show = next => { setPending(next); setValue(next.kind === 'text' ? next.request.initial ?? '' : ''); }; return () => { show = undefined; }; }, []);
  useEffect(() => { if (pending?.kind === 'text') requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); }); }, [pending]);
  if (!pending) return null;
  if (pending.kind === 'confirm') {
    const { request } = pending, finish = (result: boolean) => { pending.resolve(result); setPending(null); };
    return <AlertDialog.Root open onOpenChange={open => { if (!open) finish(false); }}>
      <AlertDialog.Portal container={container}>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-overlay" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[440px] max-w-[calc(100%-32px)] -translate-x-1/2 -translate-y-1/2 rounded-[10px] border bg-popover p-[18px] text-foreground shadow-2xl outline-none"
          {...(request.description ? {} : { 'aria-describedby': undefined })}>
          <AlertDialog.Title className="m-0 text-[15px] font-semibold">{request.title}</AlertDialog.Title>
          {request.description && <AlertDialog.Description asChild><div className="mt-1.5 whitespace-pre-line text-[12.5px] leading-relaxed text-muted-foreground">{request.description}</div></AlertDialog.Description>}
          <DialogActions>
            <AlertDialog.Cancel asChild><Button>{request.cancelLabel ?? 'Quay lại'}</Button></AlertDialog.Cancel>
            <AlertDialog.Action asChild><Button variant={request.danger ? 'danger-solid' : 'primary'} onClick={() => finish(true)}>{request.confirmLabel}</Button></AlertDialog.Action>
          </DialogActions>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>;
  }
  const { request } = pending, finish = (result: string | null) => { pending.resolve(result); setPending(null); };
  return <Dialog open onOpenChange={open => { if (!open) finish(null); }}>
    <DialogContent title={request.title} description={request.description}>
      <form className="mt-3" onSubmit={event => { event.preventDefault(); finish(value); }}>
        <Input ref={input} aria-label={request.label ?? request.title} value={value} onChange={event => setValue(event.target.value)} />
        <DialogActions>
          <Button onClick={() => finish(null)}>Hủy</Button>
          <Button type="submit" variant={request.danger ? 'danger-solid' : 'primary'}>{request.confirmLabel ?? 'Lưu'}</Button>
        </DialogActions>
      </form>
    </DialogContent>
  </Dialog>;
}
