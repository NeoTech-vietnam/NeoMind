/**
 * Telling the user a run waits at a gate: the tab title "(2) langflow", an in-page toast (web and panel), and, on the
 * web page, a browser notification once the user turned them on with the bell button (permission is asked only from
 * that click). The first list after load only records what already waits, so a reload does not notify again.
 */
import { useEffect, useRef, useState } from 'react';
import { Bell, BellOff, BellRing, CircleCheck, Hand, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import type { RunSummary } from './types';

/** `tone`: 'gate' (default, a run waits for the user) or 'done' (an action finished, e.g. runs deleted). */
export type Toast = { id: number; title: string; body?: string; run?: string; tone?: 'gate' | 'done' };

let nextId = 1;
const listeners = new Set<(toasts: Toast[]) => void>();
let toasts: Toast[] = [];
const emit = () => { for (const listener of listeners) listener(toasts); };
export function pushToast(toast: Omit<Toast, 'id'>, ms = 20000): void {
  const item = { ...toast, id: nextId++ };
  toasts = [...toasts.slice(-3), item]; emit();
  setTimeout(() => dismissToast(item.id), ms);
}
export function dismissToast(id: number): void { toasts = toasts.filter(item => item.id !== id); emit(); }

/** Toasts at the bottom right of the app (inside the panel in Nimbalyst, so it never covers the host). */
export function ToastHost({ openRun }: { openRun(run: string): void }) {
  const [items, setItems] = useState<Toast[]>(toasts);
  useEffect(() => { listeners.add(setItems); return () => { listeners.delete(setItems); }; }, []);
  if (!items.length) return null;
  return <div className="pointer-events-none absolute bottom-3 right-3 z-30 flex w-[340px] max-w-[calc(100%-24px)] flex-col gap-2" role="status" aria-live="polite">
    {items.map(item => <div key={item.id} className="pointer-events-auto flex items-start gap-2.5 rounded-lg border bg-popover px-3 py-2.5 text-[12.5px] text-foreground shadow-lg">
      {item.tone === 'done' ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" /> : <Hand className="mt-0.5 size-4 shrink-0 text-attention" />}
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{item.title}</div>
        {item.body && <div className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-muted-foreground">{item.body}</div>}
        {item.run && <Button size="sm" variant="primary" className="mt-2" onClick={() => { openRun(item.run!); dismissToast(item.id); }}>Mở run</Button>}
      </div>
      <button type="button" aria-label="Đóng thông báo" onClick={() => dismissToast(item.id)} className="-mr-1 -mt-0.5 inline-flex size-6 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground"><X className="size-3.5" /></button>
    </div>)}
  </div>;
}

type Permission = 'unsupported' | NotificationPermission;
const permissionNow = (): Permission => typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported';
const enabledKey = 'langflow.notify';
const readEnabled = () => { try { return localStorage.getItem(enabledKey) !== 'off'; } catch { return true; } };

/** Browser-notification state for the bell button (web only). */
export function useBrowserNotifications() {
  const [permission, setPermission] = useState<Permission>(permissionNow), [enabled, setEnabledState] = useState(readEnabled);
  const setEnabled = (value: boolean) => { setEnabledState(value); try { localStorage.setItem(enabledKey, value ? 'on' : 'off'); } catch { /* storage may be off */ } };
  const request = async () => {
    if (permission === 'unsupported') return;
    const result = await Notification.requestPermission();
    setPermission(result);
    if (result === 'granted') setEnabled(true);
  };
  return { permission, enabled: enabled && permission === 'granted', request, setEnabled };
}
export type BrowserNotifications = ReturnType<typeof useBrowserNotifications>;

export function NotifyButton({ notifications }: { notifications: BrowserNotifications }) {
  const { permission, enabled, request, setEnabled } = notifications;
  if (permission === 'unsupported') return null;
  if (permission === 'denied') return <Tooltip label="Trình duyệt đang chặn thông báo của trang này; mở lại trong cài đặt trang của trình duyệt">
    <span className="inline-flex"><Button variant="ghost" size="icon" aria-label="Thông báo bị chặn" disabled><BellOff /></Button></span></Tooltip>;
  if (permission === 'default') return <Tooltip label="Bật thông báo của trình duyệt khi một run chờ duyệt">
    <Button variant="ghost" size="icon" aria-label="Bật thông báo" onClick={() => void request()}><Bell /></Button></Tooltip>;
  return <Tooltip label={enabled ? 'Đang bật thông báo khi run chờ duyệt; bấm để tắt' : 'Thông báo đang tắt; bấm để bật'}>
    <Button variant="ghost" size="icon" aria-label={enabled ? 'Tắt thông báo' : 'Bật thông báo'} aria-pressed={enabled} onClick={() => setEnabled(!enabled)}>{enabled ? <BellRing className="text-attention" /> : <BellOff />}</Button></Tooltip>;
}

/**
 * Watch the run list: tab title with the waiting count (web), and for each run that starts waiting at a gate after the
 * first load, a toast and (web, enabled, page not focused) a browser notification that opens the run on click.
 */
export function useGateAlerts({ runs, loaded, shell, browser, openRun }: { runs: RunSummary[]; loaded: boolean; shell: 'web' | 'panel'; browser: BrowserNotifications | null; openRun(run: string): void }) {
  const seen = useRef<Set<string> | null>(null), open = useRef(openRun), allowBrowser = useRef(false);
  open.current = openRun; allowBrowser.current = !!browser?.enabled;
  const waiting = runs.filter(item => item.status === 'waiting');
  useEffect(() => {
    if (shell !== 'web') return;
    document.title = waiting.length ? `(${waiting.length}) langflow` : 'langflow';
  }, [waiting.length, shell]);
  useEffect(() => () => { if (shell === 'web') document.title = 'langflow'; }, [shell]);
  useEffect(() => {
    if (!loaded) return;
    const keys = new Set(waiting.map(item => `${item.run}\u0000${item.gate ?? item.step ?? ''}`));
    if (!seen.current) { seen.current = keys; return; }
    for (const item of waiting) {
      const key = `${item.run}\u0000${item.gate ?? item.step ?? ''}`;
      if (seen.current.has(key)) continue;
      const title = `${item.run} chờ duyệt`, body = `Gate ${item.gate ?? item.step ?? ''}${item.question ? `: ${item.question}` : ''}`;
      pushToast({ title, body, run: item.run });
      if (shell === 'web' && allowBrowser.current && (document.hidden || !document.hasFocus())) {
        try {
          const note = new Notification(`langflow · ${title}`, { body: body.slice(0, 240), tag: `langflow:${key}` });
          note.onclick = () => { window.focus(); open.current(item.run); note.close(); };
        } catch { /* some browsers only allow notifications from a service worker */ }
      }
    }
    seen.current = keys;
  }, [runs, loaded, shell]);  // eslint-disable-line react-hooks/exhaustive-deps
  return waiting.length;
}
