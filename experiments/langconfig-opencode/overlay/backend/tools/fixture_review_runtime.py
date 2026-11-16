"""Trusted process-only binding for fixture review tasks, never an HTTP grant."""
from contextlib import contextmanager
from threading import Lock

from tools.opencode_http import LoopbackTransport
from tools.opencode_review import Adapter, review_runtime

_lock = Lock()
_factory = None
_active_tasks = set()
_active_adapters = set()
_FIXTURE_MODEL = {"providerID": "fixture", "id": "fake-review", "variant": "high"}


@contextmanager
def install_fixture_factory(factory):
    """Install an owner-supplied policy in this process, for a bounded lifetime."""
    if not callable(factory):
        raise TypeError("fixture factory must be callable")
    global _factory
    with _lock:
        if _factory is not None or _active_tasks:
            raise RuntimeError("a fixture factory is already installed")
        _factory = factory
    try:
        yield
    finally:
        with _lock:
            active = bool(_active_tasks)
            _factory = None
            if active:
                raise RuntimeError("cannot remove a fixture factory while tasks are active")


@contextmanager
def bind_fixture_task(task_id, workflow_id, project_id):
    """Bind only a trusted policy's fixture adapter to one background task."""
    with _lock:
        factory = _factory
        if factory is None and _active_tasks:
            raise RuntimeError("fixture factory is shutting down")
        if factory is not None:
            if type(task_id) is not int or task_id < 1 or type(workflow_id) is not int or workflow_id < 1:
                raise ValueError("invalid task identity")
            if project_id is not None and (type(project_id) is not int or project_id < 1):
                raise ValueError("invalid project identity")
            if task_id in _active_tasks:
                raise RuntimeError("fixture review task is already active")
            _active_tasks.add(task_id)
    if factory is None:
        # Background tasks must not inherit authority from their caller's context.
        with review_runtime(None):
            yield
        return
    adapter = None
    adapter_claimed = False
    try:
        # This callback is installed by trusted process code, never by a workflow or HTTP request.
        adapter = factory(task_id, workflow_id, project_id)
        if adapter is not None:
            if (not isinstance(adapter, Adapter) or type(adapter.transport) is not LoopbackTransport
                    or adapter.model != _FIXTURE_MODEL):
                raise ValueError("policy must return a fixture-only loopback adapter")
            with _lock:
                if id(adapter) in _active_adapters:
                    raise RuntimeError("fixture adapter is already active")
                _active_adapters.add(id(adapter))
                adapter_claimed = True
        with review_runtime(adapter):
            yield
    finally:
        with _lock:
            if adapter_claimed:
                _active_adapters.remove(id(adapter))
            _active_tasks.remove(task_id)
