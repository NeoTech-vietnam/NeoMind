(() => {
  'use strict';
  const vscode = acquireVsCodeApi(), byId = id => document.getElementById(id);
  const text = (value, fallback = '') => typeof value === 'string' && value ? value : fallback;
  const roleProfiles = [
    { name: 'WF.PM', role: 'manager', duty: 'Coordinate and deliver' },
    { name: 'WF.SWSD', role: 'requirements', duty: 'Requirements and acceptance' },
    { name: 'WF.P-RES', role: 'architect', duty: 'Architecture and interfaces' },
    { name: 'WF.FnD', role: 'developer', duty: 'Implement and repair' },
    { name: 'WF.Reviewer', role: 'reviewer', duty: 'Independent review' },
    { name: 'WF.Tester', role: 'verifier', duty: 'Independent verification' },
  ];
  const roleName = role => roleProfiles.find(item => item.role === role)?.name ?? text(role, 'WorkForce');
  const terminal = request => ['completed', 'cancelled', 'canceled'].includes(request?.status) || ['completed', 'cancelled', 'canceled'].includes(request?.historical_status);
  let saved;
  try { saved = vscode.getState?.() ?? {}; } catch { saved = {}; }
  let selected = saved.selectedRequest ?? null, selectedStage = null, requests = [], roles = [], intake = null, renderedQuestion = null;
  let enabled = false, busy = false, connectionBusy = false, stale = false, motion = saved.motionEnabled !== false, controlsUnavailable = true;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)'), requestRows = new Map(), roleRows = new Map();
  const element = (tag, content, className) => {
    const node = document.createElement(tag); if (content !== undefined) node.textContent = content;
    if (className) node.className = className; return node;
  };
  const requestId = request => request?.workflow_id ?? request?.request_id;
  const current = () => requests.find(item => requestId(item) === selected);
  function dependencyWait(request) {
    const wait = request?.dependency_wait, labels = { storage: 'local execution storage', provider: 'the configured model provider', prerequisite: 'a required local tool' };
    if (request?.status !== 'waiting' || !labels[wait?.code] || !Number.isFinite(Date.parse(wait.next_condition_check_at))) return null;
    const scheduled = new Date(wait.next_condition_check_at).toLocaleString();
    return { label: labels[wait.code], message: enabled && !stale
      ? `Waiting for ${labels[wait.code]}. Next scheduled condition check: ${scheduled}. WorkForce continues automatically when the condition recovers.`
      : `Saved wait for ${labels[wait.code]}. Connect WorkForce to continue its automatic condition checks.` };
  }
  function persist() {
    let existing;
    try { existing = vscode.getState?.() ?? {}; } catch { existing = {}; }
    vscode.setState?.({ ...existing, selectedRequest: selected, motionEnabled: motion, draft: byId('requirement').value });
  }
  byId('requirement').value = text(saved.draft);
  const action = (name, extra = {}) => vscode.postMessage({ type: 'controlled-action', action: name, ...extra });
  let universe;
  const diagram = window.WorkForceUniverse;
  const sceneFor = request => diagram?.buildScene?.(request) ?? { stages: [], review: null };
  try { universe = window.WorkForceUniverse.create(byId('v-model'), { onSelect(id) { selectedStage = id; renderStage(); } }); }
  catch { byId('v-model').append(element('p', 'The stage diagram is unavailable. Request details and products remain accessible.', 'muted')); }
  function renderStage() {
    const stage = sceneFor(current()).stages.find(item => item.id === selectedStage);
    byId('stage-detail').textContent = stage ? `${stage.label} · ${stage.role} · ${stage.state.replaceAll('-', ' ')}${stage.summary ? ` — ${stage.summary}` : ''}`
      : 'Select a stage to inspect its result or applicability.';
  }
  function renderRequests() {
    const container = byId('requests'), ids = new Set(requests.map(requestId));
    for (const [id, row] of requestRows) if (!ids.has(id)) { row.root.remove(); requestRows.delete(id); }
    for (const request of requests) {
      const id = requestId(request); let row = requestRows.get(id);
      if (!row) {
        const root = element('button', undefined, 'request-row'), title = element('strong'), state = element('span');
        root.type = 'button'; root.append(title, state);
        root.addEventListener('click', () => { selected = id; selectedStage = null; persist(); render(); });
        row = { root, title, state }; requestRows.set(id, row);
      }
      row.title.textContent = text(request.title, request.request_key ?? id);
      row.state.textContent = `${text(request.request_key, id)} · ${text(request.status, 'unknown').replaceAll('_', ' ')}`;
      row.root.setAttribute('aria-pressed', String(id === selected)); container.append(row.root);
    }
    for (const child of [...container.children]) if (!child.classList.contains('request-row')) child.remove();
    if (!requests.length) container.append(element('p', 'No requests yet. Describe a useful outcome to begin.', 'empty'));
  }
  function renderProducts(request) {
    byId('products').replaceChildren(); byId('criteria').replaceChildren(); byId('findings').replaceChildren();
    for (const product of request?.artifacts ?? []) {
      const row = element('div', undefined, 'product-row'), button = element('button', product.label ?? product.path);
      button.type = 'button'; button.disabled = product.exists === false;
      button.addEventListener('click', () => vscode.postMessage({ type: 'open-product', workflow_id: requestId(request), path: product.path }));
      row.append(button, element('small', `${text(product.state ?? product.status, 'verification not established')} · ${text(product.summary, product.path)}${product.sha256 ? ` · ${product.sha256.slice(0, 12)}` : ''}`));
      byId('products').append(row);
    }
    for (const criterion of request?.criteria ?? []) {
      const row = element('div', undefined, 'criterion-row'); row.dataset.state = criterion.state ?? criterion.status ?? 'pending';
      row.append(element('p', criterion.text ?? criterion.title ?? criterion.id),
        element('small', `${text(criterion.state ?? criterion.status, 'pending')}${criterion.summary ? ` · ${criterion.summary}` : ''}`));
      byId('criteria').append(row);
    }
    for (const finding of request?.findings ?? []) byId('findings').append(element('p', typeof finding === 'string' ? finding
      : `${finding.criterion_id ?? finding.criterion ?? finding.owner ?? ''}${finding.summary || finding.message ? ': ' : ''}${finding.summary ?? finding.message ?? ''}`, 'finding-row'));
    byId('handoff').textContent = request?.status === 'completed' || request?.historical_status === 'completed'
      ? request.accepted === false ? 'The saved request completed, but the current files are not accepted. Review changed outputs and verification.'
        : 'The runtime accepted the delivered revision. Open the products above to use the result.'
      : request?.artifacts?.length ? 'These saved outputs remain available while WorkForce completes the remaining review and checks.' : '';
    byId('open-request-folder').hidden = !request?.folder;
  }
  function renderRoles() {
    const container = byId('roles');
    for (const profile of roleProfiles) {
      let row = roleRows.get(profile.role);
      if (!row) {
        const root = element('article', undefined, 'role'), name = element('strong', profile.name), duty = element('p', profile.duty), model = element('p'), button = element('button', 'Change model');
        button.type = 'button'; button.addEventListener('click', () => vscode.postMessage({ type: 'select-model', role: profile.role }));
        root.append(name, duty, model, button); container.append(root); row = { root, model, button }; roleRows.set(profile.role, row);
      }
      const configured = roles.find(item => item.role === profile.role);
      row.model.textContent = configured ? `${configured.models?.join(' / ') ?? 'Not configured'} · ${configured.provider ?? 'configured provider'}` : 'Routing unavailable';
      row.button.disabled = controlsUnavailable || !configured || stale;
      row.button.setAttribute('aria-label', `Change model for ${profile.name}`);
    }
  }
  function render() {
    const request = current(); renderRequests(); renderProducts(request); renderRoles();
    const dependency = dependencyWait(request);
    byId('request-title').textContent = text(request?.title, 'Give WorkForce a request');
    byId('request-key').textContent = text(request?.request_key, selected ?? 'YOUR NEXT PRODUCT');
    const active = request?.active_invocations ?? [];
    const actual = active.map(item => `${roleName(item.role)} · ${item.state ?? item.status ?? 'unknown'}${item.requested_model ? ` · requested ${item.requested_model}` : ''}${item.confirmed_model ? ` · engine observed ${item.model_provider ?? item.provider ?? 'provider'}/${item.confirmed_model}` : ''}`).join(' | ');
    byId('request-action').textContent = stale ? 'Connection unavailable. Displaying the last saved request; work has not been marked complete.'
      : dependency?.message ?? text(request?.current_action, actual || (request ? `Current stage: ${request.phase ?? 'not reported'}` : 'The V-model will show the real engineering progress.'));
    byId('pm-action').textContent = actual || (dependency ? `Waiting for ${dependency.label}.` : request ? 'Coordinates this request and its next evidence-backed action.' : 'Coordinates requirements, implementation and evidence.');
    byId('request-status').textContent = text(request?.status, 'No request selected').replaceAll('_', ' ');
    byId('request-status').dataset.state = request?.status ?? 'none';
    const controls = byId('request-controls'); controls.replaceChildren();
    if (request) for (const control of ['pause', 'resume', 'cancel']) {
      const button = element('button', control[0].toUpperCase() + control.slice(1)); button.type = 'button';
      button.disabled = busy || !enabled || stale || terminal(request);
      button.addEventListener('click', () => action(control, { workflow_id: requestId(request) })); controls.append(button);
    }
    const health = request?.runtime_health;
    if (dependency) controls.append(element('p', dependency.message, 'hint'));
    else if (health?.message) controls.append(element('p', health.message, 'hint'));
    else if (request?.blocker?.message) controls.append(element('p', `WorkForce needs to resolve an execution issue: ${request.blocker.message}`, 'hint'));
    byId('submit').disabled = busy || !enabled || stale || intake?.state === 'accepted';
    byId('submit').textContent = intake?.state === 'acknowledged' ? 'Start another request'
      : ['unknown', 'prepared'].includes(intake?.state) && intake?.requirement ? 'Continue saved submission' : 'Start request';
    const question = request?.question;
    const questionKey = question?.id ? `${requestId(request)}:${question.id}` : null;
    if (questionKey !== renderedQuestion) { byId('answer').value = ''; renderedQuestion = questionKey; }
    byId('question-panel').hidden = !question || question.status === 'answered';
    byId('question-text').textContent = text(question?.text ?? question?.missing);
    byId('question-reason').textContent = text(question?.reason);
    byId('answer-submit').disabled = busy || !enabled || stale || !question?.id;
    const scene = sceneFor(request), review = scene.review;
    const reviewState = diagram?.stageState?.(review?.state ?? review?.status) ?? 'pending';
    byId('review-milestone').dataset.state = reviewState;
    byId('review-state').textContent = `${reviewState.replaceAll('-', ' ')}${review?.summary ? ` · ${review.summary}` : ''}`;
    universe?.setData(request); universe?.setSelected(selectedStage); renderStage(); updateMotion();
    document.body.classList.toggle('is-stale', stale); persist();
  }
  function updateMotion() {
    universe?.setMotion(motion && !reduced.matches && !document.hidden && !stale);
    const button = byId('motion'); button.disabled = reduced.matches;
    button.textContent = reduced.matches ? 'Reduced motion' : motion ? 'Pause motion' : 'Resume motion';
    button.setAttribute('aria-pressed', String(!motion));
  }
  function renderSetup(value) {
    const setup = value.setup ?? {}, checks = byId('setup-checks'); checks.replaceChildren();
    byId('setup-title').textContent = setup.ready === true ? 'WorkForce ready' : value.enabled ? 'WorkForce connected' : 'Connect your workspace';
    byId('setup-summary').textContent = text(setup.summary, value.enabled ? 'Model and tool capability are checked on actual execution.' : 'Connect the trusted runtime and select your Local model.');
    byId('setup-build').textContent = [setup.version ? `Runtime ${setup.version}` : '', setup.engine_version ? `OpenCode ${setup.engine_version}` : '', setup.build_fingerprint ? `Build ${setup.build_fingerprint.slice(0, 16)}` : ''].filter(Boolean).join(' · ');
    for (const check of setup.checks ?? []) {
      const tag = element('span', `${check.label} · ${check.summary ?? check.state}`, 'check-tag'); tag.dataset.state = check.state ?? 'unknown'; checks.append(tag);
    }
    byId('setup-connect').hidden = false;
    byId('setup-connect').disabled = connectionBusy;
    byId('setup-connect').textContent = connectionBusy ? 'Checking connection…' : value.enabled ? 'Disconnect WorkForce' : 'Connect WorkForce';
  }
  window.addEventListener('message', event => {
    const value = event.data; if (!value || typeof value !== 'object') return;
    if (value.type === 'snapshot') {
      enabled = value.enabled === true; stale = false; roles = Array.isArray(value.roles) ? value.roles : roles;
      controlsUnavailable = value.control_unavailable === true || value.active_count > 0 && value.controlled_model_changes !== true;
      byId('project-name').textContent = text(value.project?.name, 'Selected workspace');
      byId('project-name').setAttribute('title', text(value.project?.root)); renderSetup(value); render();
    } else if (value.type === 'controlled-snapshot') {
      requests = Array.isArray(value.workflows) ? value.workflows : [];
      enabled = value.enabled === true; intake = value.intake ?? null; stale = false;
      if (!requests.some(item => requestId(item) === selected)) selected = requestId(requests[0]) ?? null;
      if (intake?.requirement && !byId('requirement').value) byId('requirement').value = intake.requirement;
      render();
    } else if (value.type === 'controlled-receipt') {
      const request = value.workflows?.[0];
      if (request) { selected = requestId(request); requests = [request, ...requests.filter(item => requestId(item) !== selected)]; }
      if (['submit', 'submit_new'].includes(value.action)) {
        intake = value.intake ?? intake; byId('requirement').value = '';
        if (intake?.generation && request) vscode.postMessage({ type: 'controlled-receipt-ack', generation: intake.generation, workflow_id: requestId(request) });
        byId('notice').textContent = 'Request saved. WorkForce is preparing your product.';
      } else byId('notice').textContent = 'Your action was recorded.';
      render();
    } else if (value.type === 'controlled-busy') { busy = value.busy === true; render(); }
    else if (value.type === 'connection-busy') {
      connectionBusy = value.busy === true; byId('setup-connect').disabled = connectionBusy;
      byId('setup-connect').textContent = connectionBusy ? 'Checking connection…' : enabled ? 'Disconnect WorkForce' : 'Connect WorkForce';
    }
    else if (value.type === 'error' || value.type === 'controlled-error') {
      stale = value.type === 'error'; byId('notice').textContent = text(value.message, 'WorkForce could not complete this action. Your saved outputs were preserved.'); render();
    }
  });
  byId('submit').addEventListener('click', () => {
    const requirement = byId('requirement').value.trim(); if (!requirement) { byId('notice').textContent = 'Describe the useful result you want first.'; return; }
    action(intake?.state === 'acknowledged' ? 'submit_new' : 'submit', { requirement, ...(intake?.generation ? { generation: intake.generation } : {}) }); persist();
  });
  byId('answer-submit').addEventListener('click', () => {
    const answer = byId('answer').value.trim(); if (!answer || !current()) return;
    if (!current().question?.id) return;
    action('resume', { workflow_id: requestId(current()), answer, question_id: current().question.id });
  });
  byId('open-request-folder').addEventListener('click', () => { if (current()) vscode.postMessage({ type: 'open-request-folder', workflow_id: requestId(current()) }); });
  byId('requirement').addEventListener('input', persist);
  byId('new-request').addEventListener('click', () => { byId('compose').hidden = false; byId('requirement').focus(); });
  byId('setup-connect').addEventListener('click', () => vscode.postMessage({ type: enabled ? 'disconnect' : 'connect' }));
  byId('select-model-catalog').addEventListener('click', () => vscode.postMessage({ type: 'select-model-catalog' }));
  byId('open-local').addEventListener('click', () => vscode.postMessage({ type: 'open-local' }));
  byId('manage-plugins').addEventListener('click', () => vscode.postMessage({ type: 'open-plugins' }));
  byId('open-automation').addEventListener('click', () => vscode.postMessage({ type: 'open-automation' }));
  byId('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  byId('motion').addEventListener('click', () => { motion = !motion; persist(); updateMotion(); });
  reduced.addEventListener?.('change', updateMotion); document.addEventListener('visibilitychange', updateMotion);
  const focusSpace = window.WorkForceFocusSpace?.create({ vscode });
  window.addEventListener('pagehide', () => { focusSpace?.destroy(); universe?.destroy(); }, { once: true });
  render(); vscode.postMessage({ type: 'refresh' });
})();
