import { useEffect, useRef, useState } from 'react';

/** One pending text question. */
type Request = { message: string; initial: string; resolve(value: string | null): void };
let show: ((request: Request) => void) | undefined;

/**
 * Ask the user for one line of text inside the page. `window.prompt` is not available in Electron (the Nimbalyst panel),
 * so the editor never uses it; without a mounted host this falls back to it for tests in a plain browser.
 */
export function askText(message: string, initial = ''): Promise<string | null> {
  return new Promise(resolve => { if (show) show({ message, initial, resolve }); else resolve(window.prompt(message, initial)); });
}

/** Renders the questions `askText` asks; mount once near the root of the app. */
export function TextDialogHost() {
  const [request, setRequest] = useState<Request | null>(null), [value, setValue] = useState(''), input = useRef<HTMLInputElement>(null);
  useEffect(() => { show = next => { setRequest(next); setValue(next.initial); }; return () => { show = undefined; }; }, []);
  useEffect(() => { if (request) { input.current?.focus(); input.current?.select(); } }, [request]);
  if (!request) return null;
  const finish = (result: string | null) => { request.resolve(result); setRequest(null); };
  return <div className="drawer-backdrop text-dialog-backdrop" onClick={() => finish(null)}>
    <form className="text-dialog" role="dialog" aria-label={request.message} onClick={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); finish(value); }}
      onKeyDown={event => { if (event.key === 'Escape') finish(null); }}>
      <label>{request.message}<input ref={input} value={value} onChange={event => setValue(event.target.value)} /></label>
      <div className="text-dialog-actions"><button type="button" className="secondary-btn" onClick={() => finish(null)}>Hủy</button><button type="submit" className="primary-btn">OK</button></div>
    </form>
  </div>;
}
