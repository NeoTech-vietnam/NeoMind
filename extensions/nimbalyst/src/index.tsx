/**
 * langflow extension: panel bundle. The panel is the langflow UI (W:\projects\AI\langflow\ui) in its `panel` shell,
 * rendered in a shadow root so its global styles stay inside the panel. Its API requests go to this extension's backend
 * module through `host.callBackendTool('langflow.api', …)`; the backend proxies them to `langflow web --api-only` with
 * the server's token and the header `X-Langflow-Channel: panel`.
 */
import { useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App, setApiTransport, setHostHooks, styles } from 'langflow-ui-entry';

/**
 * The parts of Nimbalyst's PanelHost the panel uses (extension-sdk-docs/api-reference.md). The SDK has no notification
 * API for panels, so waiting gates show as a toast inside the panel only.
 */
interface PanelHost { callBackendTool: (name: string, args: Record<string, unknown>) => Promise<unknown>; openFile?: (path: string) => void }

/** The app's page-level rules, rewritten for a shadow root that fills the panel. */
const panelStyles = `${styles.replace(/:root\b/g, ':host').replace(/(^|\n)\s*body\s*\{[^}]*\}/g, '$1')}
:host { display: block; height: 100%; }
.langflow-panel-root { height: 100%; }`;

/**
 * Browsers ignore @property and @font-face inside a shadow root. Tailwind needs the first, bundled fonts the second,
 * so they are registered on the document once; they only declare custom properties and font faces.
 */
let documentRulesRegistered = false;
function registerDocumentRules(css: string): void {
  const rules = (css.match(/@property\s+[\w-]+\s*\{[^}]*\}|@font-face\s*\{[^}]*\}/g) ?? []).join('\n');
  if (documentRulesRegistered || !rules) return;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(rules);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  documentRulesRegistered = true;
}

export function LangflowPanel({ host }: { host: PanelHost }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setApiTransport(async (endpoint, method, body) =>
      host.callBackendTool('langflow.api', { method, path: endpoint, ...(body === undefined ? {} : { body }) }) as Promise<{ status: number; body: unknown }>);
    // Output and gate files open in a Nimbalyst editor tab ("Mở" in the file preview).
    setHostHooks(typeof host.openFile === 'function' ? { openFile: path => host.openFile!(path) } : {});
    registerDocumentRules(styles);
    const element = container.current!, shadow = element.shadowRoot ?? element.attachShadow({ mode: 'open' });
    shadow.replaceChildren();
    const style = document.createElement('style'); style.textContent = panelStyles;
    const mount = document.createElement('div'); mount.className = 'langflow-panel-root';
    shadow.append(style, mount);
    const root: Root = createRoot(mount);
    root.render(<App shell="panel" />);
    return () => { root.unmount(); };
  }, [host]);
  return <div ref={container} style={{ height: '100%' }} />;
}

export const panels = { langflow: { component: LangflowPanel } };

export async function activate(): Promise<void> {}

export async function deactivate(): Promise<void> {}
