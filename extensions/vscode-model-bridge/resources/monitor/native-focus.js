/* Reuse the existing FocusSpace controller, independently of the agent UI. */
(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  let initialized = false;
  const focus = window.WorkForceFocusSpace.create({ vscode,
    onViewChange(view) { if (initialized && view === 'universe') vscode.postMessage({ type: 'open-v-model' }); } });
  focus?.open();
  initialized = true;
})();
