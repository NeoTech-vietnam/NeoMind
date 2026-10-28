"""Keep the Claude and Codex agents the same: `.claude/agents/<name>.md` is the source.

  python sync_agents.py --check   exit 1 and list every difference
  python sync_agents.py --write   set each Claude agent's model from the tiers and regenerate
                                  `.codex/agents/<name>.toml` (name, description, model,
                                  model_reasoning_effort, developer_instructions)

The only change to the instructions is `CLAUDE.md` -> `AGENTS.md` (the Codex entrypoint). The Claude `tools:` line
is not touched. The model of each agent comes from kit.json `agents`: `tiers` (name -> claude, codex,
codex_effort) and `assign` (agent -> tier). When `agents.tiers_file` names a JSON file (project-relative), the tiers
come from its keys `tiers` and `agents` instead.

Codex custom agents have no read-only setting (the Codex docs say `sandbox_mode` in an agent file does not
override the parent session), so nothing about tools or sandbox is written to the TOML.

Root: `--root`, else the folder that holds kit.json above this script.
"""

import argparse
import json
from pathlib import Path
import re
import sys

ENGINE_DIR = Path(__file__).resolve().parents[1]
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))

import config as kitconfig  # noqa: E402

try:
    import tomllib
except ImportError:  # Python 3.10: compare the generated text instead of parsed TOML
    tomllib = None

CLAUDE_DIR = '.claude/agents'
CODEX_DIR = '.codex/agents'
FRONT = re.compile(r'^---\n(.*?)\n---\n(.*)$', re.S)


class SyncError(ValueError):
    pass


def default_root():
    try:
        return kitconfig.find_project_root(Path(__file__).resolve().parent)
    except kitconfig.ConfigError as e:
        raise SyncError(str(e)) from e


def read_claude(path):
    text = path.read_text(encoding='utf-8').replace('\r\n', '\n')
    m = FRONT.match(text)
    if not m:
        raise SyncError(f'{path.name}: no frontmatter')
    front = {}
    for line in m.group(1).splitlines():
        key, _, value = line.partition(':')
        if key.strip():
            front[key.strip()] = value.strip()
    if front.get('name') != path.stem or not front.get('description'):
        raise SyncError(f'{path.name}: name must equal the file name and description must be set')
    return text, front, m.group(2).strip()


def codex_instructions(body):
    return body.replace('CLAUDE.md', 'AGENTS.md')


def toml_string(value):
    return json.dumps(value, ensure_ascii=False)


def toml_block(value):
    if "'''" not in value and not value.endswith("'"):
        return "'''\n" + value + "'''"  # Literal: backslashes and quotes stay as written.
    return '"""\n' + value.replace('\\', '\\\\').replace('"""', '\\"""') + '"""'


def codex_text(front, body, tier):
    return (f'name = {toml_string(front["name"])}\n'
            f'description = {toml_string(front["description"])}\n'
            f'model = {toml_string(tier["codex"])}\n'
            f'model_reasoning_effort = {toml_string(tier["codex_effort"])}\n'
            f'developer_instructions = {toml_block(codex_instructions(body) + chr(10))}\n')


def read_tiers(root):
    """(tiers, assigned) from kit.json agents, or from the file in agents.tiers_file."""
    try:
        cfg = kitconfig.load(root)
    except kitconfig.ConfigError as e:
        raise SyncError(str(e)) from e
    agents = cfg['agents']
    given = agents.get('tiers_file')
    if given:
        path = Path(root) / given
        try:
            data = json.loads(path.read_text(encoding='utf-8-sig'))
            return data['tiers'], data['agents']
        except (OSError, ValueError, KeyError, TypeError) as e:
            raise SyncError(f'agents.tiers_file {given}: {e}') from e
    return agents['tiers'], agents['assign']


def same_toml(current_text, wanted_text):
    if current_text is None:
        return False
    if tomllib is None:
        return current_text == wanted_text
    try:
        return tomllib.loads(current_text) == tomllib.loads(wanted_text)
    except tomllib.TOMLDecodeError:
        return False


def plan(root):
    """Return (changes, problems): files to write and differences that cannot be fixed by --write."""
    root = Path(root)
    tiers, assigned = read_tiers(root)
    # Codex copies only when kit.json enables the Codex harness.
    use_codex = kitconfig.load(root).get('harnesses', {}).get('codex', True)
    changes, problems = {}, []
    sources = sorted(p for p in (root / CLAUDE_DIR).glob('*.md'))
    names = {p.stem for p in sources}
    for name in sorted(set(assigned) - names):
        problems.append(f'{name}: assigned a tier but has no {CLAUDE_DIR}/{name}.md')
    for path in sources:
        text, front, body = read_claude(path)
        tier_name = assigned.get(path.stem)
        if tier_name not in tiers:
            problems.append(f'{path.stem}: no tier assigned')
            continue
        tier = tiers[tier_name]
        if front.get('model') != tier['claude']:
            fixed = re.sub(r'(?m)^model:.*$', f'model: {tier["claude"]}', text, count=1) if 'model' in front \
                else text.replace('\n---\n', f'\nmodel: {tier["claude"]}\n---\n', 1)
            changes[path] = fixed
        if not use_codex:
            continue
        target = root / CODEX_DIR / f'{path.stem}.toml'
        wanted = codex_text(front, body, tier)
        current = target.read_text(encoding='utf-8') if target.exists() else None
        if not same_toml(current, wanted):
            changes[target] = wanted
    for orphan in sorted((root / CODEX_DIR).glob('*.toml')):
        if orphan.stem not in names:
            problems.append(f'{orphan.name}: Codex agent with no Claude source')
    return changes, problems


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check', action='store_true')
    mode.add_argument('--write', action='store_true')
    parser.add_argument('--root', type=Path, default=None, help='project root (default: the folder holding kit.json)')
    args = parser.parse_args(argv)
    try:
        root = args.root or default_root()
        changes, problems = plan(root)
    except SyncError as e:
        print(json.dumps({'ok': False, 'problems': [str(e)]}, ensure_ascii=False, indent=2))
        return 2
    if args.write:
        for path, text in changes.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(text.encode('utf-8'))
    report = {'ok': not problems and (args.write or not changes), 'problems': problems,
              'changed' if args.write else 'out_of_sync': [p.relative_to(root).as_posix() for p in changes]}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    sys.exit(main())
