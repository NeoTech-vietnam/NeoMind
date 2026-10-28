"""Shared helpers for the hooks: the project root, the config, the files a payload will change, the call log.

Files a hook payload is about to change, for Claude (Edit/Write/MultiEdit) and Codex (apply_patch):
Claude passes `tool_input.file_path`. Codex passes a patch whose header lines name the files:
`*** Update File: <path>`, `*** Add File: <path>`, `*** Delete File: <path>`, `*** Move to: <path>`.
Relative paths are taken from the project root.

The project root is the environment variable KB_HOOK_ROOT, else CLAUDE_PROJECT_DIR, else the folder
that holds kit.json above this script.
"""

from pathlib import Path
import os
import re
import sys

EDIT_TOOLS = ('Edit', 'Write', 'MultiEdit', 'apply_patch', 'ApplyPatch')
PATCH_FILE = re.compile(r'^\*\*\* (?:Update File|Add File|Delete File|Move to): (.+?)\s*$', re.M)
HOOKS_DIR = Path(__file__).resolve().parent
ENGINE_DIR = HOOKS_DIR.parent
for _folder in (str(ENGINE_DIR),):
    if _folder not in sys.path:
        sys.path.insert(0, _folder)

import config as kitconfig  # noqa: E402


def project_root():
    root = os.environ.get('KB_HOOK_ROOT') or os.environ.get('CLAUDE_PROJECT_DIR')
    if root:
        return Path(root)
    try:
        return kitconfig.find_project_root(HOOKS_DIR)
    except kitconfig.ConfigError:
        return ENGINE_DIR.parent


def load_config(root):
    """The merged kit.json of the project, or None when it cannot be read."""
    try:
        return kitconfig.load(root)
    except kitconfig.ConfigError:
        return None


def engine_rel(cfg):
    """The engine folder as written in kit.json paths.engine, with forward slashes."""
    return (cfg['paths_raw']['engine'] if cfg else kitconfig.DEFAULTS['paths']['engine']).replace('\\', '/').strip('/')


def kb_cli(cfg):
    """The KB command line for notes: kit.json kb.cli, else `python <engine>/kb/kb.py`."""
    given = (cfg or {}).get('kb', {}).get('cli')
    return given if isinstance(given, str) and given.strip() else f'python {engine_rel(cfg)}/kb/kb.py'


def reviewer(cfg):
    project = (cfg or {}).get('project', {})
    return project.get('reviewer') or project.get('owner') or 'the reviewer'


def project_name(cfg):
    return (cfg or {}).get('project', {}).get('name') or 'Project'


def run_logged(script, main, root):
    """Run a hook's main() on the stdin payload, pass its output through, then log the call."""
    import io
    import json
    raw = sys.stdin.read()
    sys.stdin, real, buf = io.StringIO(raw), sys.stdout, io.StringIO()
    sys.stdout = buf
    try:
        main()
    finally:
        sys.stdout = real
    text = buf.getvalue()
    if '--codex' in sys.argv[1:] and text.strip():
        # Codex treats "ask" as a failed hook and runs the tool anyway: ask becomes deny there.
        try:
            out = json.loads(text)
            spec = out.get('hookSpecificOutput', {})
            if spec.get('permissionDecision') == 'ask':
                spec['permissionDecision'] = 'deny'
                name = reviewer(load_config(root))
                follow = ('then use the KB command named above' if script.startswith('kb_')
                          else 'and leave this command to them')
                spec['permissionDecisionReason'] = ('[Codex cannot ask] ' + spec.get('permissionDecisionReason', '')
                                                    + f' Ask {name} in chat, {follow}.')
                text = json.dumps(out, ensure_ascii=False) + '\n'
        except (ValueError, AttributeError):
            pass
    real.write(text)
    real.flush()
    try:
        payload = json.loads(raw or '{}')
    except ValueError:
        return
    if isinstance(payload, dict) and payload:
        log_call(root, script, payload, bool(text.strip()))


def log_call(root, script, payload, emitted):
    """Append one line per hook call to <paths.cache>/hooks/calls.log (gitignored), so a session can
    check which events fired. Kept under 200 KB; never raises."""
    import json
    import time
    try:
        cfg = load_config(root)
        if cfg is None:
            return
        log = cfg['paths']['cache'] / 'hooks' / 'calls.log'
        log.parent.mkdir(parents=True, exist_ok=True)
        if log.exists() and log.stat().st_size > 200_000:
            log.write_text('', encoding='utf-8')
        entry = {'time': time.strftime('%Y-%m-%d %H:%M:%S'), 'script': script,
                 'client': 'codex' if '--codex' in sys.argv[1:] else 'claude',
                 'event': payload.get('hook_event_name'), 'tool': payload.get('tool_name'),
                 'session': payload.get('session_id'), 'paths': [str(p) for p in edited_paths(payload, root)],
                 'emitted': emitted}
        with log.open('a', encoding='utf-8') as f:
            f.write(json.dumps(entry, ensure_ascii=False) + '\n')
    except Exception:  # noqa: BLE001 - logging must never break a hook
        pass


def edited_paths(payload, root):
    if payload.get('tool_name') not in EDIT_TOOLS:
        return []
    tool_input = payload.get('tool_input') or {}
    if isinstance(tool_input, str):
        tool_input = {'command': tool_input}
    paths = [tool_input[k] for k in ('file_path', 'path') if isinstance(tool_input.get(k), str)]
    for value in tool_input.values():
        if isinstance(value, str) and '*** ' in value:
            paths.extend(PATCH_FILE.findall(value))
    out = []
    for p in paths:
        path = Path(p)
        out.append(path if path.is_absolute() else Path(root) / path)
    return list(dict.fromkeys(out))
