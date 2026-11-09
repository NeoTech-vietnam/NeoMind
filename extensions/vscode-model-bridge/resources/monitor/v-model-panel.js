(() => {
  const vscode = acquireVsCodeApi();
  document.getElementById('focus-space')?.addEventListener('click', () => vscode.postMessage({ type: 'open-focus' }));
  const byId = id => document.getElementById(id);
  const { WorkForceUniverse } = window;
  const chooser = byId('request'), pin = byId('pin'), refresh = byId('refresh'), notice = byId('notice');
  const saved = vscode.getState();
  let requests = [], pinned, selectedId = saved?.selectedId, stageId = saved?.stageId;
  let manualSelection = false, chooserSignature;

  function selectStage(id) {
    stageId = id;
    vscode.setState({ selectedId, stageId });
    showStage();
  }

  const diagram = WorkForceUniverse.create(byId('v-model'), { onSelect: selectStage });
  // Only explicit running/repairing milestones animate. The native workbench
  // body class and OS media query remain authoritative CSS motion overrides.
  diagram.setMotion(true);
  const request = () => requests.find(item => item.workflow_id === selectedId);
  const label = value => String(value ?? 'unknown').replace(/[-_]/g, ' ');

  function followRequest() {
    const focus = pinned ? requests.find(item => item.workflow_id === pinned) :
      !manualSelection && document.activeElement !== chooser
        ? requests.find(item => item.workflow_id === selectedId && item.live) ?? requests.find(item => item.live)
        : undefined;
    if (focus && focus.workflow_id !== selectedId) { selectedId = focus.workflow_id; stageId = null; }
  }

  function renderChooser() {
    // Native popup navigation is transient until change. Do not disturb its options or value.
    if (document.activeElement === chooser) return;
    const options = requests.map(item => [item.workflow_id, [item.request_key || item.workflow_id, item.title].filter(Boolean).join(' · ')]);
    const signature = JSON.stringify(options);
    if (signature !== chooserSignature) {
      chooser.replaceChildren();
      for (const [id, text] of options) {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = text;
        chooser.append(option);
      }
      chooserSignature = signature;
    }
    chooser.disabled = !requests.length;
    if (chooser.value !== (selectedId ?? '')) chooser.value = selectedId ?? '';
  }

  function showStage() {
    const stage = WorkForceUniverse.buildScene(request()).stages.find(item => item.id === stageId);
    diagram.setSelected(stage?.id ?? null);
    byId('stage-detail').textContent = stage
      ? [stage.label, stage.role, label(stage.state), stage.summary].filter(Boolean).join(' · ')
      : 'Select a stage for details.';
    const canChoose = stage && ['WF.SWSD', 'WF.P-RES', 'WF.FnD', 'WF.Reviewer', 'WF.Tester'].includes(stage.role);
    byId('stage-model').hidden = !canChoose;
    if (canChoose) byId('stage-model').textContent = `Choose model for ${stage.role}…`;
  }

  function showFiles(container, files, workflowId, emptyText) {
    container.replaceChildren();
    if (!files.length) { container.textContent = emptyText; return; }
    for (const file of files) {
      if (typeof file.path !== 'string') continue;
      const row = document.createElement('div');
      row.className = 'product-row';
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = file.label || file.path;
      button.addEventListener('click', () => vscode.postMessage({ type: 'open-file', workflow_id: workflowId, path: file.path }));
      const detail = document.createElement('small');
      const state = typeof file.passed === 'boolean' ? file.passed ? 'passed' : 'failed' : file.state;
      detail.textContent = [file.path, state && label(state), Number.isInteger(file.exit_code) ? `exit ${file.exit_code}` : ''].filter(Boolean).join(' · ');
      row.append(button, detail);
      container.append(row);
    }
  }

  function renderRequest() {
    const selected = request(), isPinned = Boolean(selected && selected.workflow_id === pinned);
    pin.disabled = !selected;
    pin.setAttribute('aria-pressed', String(isPinned));
    pin.textContent = isPinned ? 'Unpin request' : 'Pin request';
    byId('details').hidden = byId('files').hidden = !selected;
    if (!selected) return;
    byId('title').textContent = [selected.request_key || selected.workflow_id, selected.title].filter(Boolean).join(' · ');
    byId('action').textContent = [label(selected.status), selected.current_action, Number.isInteger(selected.revision) ? `revision ${selected.revision}` : ''].filter(Boolean).join(' · ');
    byId('activity').textContent = selected.activity?.length ? selected.activity.map(agent =>
      `${agent.role} running · requested: ${agent.requested_model} · observed model: ${agent.observed_model} · observed provider: ${agent.observed_provider}`).join(' | ')
      : selected.source === 'native-local' ? 'Native Local · no current owned model call. Saved check evidence is shown below.' : 'Historical saved execution; native activity is not inferred.';
    diagram.setData(selected);
    const review = WorkForceUniverse.buildScene(selected).review;
    byId('review').dataset.state = WorkForceUniverse.stageState(review?.state ?? review?.status);
    byId('review-state').textContent = label(byId('review').dataset.state);
    showStage();
    showFiles(byId('artifacts'), selected.artifacts, selected.workflow_id, 'No saved artifacts.');
    showFiles(byId('evidence'), selected.evidence, selected.workflow_id, 'No saved check evidence.');
  }

  chooser.addEventListener('change', () => {
    // A focused selector can still show a request removed by a newer snapshot.
    if (!requests.some(item => item.workflow_id === chooser.value)) return;
    selectedId = chooser.value;
    manualSelection = true;
    stageId = null;
    vscode.setState({ selectedId, stageId });
    renderRequest();
  });
  chooser.addEventListener('blur', renderChooser);
  pin.addEventListener('click', () => {
    vscode.postMessage({ type: 'pin', workflow_id: selectedId === pinned ? null : selectedId });
  });
  const read = () => { refresh.disabled = true; vscode.postMessage({ type: 'refresh' }); };
  refresh.addEventListener('click', read);
  byId('models').addEventListener('click', () => vscode.postMessage({ type: 'choose-models' }));
  byId('stage-model').addEventListener('click', () => {
    const stage = WorkForceUniverse.buildScene(request()).stages.find(item => item.id === stageId);
    if (stage) vscode.postMessage({ type: 'choose-models', role: stage.role });
  });
  window.addEventListener('message', ({ data }) => {
    if (data?.type === 'model-policy') {
      notice.textContent = `${data.role}: ${data.selection === 'inherit' ? 'inherit native parent model' : 'explicit native model preference saved'} for its next delegation. Running calls keep their selected model.`;
      return;
    }
    if (data?.type === 'pinned') {
      pinned = data.workflow_id;
      if (!pinned) manualSelection = false;
      followRequest();
      renderChooser();
      renderRequest();
      return;
    }
    if (data?.type === 'error') {
      refresh.disabled = false;
      notice.textContent = 'Saved requests could not be read. The displayed snapshot may be stale.';
      return;
    }
    if (data?.type !== 'snapshot') return;
    refresh.disabled = false;
    if (pinned && !data.pinned) manualSelection = false;
    pinned = data.pinned;
    requests = data.requests;
    if (!request()) manualSelection = false;
    followRequest();
    if (!request()) {
      selectedId = requests.find(item => item.workflow_id === pinned)?.workflow_id ?? requests.find(item => item.live)?.workflow_id ?? requests[0]?.workflow_id;
      stageId = null;
    }
    byId('project').textContent = data.project;
    renderChooser();
    notice.textContent = requests.length ? `Read saved state at ${new Date().toLocaleTimeString()}.` : 'No saved WorkForce requests in this project.';
    renderRequest();
  });
  read();
})();
