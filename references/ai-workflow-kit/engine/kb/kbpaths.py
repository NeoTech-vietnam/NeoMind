"""Where the KB keeps its files, from the project config (kit.json).

Every path the KB writes or reads is relative to the project root and comes from here:
kb.json and the snapshots live in `paths.kb`; read-only copies in `<kb>/<kb.copies_dir>`;
store journals in `<kb>/<kb.store_dir>`; the derived index and parse cache in `paths.cache`.
"""

import sys
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]
if str(ENGINE) not in sys.path:
    sys.path.insert(0, str(ENGINE))

import config as kitconfig  # noqa: E402

_LOADED = {}


def kit(root):
    """The merged kit.json of the project at root (cached per root)."""
    key = str(Path(root).absolute())
    if key not in _LOADED:
        _LOADED[key] = kitconfig.load(root)
    return _LOADED[key]


def forget(root=None):
    """Drop the cached config (tests that rewrite kit.json)."""
    if root is None:
        _LOADED.clear()
    else:
        _LOADED.pop(str(Path(root).absolute()), None)


def kbcfg(root):
    return kit(root)['kb']


def _rel(root, key):
    return kit(root)['paths_raw'][key].replace('\\', '/').rstrip('/')


def kb_dir(root):
    return _rel(root, 'kb')


def registry(root):
    return f'{kb_dir(root)}/kb.json'


def copies_dir(root):
    return f'{kb_dir(root)}/{kbcfg(root).get("copies_dir") or "copies"}'


def store_dir(root):
    return f'{kb_dir(root)}/{kbcfg(root).get("store_dir") or "store"}'


def snapshots_dir(root):
    return f'{kb_dir(root)}/.snapshots'


def cache_dir(root):
    return _rel(root, 'cache')


def scopes(root):
    return tuple(kbcfg(root).get('scopes') or ('project',))


def reviewer(root):
    return kit(root)['project'].get('reviewer') or kit(root)['project'].get('owner') or 'the reviewer'


def ui_lang(root):
    return kit(root)['project'].get('ui_lang', 'en')


def default_root():
    """The project that holds this engine (.aikit inside it), else the one around the working folder."""
    try:
        return kitconfig.find_project_root(Path(__file__).resolve().parent)
    except kitconfig.ConfigError:
        return kitconfig.find_project_root(Path.cwd())
