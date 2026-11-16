import { Plugin } from '@opencode/plugin';
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export default Plugin.define({ id: 'fixture-live-guard', async setup(ctx) {
  const o = ctx.options;
  if (!['fake', 'fake-router', 'fake-zai', 'fake-luna', 'probe-luna', 'live'].includes(o.mode) || !o.database || !o.helper || !o.python || !o.trace || !o.origin) throw new Error('fixture guard configuration invalid');
  if (['fake-router', 'fake-zai', 'fake-luna'].includes(o.mode) && !/^http:\/\/127\.0\.0\.1:\d+$/.test(o.origin)) throw new Error('fake provider must be loopback');
  if (o.mode === 'probe-luna' && (o.providerID !== 'openai' || o.modelID !== 'gpt-6-luna' || o.origin !== 'https://chatgpt.com')) throw new Error('invalid Luna probe');
  const router = o.mode === 'fake-router' || (o.mode === 'live' && o.providerID === 'openrouter' && o.modelID === 'openrouter/free');
  const zai = o.mode === 'fake-zai' || (o.mode === 'live' && o.providerID === 'zai' && o.modelID === 'glm-5.3-flash');
  const luna = o.mode === 'fake-luna' || (o.mode === 'live' && o.providerID === 'openai' && o.modelID === 'gpt-6-luna');
  if (o.mode === 'live' && (o.origin !== (router ? 'https://openrouter.ai' : zai ? 'https://api.z.ai' : luna ? 'https://chatgpt.com' : 'https://opencode.ai') || o.testRetry === true)) throw new Error('invalid live mode');
  if (o.mode === 'live' && !router && !zai && !luna && (o.providerID !== 'opencode' || !['deepseek-v4.1-flash-free', 'glm-5.3-flash-free'].includes(o.modelID))) throw new Error('unapproved live model');
  const selected = ['fake', 'fake-zai', 'fake-luna'].includes(o.mode) ? { provider: 'fixture', model: 'fake-review' } : o.mode === 'fake-router' ? { provider: 'fixture', model: 'router-free' } : { provider: o.providerID, model: o.modelID };
  const log = (event, fields = {}) => appendFileSync(o.trace, JSON.stringify({ event, ...fields }) + '\n');
  await ctx.model.transform(editor => {
    for (const model of editor.list()) if (model.providerID !== selected.provider || model.id !== selected.model) editor.remove(model.providerID, model.id);
    editor.default.set(selected.provider, selected.model);
  });
  if (router) await ctx.session.hook('experimental.model.resolve', e => {
    if (e.model?.providerID === selected.provider && e.model?.id === selected.model && (e.model.variant === undefined || e.model.variant === 'default')) {
      e.model = { providerID: selected.provider, id: selected.model };
      log('router-default-normalized');
    }
  });
  await ctx.session.hook('context', e => {
    const sources = e.system.flatMap(part => part.metadata?.experimental?.instructions || []).map(source => source.key);
    log('instruction-sources', { sources });
    if (sources.length !== 2 || sources[0] !== 'core/date' || sources[1] !== 'core/environment') throw new Error('Unexpected fixture instruction source');
    e.system.splice(0, e.system.length, { type: 'text', text: 'Review only the synthetic fixture provided by the user. Return the requested JSON. Do not use tools.' });
    for (const key of Object.keys(e.tools)) delete e.tools[key];
  });
  await ctx.session.hook('title', e => { e.result = 'Fixture review'; log('title'); });
  await ctx.session.hook('compaction', e => { e.result = { summary: 'Synthetic fixture compaction.' }; log('compaction'); });
  await ctx.session.hook('retry', e => {
    e.decision = o.testRetry === true && e.attempt === 2 ? { retry: true, delay: 1 } : { retry: false };
    log('retry', { attempt: e.attempt, allowed: e.decision.retry });
  });
  for (const hook of ['experimental.ws.handshake', 'experimental.ws.send']) {
    await ctx.session.hook(hook, () => { log('websocket-deny', { hook }); throw new Error('Fixture websocket denied'); });
  }
  await ctx.session.hook('http.request', async e => {
    const id = randomUUID();
    const model = e.model || {};
    const target = new URL(e.request.url);
    if (o.mode === 'probe-luna') {
      let body;
      try { body = JSON.parse(await e.request.clone().text()); } catch { body = null; }
      log('luna-probe-denied', { origin: target.origin, path: target.pathname, method: e.request.method, kind: e.kind,
        provider: model.providerID, model: model.id, variant: model.variant, contentEncoding: e.request.headers.get('content-encoding'),
        keys: body && typeof body === 'object' ? Object.keys(body) : [], bodyModel: body?.model,
        maxOutputTokens: body?.max_output_tokens, reasoningEffort: body?.reasoning?.effort, toolCount: Array.isArray(body?.tools) ? body.tools.length : null });
      throw new Error('Luna offline probe never dispatches');
    }
    const variantOK = router ? model.variant === undefined : model.variant === 'high';
    const pathOK = o.mode === 'fake-luna' ? target.pathname === '/v1/responses' : ['fake-router', 'fake-zai'].includes(o.mode) ? target.pathname === '/v1/chat/completions' : o.mode !== 'live' || (router ? ['/api/v1/chat/completions', '/api/v1/responses'].includes(target.pathname) : zai ? target.pathname === '/api/paas/v4/chat/completions' : luna ? target.pathname === '/backend-api/codex/responses' : target.pathname.startsWith('/inference/'));
    if (model.providerID !== selected.provider || model.id !== selected.model || !variantOK || e.kind !== 'primary' || target.origin !== o.origin || !pathOK) {
      log('deny', { id, kind: e.kind, provider: model.providerID, model: model.id, variant: model.variant });
      throw new Error('Fixture dispatch denied');
    }
    if (router) {
      let body;
      try {
        const raw = await e.request.clone().text();
        if (raw.length > 1000000) throw new Error('oversized request');
        body = JSON.parse(raw);
      } catch { throw new Error('unreadable router request'); }
      const provider = body?.provider, price = provider?.max_price;
      if (body?.model !== 'openrouter/free' || body.models !== undefined || body.plugins !== undefined || body.tools !== undefined || body.web_search_options !== undefined ||
          !provider || Object.keys(provider).sort().join(',') !== 'allow_fallbacks,max_price' || provider.allow_fallbacks !== false ||
          !price || Object.keys(price).sort().join(',') !== 'completion,prompt' || price.prompt !== 0 || price.completion !== 0) throw new Error('unsafe router request');
    }
    if (zai) {
      const raw = await e.request.clone().text();
      if (raw.length > 20000 || e.request.method !== 'POST' || target.search) throw new Error('invalid Zai request');
      const body = JSON.parse(raw);
      log('paid-request-shape', { keys: Object.keys(body), model: body.model, maxTokens: body.max_tokens, maxCompletionTokens: body.max_completion_tokens, reasoningEffort: body.reasoning_effort, thinkingType: body.thinking?.type });
      if (body.model !== 'glm-5.3-flash' || !Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 8192 ||
          (body.max_completion_tokens !== undefined && (!Number.isInteger(body.max_completion_tokens) || body.max_completion_tokens < 1 || body.max_completion_tokens > 8192)) ||
          body.reasoning_effort !== 'high' || body.thinking?.type !== 'enabled' ||
          ['models', 'provider', 'plugins', 'tools', 'web_search_options', 'search_parameters'].some(key => body[key] !== undefined)) throw new Error('unsafe Zai request');
      if (!Array.isArray(body.messages) || body.messages.some(message => !['system', 'user'].includes(message.role) || typeof message.content !== 'string')) throw new Error('unsupported Zai content');
      log('paid-request-checked', { maxTokens: body.max_tokens, reasoningEffort: body.reasoning_effort });
    }
    if (luna) {
      const raw = await e.request.clone().text();
      if (raw.length > 1000000 || e.request.method !== 'POST' || target.search || e.request.headers.has('content-encoding')) throw new Error('invalid Luna request');
      let body;
      try { body = JSON.parse(raw); } catch { throw new Error('unreadable Luna request'); }
      if (body.model !== 'gpt-6-luna' || !Number.isInteger(body.max_output_tokens) || body.max_output_tokens < 1 || body.max_output_tokens > 8192 ||
          body.reasoning?.effort !== 'high' || (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length !== 0)) ||
          ['models', 'provider', 'plugins', 'max_tokens', 'max_completion_tokens', 'web_search_options'].some(key => body[key] !== undefined)) throw new Error('unsafe Luna request');
      log('luna-request-checked', { maxOutputTokens: body.max_output_tokens, reasoningEffort: body.reasoning.effort });
    }
    e.request = new Request(e.request, { redirect: 'error' });
    try {
      execFileSync(o.python, [o.helper, 'reserve', o.database, e.sessionID, id], { timeout: 5000, stdio: 'ignore', env: { PATH: '/usr/bin:/bin', HOME: o.home, TMPDIR: o.tmp } });
    } catch {
      log('reserve-deny', { id, sessionID: e.sessionID });
      throw new Error('Fixture quota unavailable');
    }
    log('reserved', { id, sessionID: e.sessionID, kind: e.kind, provider: model.providerID, model: model.id, variant: model.variant });
  });
  log('ready');
}});
