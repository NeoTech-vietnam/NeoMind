import { Plugin } from '@opencode/plugin';
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export default Plugin.define({ id: 'fixture-live-guard', async setup(ctx) {
  const o = ctx.options;
  if (!['fake', 'fake-router', 'live'].includes(o.mode) || !o.database || !o.helper || !o.python || !o.trace || !o.origin) throw new Error('fixture guard configuration invalid');
  if (o.mode === 'fake-router' && !/^http:\/\/127\.0\.0\.1:\d+$/.test(o.origin)) throw new Error('fake router must be loopback');
  const router = o.mode === 'fake-router' || (o.mode === 'live' && o.providerID === 'openrouter' && o.modelID === 'openrouter/free');
  if (o.mode === 'live' && (o.origin !== (router ? 'https://openrouter.ai' : 'https://opencode.ai') || o.testRetry === true)) throw new Error('invalid live mode');
  if (o.mode === 'live' && !router && (o.providerID !== 'opencode' || !['deepseek-v4.1-flash-free', 'glm-5.3-flash-free'].includes(o.modelID))) throw new Error('unapproved live model');
  const selected = o.mode === 'fake' ? { provider: 'fixture', model: 'fake-review' } : o.mode === 'fake-router' ? { provider: 'fixture', model: 'router-free' } : { provider: o.providerID, model: o.modelID };
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
    const variantOK = router ? model.variant === undefined : model.variant === 'high';
    const pathOK = o.mode === 'fake-router' ? target.pathname === '/v1/chat/completions' : o.mode !== 'live' || (router ? ['/api/v1/chat/completions', '/api/v1/responses'].includes(target.pathname) : target.pathname.startsWith('/inference/'));
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
