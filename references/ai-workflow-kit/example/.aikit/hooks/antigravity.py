#!/usr/bin/env python3
"""Antigravity PreToolUse adapter for the KB guard and the action guard.

Antigravity sends `{"toolCall": {"name": ..., "args": {...}}}` and reads `{"decision", "reason"}` from stdout.
  run_command                            args.CommandLine  -> action_guard.decide_bash
  replace_file_content / write_to_file   args.TargetFile   -> kb_guard.guarded (store exports and journals,
                                                              kb.json) and action_guard.decide_edit (grant files)
Anything else, and any internal error in the KB part, is allowed. Exits 0.
"""

import json
from pathlib import Path
import sys

HOOKS_DIR = Path(__file__).resolve().parent
if str(HOOKS_DIR) not in sys.path:
    sys.path.insert(0, str(HOOKS_DIR))

import action_guard  # noqa: E402
import hook_paths  # noqa: E402
import kb_guard  # noqa: E402

EDIT_CALLS = ('replace_file_content', 'write_to_file')


def decide(payload, root):
    """(decision, reason) for an Antigravity payload; ('allow', '') when nothing objects."""
    call = payload.get('toolCall') if isinstance(payload, dict) else None
    call = call if isinstance(call, dict) else {}
    name, args = call.get('name', ''), call.get('args')
    args = args if isinstance(args, dict) else {}
    cfg = hook_paths.load_config(root)
    if name == 'run_command':
        result = action_guard.decide_bash(root, cfg, args.get('CommandLine', '') or '')
        return result or ('allow', '')
    if name in EDIT_CALLS:
        target = args.get('TargetFile', '')
        if not target:
            return ('allow', '')
        target = Path(target)
        if not target.is_absolute():
            target = Path(root) / target
        result = action_guard.decide_edit(root, cfg, [target])
        if result:
            return result
        kb = kb_guard.load_kb()
        if kb is not None:
            try:
                res = kb_guard.guarded(kb, root, target)
                if res:
                    return (res[0], f'[kb-guard] {res[1]}')
            except Exception:  # noqa: BLE001 - never block an edit because the KB is broken
                pass
    return ('allow', '')


def main():
    try:
        payload = json.loads(sys.stdin.read() or '{}')
    except ValueError:
        payload = {}
    try:
        decision, reason = decide(payload, hook_paths.project_root())
    except Exception:  # noqa: BLE001
        decision, reason = 'allow', ''
    print(json.dumps({'decision': decision, 'reason': reason}, ensure_ascii=False))


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    main()
    sys.exit(0)
