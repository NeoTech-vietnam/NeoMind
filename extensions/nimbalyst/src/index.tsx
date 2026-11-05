/**
 * NeoMind extension: panel bundle. The panel is the NeoMind editor (Runs, Flow Studio, profiles, memory) in its `panel`
 * shell, rendered in a shadow root so its global styles stay inside the panel. Its API requests go to this extension's
 * backend module through `host.callBackendTool`, which the host limits to the extension's own tools.
 */
import { useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PanelHostProps } from '@nimbalyst/extension-sdk';
import App from '../../../ui/src/App';
import { setApiTransport } from '../../../ui/src/api';
import { registerDocumentRules } from '../../../ui/src/lib/shadow';
import appStyles from '../../../ui/src/app.css?inline';

/** The editor's page-level rules, rewritten for a shadow root that fills the panel. */
const panelStyles = `${appStyles.replace(/:root\b/g, ':host').replace(/(^|\n)\s*body\s*\{[^}]*\}/g, '$1')}
:host { display: block; height: 100%; }
.neomind-panel-root { height: 100%; }`;

export function NeoMindPanel({ host }: PanelHostProps) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setApiTransport(async (endpoint, method, body) =>
      host.callBackendTool('neomind.api', { method, path: endpoint, ...(body === undefined ? {} : { body }) }) as Promise<{ status: number; body: unknown }>);
    registerDocumentRules('neomind-panel', appStyles);
    const element = container.current!, shadow = element.shadowRoot ?? element.attachShadow({ mode: 'open' });
    shadow.replaceChildren();
    const style = document.createElement('style'); style.textContent = panelStyles;
    const mount = document.createElement('div'); mount.className = 'neomind-panel-root';
    shadow.append(style, mount);
    const root: Root = createRoot(mount);
    root.render(<App shell="panel" />);
    return () => { root.unmount(); };
  }, [host]);
  return <div ref={container} style={{ height: '100%' }} />;
}

export const panels = { neomind: { component: NeoMindPanel } };

export async function activate(): Promise<void> {}

export async function deactivate(): Promise<void> {}
