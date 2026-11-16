"""Create a new synthetic Git fixture; never modify an existing directory."""
import argparse
import os
from pathlib import Path
import subprocess


FILES = {
    'source/facts.txt': 'Product: Alder\nRetention: 30 days\nApproval: required before publication\n',
    'docs/brief.md': 'Retention: 90 days. Publication requires no approval.\n',
    'task.txt': 'Read facts, repair both incorrect statements, cite the local source, review again and report.\n',
}


def create(destination):
    destination = Path(destination).absolute()
    destination.mkdir(mode=0o700)
    for name, content in FILES.items():
        file = destination / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(content, encoding='utf-8')
    env = {key: value for key, value in os.environ.items() if not key.upper().startswith('GIT_')}
    env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
               GIT_AUTHOR_NAME='Fixture', GIT_AUTHOR_EMAIL='fixture@example.invalid',
               GIT_COMMITTER_NAME='Fixture', GIT_COMMITTER_EMAIL='fixture@example.invalid',
               GIT_TERMINAL_PROMPT='0')
    def git(*args):
        subprocess.run(['git', '-C', str(destination), '-c', f'core.hooksPath={os.devnull}',
                        '-c', 'commit.gpgsign=false', *args], env=env, check=True, capture_output=True)
    git('init')
    git('add', '--', *FILES)
    git('commit', '-m', 'Synthetic fixture')
    return destination


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dest', required=True, help='New directory; parent must already exist')
    print(create(parser.parse_args().dest))
