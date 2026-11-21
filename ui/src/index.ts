/**
 * Entry for hosts that mount the langflow UI themselves (the Nimbalyst extension, S3):
 *
 *   import { App, setApiTransport, registerDocumentRules } from '<langflow>/ui/src/index';
 *   import appStyles from '<langflow>/ui/src/app.css?inline';
 *   setApiTransport((path, method, body) => host.callBackendTool('langflow.api', { method, path, body }));
 *   registerDocumentRules('langflow-panel', appStyles);      // @font-face/@property do not work inside a shadow root
 *   createRoot(mountInShadowRoot).render(<App shell="panel" />);
 *
 * The transport gets the API path with its query (e.g. "/api/runs/x/log?offset=120"), the method, and the JSON body
 * (undefined for GET); it returns { status, body } with the parsed JSON body. Errors are { error } with status >= 400.
 */
export { default as App } from './App';
export { setApiTransport, httpTransport, type ApiTransport, type ApiResult } from './api';
/** Optional host abilities, e.g. `setHostHooks({ openFile: path => host.openFile(path) })` in the Nimbalyst panel. */
export { setHostHooks, type HostHooks } from './host';
export { registerDocumentRules, documentLevelRules } from './lib/shadow';
export type { ShellKind } from './shell/AppShell';
export type * from './types';
