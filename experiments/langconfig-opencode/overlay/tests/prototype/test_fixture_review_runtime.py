import asyncio
import pytest

from tools.fixture_review_runtime import bind_fixture_task, install_fixture_factory
from tools.opencode_http import LoopbackTransport
from tools.opencode_review import Adapter, MODEL, ReviewError, _review, review_runtime


def fixture_adapter(tmp_path):
    workspace = tmp_path / 'workspace'
    workspace.mkdir()
    return Adapter(LoopbackTransport('http://127.0.0.1:1234', 'fixture', 'dummy'), workspace,
                   tmp_path / 'attempts.sqlite', model={'providerID': 'fixture', 'id': 'fake-review', 'variant': 'high'})


@pytest.mark.asyncio
async def test_no_policy_and_denied_task_do_not_inherit_review_authority(tmp_path):
    with install_fixture_factory(lambda task_id, workflow_id, project_id: None):
        with bind_fixture_task(1, 2, None):
            with pytest.raises(ReviewError, match='unavailable'):
                await _review('attempt', 'Synthetic')


@pytest.mark.asyncio
async def test_no_policy_masks_and_restores_inherited_context(tmp_path):
    adapter = fixture_adapter(tmp_path)

    async def start(attempt_id, instruction):
        return {'owner': 'outer'}

    adapter.start = start
    with review_runtime(adapter):
        with bind_fixture_task(1, 2, None):
            with pytest.raises(ReviewError, match='unavailable'):
                await _review('attempt', 'Synthetic')
        assert '"owner": "outer"' in await _review('attempt', 'Synthetic')


@pytest.mark.asyncio
async def test_child_task_cannot_start_review_after_binding_exits(tmp_path):
    adapter = fixture_adapter(tmp_path)
    ready = asyncio.Event()
    release = asyncio.Event()
    dispatched = []

    async def start(attempt_id, instruction):
        dispatched.append(attempt_id)
        return {'owner': 'child'}

    adapter.start = start

    async def child():
        ready.set()
        await release.wait()
        return await _review('attempt', 'Synthetic')

    with install_fixture_factory(lambda *_args: adapter):
        with bind_fixture_task(1, 2, None):
            task = asyncio.create_task(child())
            await ready.wait()
        release.set()
        with pytest.raises(ReviewError, match='unavailable'):
            await task
    assert dispatched == []


def test_policy_accepts_only_a_fixture_adapter_and_cannot_overlap(tmp_path):
    adapter = fixture_adapter(tmp_path)
    with install_fixture_factory(lambda task_id, workflow_id, project_id: adapter):
        with pytest.raises(RuntimeError, match='already installed'):
            with install_fixture_factory(lambda *_args: None):
                pass
        with bind_fixture_task(1, 2, None):
            with pytest.raises(RuntimeError, match='task is already active'):
                with bind_fixture_task(1, 2, None):
                    pass
            with pytest.raises(RuntimeError, match='adapter is already active'):
                with bind_fixture_task(2, 2, None):
                    pass
        with bind_fixture_task(1, 2, None):
            pass


def test_policy_rejects_nonfixture_adapter_and_invalid_identity(tmp_path):
    workspace = tmp_path / 'workspace'; workspace.mkdir()
    class FakeTransport:
        pass
    live = Adapter(FakeTransport(), workspace, tmp_path / 'attempts.sqlite', model=MODEL)
    with install_fixture_factory(lambda *_args: live):
        with pytest.raises(ValueError, match='fixture-only'):
            with bind_fixture_task(1, 2, None):
                pass
        with pytest.raises(ValueError, match='identity'):
            with bind_fixture_task(True, 2, None):
                pass
        with pytest.raises(ValueError, match='project identity'):
            with bind_fixture_task(1, 2, True):
                pass


@pytest.mark.asyncio
async def test_removing_policy_while_active_closes_new_admissions(tmp_path):
    adapter = fixture_adapter(tmp_path)
    policy = install_fixture_factory(lambda *_args: adapter)
    policy.__enter__()
    binding = bind_fixture_task(1, 2, None)
    binding.__enter__()
    try:
        with pytest.raises(RuntimeError, match='tasks are active'):
            policy.__exit__(None, None, None)
        with pytest.raises(RuntimeError, match='already installed'):
            with install_fixture_factory(lambda *_args: adapter):
                pass
        with pytest.raises(RuntimeError, match='shutting down'):
            with bind_fixture_task(2, 2, None):
                pass
    finally:
        binding.__exit__(None, None, None)
    with install_fixture_factory(lambda *_args: None):
        with bind_fixture_task(2, 2, None):
            with pytest.raises(ReviewError, match='unavailable'):
                await _review('another', 'Synthetic')


@pytest.mark.asyncio
async def test_concurrent_tasks_keep_separate_adapter_contexts(tmp_path):
    first_dir = tmp_path / 'first'; first_dir.mkdir()
    second_dir = tmp_path / 'second'; second_dir.mkdir()
    first = fixture_adapter(first_dir)
    second = fixture_adapter(second_dir)
    ready = asyncio.Event()
    entered = []

    async def result_first(attempt_id, instruction):
        return {'owner': 'first', 'attempt': attempt_id}

    async def result_second(attempt_id, instruction):
        return {'owner': 'second', 'attempt': attempt_id}

    first.start = result_first
    second.start = result_second

    async def task(task_id):
        with bind_fixture_task(task_id, 2, None):
            entered.append(task_id)
            if len(entered) == 2:
                ready.set()
            await asyncio.wait_for(ready.wait(), 2)
            return await _review('attempt', 'Synthetic')

    with install_fixture_factory(lambda task_id, workflow_id, project_id: {1: first, 2: second}.get(task_id)):
        first_result, second_result = await asyncio.gather(task(1), task(2))
    assert '"owner": "first"' in first_result
    assert '"owner": "second"' in second_result


def test_factory_failure_releases_task_without_installing_adapter():
    calls = []

    def fail(*_args):
        calls.append('called')
        raise ValueError('policy failed before dispatch')

    with install_fixture_factory(fail):
        for _ in range(2):
            with pytest.raises(ValueError, match='before dispatch'):
                with bind_fixture_task(1, 2, None):
                    pass
    assert len(calls) == 2
