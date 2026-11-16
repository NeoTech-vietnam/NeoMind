"""Experiment joining fixture authority to NeoMind dispatch components with fake runners.

This is not a production admission service or an OS/workspace fencing mechanism.
"""
import unified_fixture as authority
import langgraph_fixture as lg


def resume(dsn, thread, binding, receipt, job, request, client, *, before_dispatch=None, after_validation=None, after_dispatch=None):
    # The caller is the trusted test host; graph input does not create this binding.
    if (type(request) is not dict or request.get('taskId') != binding['task'] or
            authority.digest(request) != binding['action_hash']):
        return {'status': 'denied'}
    response = None

    def dispatch():
        nonlocal response
        if before_dispatch:
            before_dispatch()
        # This narrows a testable revoke window; it cannot fence the following call.
        authority.revalidate_dispatched(dsn, binding, receipt, job['id'], job['owner'], job['epoch'])
        with lg.PostgresSaver.from_conn_string(dsn) as saver:
            snapshot = lg.graph(saver).get_state(lg.config(thread))
            if lg.identity(snapshot, thread, binding['task']) != binding['checkpoint']:
                raise authority.Denied('Checkpoint changed before fixture dispatch')
        if after_validation:
            after_validation()
        response = client.execute(request)
        if not response.get('ok'):
            raise RuntimeError('LocalRun outcome is not verified')
        if after_dispatch:
            after_dispatch()

    try:
        authority.resume(dsn, thread, binding, receipt, job['id'], job['owner'], job['epoch'],
                         after_effect=dispatch)
    except authority.Denied:
        # An already-dispatched job and a stale authorization are not distinguished here.
        return {'status': 'unknown'}
    except Exception:
        # Reservation, graph checkpoint and NeoMind journal are separate transactions.
        return {'status': 'unknown'}
    return {'status': 'completed', 'response': response}
