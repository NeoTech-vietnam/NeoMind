import asyncio
import json
from pathlib import Path

import pytest
from langgraph.graph import StateGraph, START, END
from typing import TypedDict

from tools.opencode_review import Adapter, MODEL, GLM_MODEL, ROUTER_MODEL, ZAI_MODEL, LUNA_MODEL, PERMISSIONS, ReviewError, install_test_adapter


class Fake:
    def __init__(self, workspace):
        self.workspace=str(workspace.resolve()); self.calls=[]; self.outcome='succeeded'; self.response='{"verdict":"needs_changes","findings":[{"description":"fixture issue","path":"brief.md"}],"summary":"Review complete"}'
        self.wrong=None; self.fail_prompt=False; self.queued=False; self.missing_receipt=False; self.metadata={}; self.prompt_id=None
    async def request(self,method,path,body=None):
        self.calls.append((method,path,body))
        if path=='/api/session': self.metadata=body['metadata']
        session={'id':'ses_123','title':'Fixture review','agent':'build','model':dict(MODEL),'location':{'directory':self.workspace},'permissions':PERMISSIONS,'outcome':self.outcome,'metadata':self.metadata}
        if self.wrong=='session' and path.startswith('/api/session/'): session['id']='ses_bad'
        if self.wrong=='model': session['model']['id']='other'
        if self.wrong=='workspace': session['location']['directory']='/wrong'
        if self.wrong=='permissions': session['permissions']=[]
        if path=='/api/session': return {'data':session}
        if '/prompt' in path:
            self.prompt_id=body["id"]
            if self.fail_prompt: raise TimeoutError('connection lost after send')
            return {'data':{'id':self.prompt_id,'type':'user','sessionID':'ses_123'}}
        if '/wait' in path:
            if self.queued: raise TimeoutError('not idle')
            return {}
        if '/interrupt' in path: return {'interrupted':True}
        if '/message?' in path:
            user=[] if self.missing_receipt else [{'id':self.prompt_id,'type':'user'}]
            return {'data':user+[{'id':'reply','type':'assistant','agent':'build','model':MODEL,'finish':'stop','content':[{'type':'text','text':self.response}]}], 'cursor':{'next':None}}
        if path.startswith('/api/session/'): return {'data':session}
        raise AssertionError(path)


def test_glm_identity_is_exact_and_fixture_http_stays_locked(tmp_path):
    from tools.opencode_http import LoopbackTransport
    workspace = tmp_path / 'fixture'; workspace.mkdir()
    transport = Fake(workspace)
    assert Adapter(transport, workspace, tmp_path / 'glm.sqlite', model=GLM_MODEL).model == GLM_MODEL
    for bad in ({**GLM_MODEL, 'variant': 'low'}, {'providerID': 'opencode', 'id': 'glm-5.3-flash', 'variant': 'high'},
                {'providerID': 'opencode', 'id': 'glm-5.3-flash-free'}, {'providerID': 'other', 'id': GLM_MODEL['id'], 'variant': 'high'}):
        with pytest.raises(ReviewError): Adapter(transport, workspace, tmp_path / 'bad.sqlite', model=bad)
    with pytest.raises(ReviewError):
        Adapter(LoopbackTransport('http://127.0.0.1:1234', 'fixture', 'dummy'), workspace, tmp_path / 'blocked.sqlite', model=GLM_MODEL)


def test_zai_exact_identity_and_fixture_http_stays_locked(tmp_path):
    from tools.opencode_http import LoopbackTransport
    workspace = tmp_path / 'fixture'; workspace.mkdir()
    assert Adapter(Fake(workspace), workspace, tmp_path / 'zai.sqlite', model=ZAI_MODEL).model == ZAI_MODEL
    for bad in ({**ZAI_MODEL, 'id': 'glm-5.3-flashx'}, {**ZAI_MODEL, 'variant': 'low'}, {**ZAI_MODEL, 'providerID': 'openrouter'}):
        with pytest.raises(ReviewError): Adapter(Fake(workspace), workspace, tmp_path / 'bad-zai.sqlite', model=bad)
    with pytest.raises(ReviewError): Adapter(LoopbackTransport('http://127.0.0.1:1234', 'fixture', 'dummy'), workspace, tmp_path / 'blocked-zai.sqlite', model=ZAI_MODEL)


def test_luna_exact_identity_and_fixture_http_stays_locked(tmp_path):
    from tools.opencode_http import LoopbackTransport
    workspace = tmp_path / 'fixture'; workspace.mkdir()
    assert Adapter(Fake(workspace), workspace, tmp_path / 'luna.sqlite', model=LUNA_MODEL).model == LUNA_MODEL
    for bad in ({**LUNA_MODEL, 'id': 'gpt-6.1-luna'}, {**LUNA_MODEL, 'variant': 'low'}, {**LUNA_MODEL, 'providerID': 'other'}):
        with pytest.raises(ReviewError): Adapter(Fake(workspace), workspace, tmp_path / 'bad-luna.sqlite', model=bad)
    with pytest.raises(ReviewError): Adapter(LoopbackTransport('http://127.0.0.1:1234', 'fixture', 'dummy'), workspace, tmp_path / 'blocked-luna.sqlite', model=LUNA_MODEL)


@pytest.mark.asyncio
async def test_luna_session_and_response_require_exact_high_identity(tmp_path):
    import copy
    workspace = tmp_path / 'fixture'; workspace.mkdir()

    class LunaFake(Fake):
        wrong_reply = False

        async def request(self, method, path, body=None):
            result = copy.deepcopy(await super().request(method, path, body))
            if path == '/api/session' or (path.startswith('/api/session/') and all(x not in path for x in ('/prompt', '/wait', '/message?', '/interrupt'))):
                result['data']['model'] = dict(LUNA_MODEL)
            if '/message?' in path:
                for message in result['data']:
                    if message.get('type') == 'assistant':
                        message['model'] = {**LUNA_MODEL, 'variant': 'low' if self.wrong_reply else 'high'}
            return result

    assert (await Adapter(LunaFake(workspace), workspace, tmp_path / 'luna-ok.sqlite', model=LUNA_MODEL).start('luna', 'Review fixture'))['verdict'] == 'needs_changes'
    rejected = LunaFake(workspace); rejected.wrong_reply = True
    with pytest.raises(ReviewError):
        await Adapter(rejected, workspace, tmp_path / 'luna-bad.sqlite', model=LUNA_MODEL).start('bad', 'Review fixture')


def test_router_exact_identity_and_fixture_http_stays_locked(tmp_path):
    from tools.opencode_http import LoopbackTransport
    workspace = tmp_path / 'fixture'; workspace.mkdir()
    assert Adapter(Fake(workspace), workspace, tmp_path / 'router.sqlite', model=ROUTER_MODEL).model == ROUTER_MODEL
    for bad in ({**ROUTER_MODEL, 'variant': 'default'}, {**ROUTER_MODEL, 'variant': 'high'}, {**ROUTER_MODEL, 'id': 'paid/model'}, {**ROUTER_MODEL, 'providerID': 'other'}):
        with pytest.raises(ReviewError): Adapter(Fake(workspace), workspace, tmp_path / 'bad-router.sqlite', model=bad)
    with pytest.raises(ReviewError):
        Adapter(LoopbackTransport('http://127.0.0.1:1234', 'fixture', 'dummy'), workspace, tmp_path / 'blocked-router.sqlite', model=ROUTER_MODEL)


@pytest.mark.asyncio
async def test_glm_session_and_assistant_identity_pinned(tmp_path):
    import copy
    workspace = tmp_path / 'fixture'; workspace.mkdir()
    class GLMFake(Fake):
        missing_variant = False
        async def request(self, method, path, body=None):
            result = copy.deepcopy(await super().request(method, path, body))
            if path == '/api/session' or (path.startswith('/api/session/') and all(x not in path for x in ('/prompt', '/wait', '/message?', '/interrupt'))):
                result['data']['model'] = dict(GLM_MODEL)
                if self.missing_variant: result['data']['model'].pop('variant')
            if '/message?' in path:
                for message in result['data']:
                    if message.get('type') == 'assistant': message['model'] = dict(GLM_MODEL)
            return result
    transport = GLMFake(workspace)
    adapter = Adapter(transport, workspace, tmp_path / 'ok.sqlite', model=GLM_MODEL)
    assert (await adapter.start('glm', 'Review fixture'))['verdict'] == 'needs_changes'
    rejected = GLMFake(workspace); rejected.missing_variant = True
    with pytest.raises(ReviewError): await Adapter(rejected, workspace, tmp_path / 'reject.sqlite', model=GLM_MODEL).start('bad', 'Review fixture')
    assert not any(path.endswith('/prompt') for _, path, _ in rejected.calls)


@pytest.mark.asyncio
async def test_router_session_default_sentinel_never_relaxes_assistant_identity(tmp_path):
    import copy
    workspace = tmp_path / 'fixture'; workspace.mkdir()
    class RouterFake(Fake):
        session_variant = 'default'
        assistant_variant = None
        async def request(self, method, path, body=None):
            result = copy.deepcopy(await super().request(method, path, body))
            if path == '/api/session' or (path.startswith('/api/session/') and all(x not in path for x in ('/prompt', '/wait', '/message?', '/interrupt'))):
                result['data']['model'] = {**ROUTER_MODEL, 'variant': self.session_variant}
            if '/message?' in path:
                for message in result['data']:
                    if message.get('type') == 'assistant':
                        message['model'] = dict(ROUTER_MODEL)
                        if self.assistant_variant is not None: message['model']['variant'] = self.assistant_variant
            return result
    transport = RouterFake(workspace)
    assert (await Adapter(transport, workspace, tmp_path / 'ok-router.sqlite', model=ROUTER_MODEL).start('router', 'Review fixture'))['verdict'] == 'needs_changes'
    bad_session = RouterFake(workspace); bad_session.session_variant = 'high'
    with pytest.raises(ReviewError): await Adapter(bad_session, workspace, tmp_path / 'bad-session.sqlite', model=ROUTER_MODEL).start('router', 'Review fixture')
    assert not any(path.endswith('/prompt') for _, path, _ in bad_session.calls)
    bad_reply = RouterFake(workspace); bad_reply.assistant_variant = 'default'
    with pytest.raises(ReviewError): await Adapter(bad_reply, workspace, tmp_path / 'bad-reply.sqlite', model=ROUTER_MODEL).start('router', 'Review fixture')


@pytest.fixture
def fixture(tmp_path):
    workspace=tmp_path/'workspace'; workspace.mkdir(); (workspace/'source.txt').write_text('Fixture source\n')
    fake=Fake(workspace); return Adapter(fake,workspace,tmp_path/'attempts.sqlite'),fake,workspace


@pytest.mark.asyncio
async def test_success_and_receipt(fixture):
    a,f,_=fixture; result=await a.start('one','Review source.txt'); assert result['verdict']=='needs_changes'; assert result['session_id']=='ses_123'; assert a._row('one')['stage']=='completed'; assert len([c for c in f.calls if c[1].endswith('/prompt')])==1
    assert f.calls[0][2]['title']=='Fixture review'; assert f.calls[0][2]['permissions']==PERMISSIONS
    before=len(f.calls); assert await a.reconcile('one') == result; assert len(f.calls)==before


@pytest.mark.asyncio
async def test_single_json_fence_is_normalized_without_resubmit(fixture):
    a,f,_=fixture
    f.response='```json\n'+f.response+'\n```'
    assert (await a.start('one','Review fixture'))['verdict']=='needs_changes'
    assert len([call for call in f.calls if call[1].endswith('/prompt')])==1


@pytest.mark.asyncio
@pytest.mark.parametrize('response', [
    'Commentary\n```json\n{}\n```', '```json\n{}\n```\nCommentary',
    '```json\n{}\n```\n```json\n{}\n```',
    '```json\n{"verdict":"pass","findings":[{"description":"issue","path":"x"}],"summary":"bad"}\n```',
])
async def test_fence_does_not_relax_schema_or_allow_other_text(fixture,response):
    a,f,_=fixture; f.response=response
    with pytest.raises(ReviewError): await a.start('one','Review fixture')


@pytest.mark.asyncio
@pytest.mark.parametrize('wrong',['session','model','workspace','permissions'])
async def test_identity_mismatch_fails_before_prompt(fixture,wrong):
    a,f,_=fixture; f.wrong=wrong
    with pytest.raises(ReviewError): await a.start('one','review')
    assert not any(c[1].endswith('/prompt') for c in f.calls)


@pytest.mark.asyncio
@pytest.mark.parametrize('response',['not json','{}','{"verdict":"pass","findings":[{"description":"x","path":"x"}],"summary":"bad"}'])
async def test_invalid_output_never_passes(fixture,response):
    a,f,_=fixture; f.response=response
    with pytest.raises(ReviewError): await a.start('one','review')
    assert a._row('one')['stage']=='admitted'


@pytest.mark.asyncio
async def test_failed_or_queued_not_success(fixture):
    a,f,_=fixture; f.outcome='failed'
    with pytest.raises(ReviewError): await a.start('failed','review')
    f.outcome='succeeded'; f.queued=True
    with pytest.raises(TimeoutError): await a.start('queued','review')
    assert a._row('queued')['stage']=='admitted'
    f.queued=False; assert (await a.reconcile('queued'))['status']=='completed'


@pytest.mark.asyncio
async def test_disconnect_never_resubmits(fixture):
    a,f,_=fixture; f.fail_prompt=True
    with pytest.raises(TimeoutError): await a.start('one','review')
    assert a._row('one')['stage']=='prompt_intent'
    with pytest.raises(ReviewError): await a.start('one','review')
    assert (await a.reconcile('one'))['status']=='completed'
    assert len([c for c in f.calls if c[1].endswith('/prompt')])==1


@pytest.mark.asyncio
async def test_missing_receipt_and_interrupt_are_not_proof(fixture):
    a,f,_=fixture; f.missing_receipt=True
    with pytest.raises(ReviewError): await a.start('one','review')
    result=await a.interrupt('one'); assert result['interrupt_response']['interrupted'] is True and result['stopped_verified'] is False


@pytest.mark.asyncio
async def test_cancel_during_send_is_not_resubmitted(fixture):
    a,f,_=fixture
    original=f.request
    async def cancelled(method,path,body=None):
        if path.endswith('/prompt'):
            f.calls.append((method,path,body))
            raise asyncio.CancelledError()
        return await original(method,path,body)
    f.request=cancelled
    with pytest.raises(asyncio.CancelledError): await a.start('cancelled','review')
    assert a._row('cancelled')['stage']=='prompt_intent'
    with pytest.raises(ReviewError): await a.start('cancelled','review')
    assert len([c for c in f.calls if c[1].endswith('/prompt')])==1


@pytest.mark.asyncio
async def test_concurrent_same_attempt_sends_once(fixture):
    a,f,_=fixture
    values=await asyncio.gather(a.start('shared','review'),a.start('shared','review'),return_exceptions=True)
    assert sum(isinstance(v,ReviewError) for v in values)==1
    assert len([c for c in f.calls if c[1].endswith('/prompt')])==1


@pytest.mark.asyncio
async def test_real_tool_node_in_compiled_langgraph(fixture,monkeypatch):
    from core.workflows import nodes
    from tools.native_tools import load_native_tools, get_available_tool_names
    a,f,workspace=fixture; install_test_adapter(a)
    async def no_events(*args,**kwargs): pass
    monkeypatch.setattr(nodes,'_emit_node_event',no_events)
    assert 'opencode_review' in get_available_tool_names()
    assert load_native_tools(['opencode_review'])[0].name=='opencode_review'
    class State(TypedDict, total=False):
        task_id:int
        tool_result:object
        last_tool_output:str
        current_directive:str
        handoff_summary:str
        messages:list
        execution_failed:bool
    async def read(state):
        return await nodes.execute_tool_node(state,{}, {'node_id':'read','tool_type':'mcp','tool_id':'read_file','tool_params':{'file_path':str(workspace/'source.txt')}})
    async def review(state):
        return await nodes.execute_tool_node(state,{}, {'node_id':'review','tool_type':'mcp','tool_id':'opencode_review','tool_params':{'attempt_id':'graph','instruction':'{{previous_output}}'}})
    graph=StateGraph(State); graph.add_node('read',read); graph.add_node('review',review); graph.add_edge(START,'read'); graph.add_edge('read','review'); graph.add_edge('review',END)
    result=await graph.compile().ainvoke({'task_id':0}); review_result=json.loads(result['tool_result']); assert review_result['verdict']=='needs_changes'; assert 'Fixture source' in f.calls[2][2]['text']
    install_test_adapter(None)


@pytest.mark.asyncio
async def test_tool_node_disabled_adapter_reports_failure(fixture,monkeypatch):
    from core.workflows import nodes
    async def no_events(*args,**kwargs): pass
    monkeypatch.setattr(nodes,'_emit_node_event',no_events)
    install_test_adapter(None)
    result=await nodes.execute_tool_node({'task_id':0},{},{'node_id':'review','tool_type':'mcp','tool_id':'opencode_review','tool_params':{'attempt_id':'disabled','instruction':'review'}})
    assert result['execution_failed'] is True
    assert 'not enabled' in result['tool_error']
    assert 'tool_result' not in result


def test_fake_guard_counts_retries_and_concurrent_dispatches(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    from tools.fixture_request_guard import FixtureRequestGuard
    guard=FixtureRequestGuard(tmp_path/'guard.sqlite',limit=4)
    def admit(kind):
        try: return guard.admit('opencode','deepseek-v4.1-flash-free','high',kind,'http')
        except ValueError: return None
    with ThreadPoolExecutor(max_workers=8) as pool:
        results=list(pool.map(admit,['primary','retry','title','compaction','primary','retry','generate','primary']))
    assert sorted(x for x in results if x is not None)==[1,2,3,4]
    with pytest.raises(ValueError): guard.admit('opencode','deepseek-v4.1-flash','high','primary','http')
    with pytest.raises(ValueError): guard.admit('opencode','deepseek-v4.1-flash-free','high','primary','websocket')


def test_loopback_and_workspace_boundaries(tmp_path):
    from tools.opencode_http import LoopbackTransport
    for url in ('https://127.0.0.1:1234', 'http://localhost:1234', 'http://127.0.0.1:1234/other', 'http://example.com:1234'):
        with pytest.raises(ValueError): LoopbackTransport(url,'u','p')
    root=tmp_path/'root'; root.mkdir(); outside=tmp_path/'outside'; outside.mkdir(); (root/'escape').symlink_to(outside)
    with pytest.raises(ReviewError): Adapter(Fake(outside), root/'escape', tmp_path/'boundary.sqlite', fixture_root=root)
    with pytest.raises(ReviewError): Adapter(LoopbackTransport('http://127.0.0.1:1234','u','p'), root, tmp_path/'guarded.sqlite')
