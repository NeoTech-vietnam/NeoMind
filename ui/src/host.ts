/**
 * Optional abilities of the page's host. The web page has none; the Nimbalyst panel sets `openFile` (PanelHost.openFile)
 * so an output or gate file opens in a Nimbalyst editor tab. The extension SDK has no notification API for panels
 * (checked 2026-11-17 in Nimbalyst's extension-sdk-docs/api-reference.md: PanelHost has openFile, openPanel, exec,
 * storage, data, ai), so the panel announces waiting gates with an in-panel toast only.
 */
export type HostHooks = { openFile?: (path: string) => void };

let hooks: HostHooks = {};
export function setHostHooks(next: HostHooks): void { hooks = next; }
export function hostHooks(): HostHooks { return hooks; }
