(() => {
  const vscode = acquireVsCodeApi();
  const byId = id => document.getElementById(id);
  const canvas = byId('field'), status = byId('status'), rolesContainer = byId('roles');
  const nodesContainer = byId('nodes'), selection = byId('selection'), activity = byId('activity');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let persisted;
  try { persisted = vscode.getState?.(); } catch {}
  if (!persisted || typeof persisted !== 'object' || Array.isArray(persisted)) persisted = {};
  let selected = persisted.selectedId ?? persisted.selected ?? null;
  let motionEnabled = typeof persisted.motionEnabled === 'boolean' ? persisted.motionEnabled : !reduced.matches;
  let focusOpen = false, focusSpace = null;
  let map = null, configuredRoles = [], nodesById = new Map(), rolesById = new Map();
  let unavailable = true, controlUnavailable = true, activeCount = null, routerConfigured = false, errorReason = '';
  let selectionNote = '', search = '';
  const roleRows = new Map(), nodeRows = new Map(), evidenceRows = new Map(), activityRows = new Map(), selectedActivityRows = new Map(), liveRows = new Map();
  let profiles = [], groups = {};
  const value = (text, fallback = 'Not recorded') => typeof text === 'string' && text.trim() ? text : fallback;
  const title = role => role.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  const roleTitle = role => {
    const primary = profiles.filter(profile => profile.model_role === role && profile.roles.includes(role));
    return primary.length ? primary.map(profile => profile.name.replace(/^NeoMind\s+/, '').replace(/\s+Agent$/, '')).join(' / ') : title(role);
  };
  const setText = (node, text) => { if (node && node.textContent !== String(text)) node.textContent = String(text); };
  const element = (tag, text = '', className = '') => {
    const node = document.createElement(tag); node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (text, className, action) => {
    const node = element('button', text, className); node.type = 'button'; node.addEventListener('click', action); return node;
  };
  const sourceLabel = item => item.source === 'signed-receipt' ? 'Signed local receipt'
    : item.source === 'native-activity' ? 'Reported native activity (unsigned)'
    : item.source === 'project-record' ? item.kind === 'agent' ? 'Reported native contribution' : 'Saved project record' : 'Source unavailable';
  const timestamp = raw => {
    if (typeof raw !== 'string' || !raw) return 'Time not recorded';
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? 'Time not recorded' : date.toLocaleString();
  };
  function persist() {
    let latest;
    try { latest = vscode.getState?.(); } catch {}
    persisted = { ...(latest && typeof latest === 'object' && !Array.isArray(latest) ? latest : persisted), selectedId: selected, motionEnabled };
    try { vscode.setState?.(persisted); } catch {}
  }
  function changeBlocked() {
    if (unavailable) return 'Refresh saved state before changing models.';
    if (controlUnavailable) return 'Model policy or receipt trust is unavailable. Inspect project configuration.';
    if (activeCount === null) return 'Active invocation status is unavailable.';
    if (activeCount > 0) return 'Finish or stop active signed invocations before changing models.';
    return '';
  }
  function requestModel(role) {
    if (!rolesById.has(role) || changeBlocked()) return;
    vscode.postMessage({ type: 'select-model', role });
  }
  function select(id, focus = false) {
    if (!(typeof id === 'string' && id.startsWith('role:') && rolesById.has(id.slice(5))) && !nodesById.has(id)) return;
    selected = id; selectionNote = ''; persist();
    universe?.setSelected(id);
    if (focus) universe?.focus(id);
    updateSelection(); updateSelectedRows();
  }
  let universe = null;
  try {
    if (canvas && typeof window.NeoMindUniverse?.create === 'function') {
      universe = window.NeoMindUniverse.create(canvas, { onSelect: id => select(id) });
    }
  } catch { /* Lists and model policy controls remain available without graphics. */ }
  const graphicsUnavailable = !universe;

  // Keyed updates keep focused controls and DOM identity stable between polls.
  function reconcile(container, cache, items, make, update) {
    if (!container) return;
    const wanted = new Set(items.map(item => item.id));
    for (const [id, row] of cache) if (!wanted.has(id)) { row.root.remove(); cache.delete(id); }
    const desired = items.map(item => {
      let row = cache.get(item.id);
      if (!row) { row = make(item); cache.set(item.id, row); }
      update(row, item);
      return row.root;
    });
    for (const child of [...container.children]) if (!desired.includes(child)) child.remove();
    desired.forEach((root, index) => {
      if (container.children[index] !== root) container.insertBefore(root, container.children[index] ?? null);
    });
  }
  function modelLabel(role) { return role.models.length ? role.models.join(' → ') : 'No configured model'; }
  function makeRole(role) {
    const root = element('div', '', 'role role-row');
    const pick = button('', 'role-option', () => select(`role:${role.role}`, true));
    const name = element('strong', '', 'role-name'), policy = element('span', '', 'role-policy');
    const provider = element('span', '', 'role-provider'), note = element('span', '', 'role-note');
    pick.append(name, policy, provider, note);
    const change = button('Change model', 'role-change change-model', () => requestModel(role.role));
    change.dataset.role = role.role;
    root.append(pick, change);
    return { root, pick, name, policy, provider, note, change };
  }
  function updateRole(row, role) {
    setText(row.name, roleTitle(role.role)); setText(row.policy, modelLabel(role));
    setText(row.provider, `${value(role.provider, 'Provider not specified')} · ${value(role.reasoning_effort, 'Unspecified')} requested effort`);
    const group = groups[role.role], independent = group && group[1] !== role.role;
    setText(row.note, `${controlUnavailable || unavailable ? 'Last known policy' : 'Configured role'}${group ? ` · ${group[0]}` : ''}${independent ? ` · Native model: ${group[1]}` : ''}`);
    setText(row.change, independent ? 'Change role model (strict)' : 'Change model');
    row.change.disabled = Boolean(changeBlocked()); row.change.title = changeBlocked() || 'Applies to the next invocation';
    row.change.setAttribute('aria-label', `Change ${role.role} model${independent ? ' for strict bridge invocations' : ''}`);
    row.pick.setAttribute('aria-label', `${roleTitle(role.role)} · ${modelLabel(role)} · configured policy`);
    row.root.hidden = Boolean(search && !`${role.role} ${role.models.join(' ')} ${role.provider ?? ''} ${group?.[0] ?? ''}`.toLowerCase().includes(search));
  }
  function makeNode(node) {
    const root = button('', 'saved-item record-link related-node', () => select(node.id, true));
    const name = element('strong'), detail = element('span', '', 'saved-state');
    const provenance = element('span', '', 'state-badge evidence-badge');
    root.append(name, detail, provenance);
    return { root, name, detail, provenance };
  }
  function updateNode(row, node) {
    setText(row.name, value(node.label, node.id));
    setText(row.detail, `${value(node.kind, 'Saved item')} · ${node.source === 'native-activity' ? 'Reported state' : unavailable ? 'Last saved state' : 'Saved state'}: ${value(node.state, 'unknown')}`);
    setText(row.provenance, sourceLabel(node));
    row.root.dataset.state = unavailable ? 'stale' : value(node.state, 'unknown');
    row.root.dataset.source = value(node.source, 'unknown');
    row.root.title = `${value(node.source_id, node.id)} · ${timestamp(node.updated_at)}`;
  }
  function communicationEdges() {
    return (map?.edges ?? []).filter(edge => ['handoff', 'report', 'contribution'].includes(edge.kind))
      .slice().sort((a, b) => value(b.at, '').localeCompare(value(a.at, '')));
  }
  function makeActivity() {
    const root = element('div', '', 'activity-row activity-item communication');
    const heading = element('strong'), route = element('span'), evidence = element('small');
    root.append(heading, route, evidence);
    return { root, heading, route, evidence };
  }
  function updateActivity(row, edge) {
    setText(row.heading, `${edge.source === 'native-activity' ? 'Reported' : 'Recorded'} ${edge.kind}`);
    setText(row.route, `${value(nodesById.get(edge.from)?.label, edge.from)} → ${value(nodesById.get(edge.to)?.label, edge.to)}`);
    setText(row.evidence, `${edge.source === 'signed-receipt' ? 'Signed local receipt' : edge.source === 'native-activity' ? 'Unsigned activity report' : 'Saved project record'} · ${value(edge.evidence_id)} · ${timestamp(edge.at)}`);
  }
  function updateInteractions() {
    const candidates = (map?.nodes ?? []).filter(node => node.kind === 'agent' &&
      (node.source === 'native-activity' || node.source === 'signed-receipt') &&
      (['running', 'waiting', 'blocked'].includes(node.state) || node.expired));
    const active = candidates.filter(node => !node.expired && node.reported_state !== 'dispatched' && ['running', 'waiting'].includes(node.state));
    setText(byId('live-summary'), unavailable ? 'Activity unavailable; displayed assignments are last known reports.' : candidates.length
      ? `${active.length} active assignments · unsigned reports expire after five minutes without an update.`
      : 'No current activity reports. Existing Copilot chats are not automatically observed; use updated profiles and restart the NeoMind MCP server.');
    reconcile(byId('live-agents'), liveRows, candidates.slice(0, 12), node => {
      const root = button('', 'live-agent', () => select(node.id, true));
      const name = element('strong'), detail = element('span'), time = element('small'); root.append(name, detail, time);
      return { root, name, detail, time };
    }, (row, node) => {
      setText(row.name, value(node.label, roleTitle(node.role ?? 'unknown')));
      setText(row.detail, `${node.source === 'native-activity' ? 'Reported' : 'Signed observation'} ${node.reported_state === 'dispatched' && !node.expired ? 'dispatch attempted' : node.expired ? 'unknown · update expired' : value(node.state)}${node.activity_summary ? ` · ${node.activity_summary}` : ''}`);
      setText(row.time, `Updated ${timestamp(node.updated_at)} · ${sourceLabel(node)}`);
      row.root.dataset.state = unavailable || node.expired ? 'unknown' : node.state;
    });
  }

  // The inspector keeps its model button mounted while the selected policy refreshes.
  const inspector = selection ? (() => {
    const header = element('div', '', 'selection-header');
    const name = element('h2', 'Select an orbit', 'inspector-title');
    const source = element('span', '', 'state-badge'); header.append(name, source);
    const description = element('p', '', 'inspector-description');
    const fields = element('dl', '', 'inspector-fields'), fieldRows = new Map();
    const actions = element('div', '', 'inspector-actions');
    const change = button('Change model', 'model-change change-model', () => {
      const role = selected?.startsWith('role:') ? selected.slice(5) : nodesById.get(selected)?.role;
      if (role) requestModel(role);
    });
    actions.append(change);
    const group = element('p', '', 'group-guidance');
    const evidenceHeading = element('h3', 'Attached saved evidence');
    const evidence = element('div', '', 'evidence-list');
    const linksHeading = element('h3', 'Recorded communications');
    const links = element('div', '', 'selection-activity');
    selection.replaceChildren(header, description, fields, actions, group, evidenceHeading, evidence, linksHeading, links);
    return { name, source, description, fields, fieldRows, change, group, evidenceHeading, evidence, linksHeading, links };
  })() : null;
  function setFields(entries) {
    if (!inspector) return;
    reconcile(inspector.fields, inspector.fieldRows, entries.map(([label, text]) => ({ id: label, text })), field => {
      const root = element('div', '', 'detail-row inspector-field');
      const label = element('dt', field.id), text = element('dd'); root.append(label, text);
      return { root, text };
    }, (row, field) => setText(row.text, field.text));
  }
  function groupGuidance(role) {
    const group = groups[role];
    if (!group) return 'Model policy applies to the next invocation; it does not confirm execution or a responding backend.';
    return group[1] === role
      ? `Native Copilot uses this role's model for ${group[0]}. Strict bridge mode selects this role independently. Changes apply to the next invocation.`
      : `Native Copilot groups this role in ${group[0]} and uses the ${group[1]} model policy. This role's independent model choice applies to strict bridge invocations.`;
  }
  function updateSelection() {
    if (!inspector) return;
    const roleId = typeof selected === 'string' && selected.startsWith('role:') ? selected.slice(5) : null;
    const role = roleId ? rolesById.get(roleId) : null, node = nodesById.get(selected);
    let attached = [], relatedIds = new Set();
    if (role) {
      attached = (map?.nodes ?? []).filter(item => item.role === role.role);
      relatedIds = new Set(attached.map(item => item.id));
      setText(inspector.name, roleTitle(role.role));
      setText(inspector.source, controlUnavailable || unavailable ? 'Last known role policy' : 'Configured role policy');
      setText(inspector.description, selectionNote || 'This planet represents configuration. Its orbit does not imply a running agent or a confirmed model.');
      setFields([
        ['Role', role.role], ['Configured model', modelLabel(role)], ['Configured provider', value(role.provider, 'Not specified')],
        ['Requested effort', value(role.reasoning_effort, 'Not specified')], ['Model observation', 'Not established by role configuration'],
        ['Saved evidence', `${attached.length} items in this snapshot`],
      ]);
    } else if (node) {
      const direct = (map?.edges ?? []).filter(edge => edge.from === node.id || edge.to === node.id);
      relatedIds = new Set([node.id, node.workflow_id, node.task_id, ...direct.flatMap(edge => [edge.from, edge.to])].filter(Boolean));
      attached = (map?.nodes ?? []).filter(item => item.id !== node.id && relatedIds.has(item.id));
      setText(inspector.name, value(node.label, node.id)); setText(inspector.source, sourceLabel(node));
      setText(inspector.description, node.source === 'native-activity' ? 'Unsigned assignment progress reported by the native agents. A dispatch is an attempt; expired updates become unknown. This does not attest model inference or task acceptance.' : unavailable ? 'Last saved evidence. Current state is unavailable; animation is not a live heartbeat.'
        : 'Saved evidence and recorded relationships. A signed local receipt is not provider-issued proof or task acceptance.');
      const fields = [
        ['Kind', value(node.kind)], ['Saved state', `${unavailable ? 'Last known: ' : ''}${value(node.state, 'unknown')}`],
        ['Source ID', value(node.source_id, node.id)], ['Role', value(node.role)],
      ];
      if (node.kind === 'agent') fields.push(
        ['Requested model', value(node.requested_model)],
        ['Confirmed model', node.source === 'signed-receipt' ? value(node.confirmed_model) : 'Not attested by this project record'],
        ['Recorded provider', value(node.provider)], ['Execution mode', value(node.execution_mode)],
      );
      if (node.source === 'native-activity') fields.push(
        ['Profile', value(node.profile_id)], ['Assignment', value(node.assignment_id)],
        ['Activity', value(node.activity_summary)], ['Freshness', node.expired ? 'Expired · current state unknown' : node.expires_at ? `Report expires ${timestamp(node.expires_at)}` : 'Terminal report · no active lease'],
      );
      fields.push(
        ['Workflow', value(node.workflow_id)], ['Task', value(node.task_id)], ['Updated', timestamp(node.updated_at)],
      );
      setFields(fields);
    } else {
      setText(inspector.name, 'Select an orbit'); setText(inspector.source, 'No evidence selected');
      setText(inspector.description, 'Choose a configured role, planet, or saved item to inspect its policy and evidence.');
      setFields([]);
    }
    const modelRole = role?.role ?? (node?.role && rolesById.has(node.role) ? node.role : null);
    const group = groups[modelRole];
    inspector.change.hidden = !modelRole;
    inspector.change.disabled = !modelRole || Boolean(changeBlocked());
    inspector.change.dataset.role = modelRole ?? '';
    setText(inspector.change, group && group[1] !== modelRole ? 'Change role model (strict bridge)' : 'Change model');
    inspector.change.title = changeBlocked() || 'Applies to the next invocation';
    setText(inspector.group, modelRole ? groupGuidance(modelRole) : '');
    setText(inspector.evidenceHeading, `Attached saved evidence${attached.length > 16 ? ` (16 of ${attached.length} shown)` : ''}`);
    reconcile(inspector.evidence, evidenceRows, attached.slice(0, 16), makeNode, updateNode);
    if (!attached.length) inspector.evidence.append(element('p', role ? 'No saved items are attached to this configured role.' : 'No related saved items in this bounded snapshot.', 'empty-detail'));
    const communications = communicationEdges().filter(edge => relatedIds.has(edge.from) || relatedIds.has(edge.to));
    reconcile(inspector.links, selectedActivityRows, communications.slice(0, 6), makeActivity, updateActivity);
    if (!communications.length) inspector.links.append(element('p', 'No recorded reports, contributions or handoffs for this selection.', 'empty-detail'));
    const focus = byId('focus-selection'); if (focus) focus.disabled = !universe || !role && !node;
  }
  function updateSelectedRows() {
    for (const [role, row] of roleRows) {
      const active = selected === `role:${role}`;
      row.root.classList.toggle('selected', active); row.pick.setAttribute('aria-pressed', String(active));
    }
    for (const cache of [nodeRows, evidenceRows]) for (const [id, row] of cache) {
      row.root.classList.toggle('selected', selected === id); row.root.setAttribute('aria-pressed', String(selected === id));
    }
  }
  function updateLists() {
    reconcile(rolesContainer, roleRows, configuredRoles.map(role => ({ ...role, id: role.role })), makeRole, updateRole);
    reconcile(nodesContainer, nodeRows, map?.nodes ?? [], makeNode, updateNode);
    const communications = communicationEdges();
    reconcile(activity, activityRows, communications.slice(0, 8), makeActivity, updateActivity);
    if (activity && !communications.length) activity.append(element('p', 'No recorded reports or handoffs in this snapshot.', 'empty-detail'));
    updateInteractions();
    setText(byId('roles-count'), controlUnavailable || unavailable ? `${configuredRoles.length} last known` : configuredRoles.length);
    setText(byId('profiles-summary'), profiles.length
      ? `${profiles.length} native expert profiles · ${configuredRoles.length} stable core role policies. Select a role to see its profile and controlling model.`
      : 'Native profile metadata unavailable. Inspect the installed agent files before choosing a native model.');
    setText(byId('nodes-count'), map?.nodes.length ?? 0);
    updateSelection(); updateSelectedRows();
  }
  function updateStatus() {
    document.body.classList.toggle('is-stale', unavailable);
    const agents = (map?.nodes ?? []).filter(node => node.kind === 'agent');
    const signed = agents.filter(node => node.source === 'signed-receipt').length;
    const reported = agents.filter(node => node.source === 'project-record').length;
    const running = agents.filter(node => node.source === 'native-activity' && !node.expired && node.state === 'running').length;
    const records = (map?.nodes.length ?? 0) - agents.length;
    const omitted = Object.values(map?.diagnostics ?? {}).reduce((sum, count) => sum + (Number.isSafeInteger(count) && count > 0 ? count : 0), 0);
    const controls = changeBlocked();
    const graphicsNotice = graphicsUnavailable ? ' · Universe graphics unavailable; use the lists and model controls.' : '';
    setText(status, (unavailable ? `Saved state unavailable${map ? '; displaying the last snapshot' : ''}. ${errorReason}`
      : `${signed} signed receipts · ${running} reported running · ${reported} reported contributions · ${records} saved work items${omitted ? ` · ${omitted} invalid or omitted items` : ''}${controls ? ` · ${controls}` : ''}`) + graphicsNotice);
    setText(byId('project-name'), value(map?.project?.name, 'NeoMind workspace'));
    setText(byId('router-status'), unavailable || controlUnavailable ? 'Routing status unavailable' : routerConfigured ? '9router configured · access not verified' : 'VS Code model routing');
    const observed = byId('observed-summary');
    if (observed) observed.setAttribute('aria-live', 'off');
    setText(observed, `${map ? `Snapshot: ${timestamp(map.observed_at)}` : 'Waiting for saved project data'} · ${unavailable || controlUnavailable || activeCount === null ? 'Active signed invocations unavailable' : `${activeCount} active signed invocations`}`);
    const empty = byId('empty-state');
    if (empty) {
      empty.hidden = !graphicsUnavailable && Boolean(map?.nodes.length);
      setText(empty, graphicsUnavailable ? 'Universe graphics are unavailable. Use the role and saved item lists to inspect policy and evidence.'
        : unavailable ? 'Saved activity is unavailable. Configured orbits do not establish execution.'
          : 'No saved agent invocations or work items yet. The planets show configured roles; their motion is decorative.');
    }
  }
  function updateMotion() {
    universe?.setMotion(motionEnabled && !focusOpen && !reduced.matches && !document.hidden && !unavailable);
    const motion = byId('motion');
    if (motion) {
      motion.disabled = graphicsUnavailable || reduced.matches;
      setText(motion, graphicsUnavailable ? 'Orbits unavailable' : reduced.matches ? 'Reduced motion' : motionEnabled ? 'Pause orbits' : 'Resume orbits');
      motion.setAttribute('aria-pressed', String(!motionEnabled));
      motion.title = graphicsUnavailable ? 'Universe graphics are unavailable; the lists remain usable.'
        : reduced.matches ? 'Your reduced-motion preference is respected.' : unavailable ? 'Motion is paused while saved state is unavailable.' : 'Planet motion is decorative; communications replay recorded events.';
    }
    const reset = byId('reset-view'); if (reset) reset.disabled = graphicsUnavailable;
  }
  function publishScene() {
    if (map) universe?.setData({ map: { ...map, stale: unavailable },
      roles: configuredRoles.map(role => ({ ...role, display_name: roleTitle(role.role) })) });
    universe?.setSelected(selected); updateMotion();
  }
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'error') {
      unavailable = true;
      errorReason = typeof message.message === 'string' ? message.message.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300) : 'Refresh and inspect project configuration.';
      updateStatus(); updateLists(); publishScene(); return;
    }
    if (message.type !== 'snapshot' || !message.map || !Array.isArray(message.map.nodes) || !Array.isArray(message.map.edges)) return;
    map = { ...message.map, nodes: message.map.nodes.filter(node => node && typeof node.id === 'string'),
      edges: message.map.edges.filter(edge => edge && typeof edge.id === 'string' && typeof edge.from === 'string' && typeof edge.to === 'string') };
    unavailable = false; errorReason = ''; controlUnavailable = Boolean(message.control_unavailable);
    activeCount = Number.isSafeInteger(message.active_count) && message.active_count >= 0 ? message.active_count : null;
    routerConfigured = message.router_configured === true;
    if (!controlUnavailable) {
      profiles = Array.isArray(message.agent_profiles) ? message.agent_profiles.filter(profile => profile &&
        typeof profile.name === 'string' && typeof profile.model_role === 'string' && Array.isArray(profile.roles)) : [];
      groups = {};
      for (const profile of profiles) for (const role of profile.roles) {
        if (typeof role !== 'string') continue;
        const current = groups[role];
        groups[role] = [current ? `${current[0]} / ${profile.name}` : profile.name, profile.model_role];
      }
    }
    if (!controlUnavailable && Array.isArray(message.roles)) configuredRoles = message.roles.filter(role => role && typeof role.role === 'string')
      .map(role => ({ ...role, models: Array.isArray(role.models) ? role.models.filter(model => typeof model === 'string') : [] }));
    nodesById = new Map(map.nodes.map(node => [node.id, node]));
    rolesById = new Map(configuredRoles.map(role => [role.role, role]));
    const valid = typeof selected === 'string' && (nodesById.has(selected) || selected.startsWith('role:') && rolesById.has(selected.slice(5)));
    if (!valid) {
      selectionNote = selected ? 'The previous selection is outside the current bounded snapshot.' : '';
      selected = rolesById.has('manager') ? 'role:manager' : configuredRoles[0] ? `role:${configuredRoles[0].role}` : map.nodes[0]?.id ?? null;
      persist();
    }
    updateStatus(); updateLists(); publishScene();
  });
  byId('refresh')?.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  byId('motion')?.addEventListener('click', () => { motionEnabled = !motionEnabled; persist(); updateMotion(); });
  byId('reset-view')?.addEventListener('click', () => universe?.resetView());
  byId('focus-selection')?.addEventListener('click', () => { if (selected) universe?.focus(selected); });
  byId('role-search')?.addEventListener('input', event => { search = event.target.value.trim().toLowerCase(); updateLists(); });
  document.addEventListener('visibilitychange', updateMotion);
  if (window.NeoMindFocusSpace?.create) focusSpace = window.NeoMindFocusSpace.create({ vscode, getTransitionOrigin() {
    const state = universe?.getState?.(), earth = state?.positions?.find(body => body.id === 'role:manager');
    const rect = byId('field')?.getBoundingClientRect?.();
    if (!earth || !rect || !state.width || !state.height) return null;
    return { x: rect.left + earth.x * rect.width / state.width, y: rect.top + earth.y * rect.height / state.height,
      radius: earth.radius * rect.width / state.width };
  }, onViewChange(view) {
    focusOpen = view === 'focus';
    updateMotion();
  } });
  reduced.addEventListener?.('change', updateMotion);
  window.addEventListener('pagehide', () => { focusSpace?.destroy(); universe?.destroy(); }, { once: true });
  updateStatus(); updateSelection(); updateMotion();
  vscode.postMessage({ type: 'refresh' });
})();
