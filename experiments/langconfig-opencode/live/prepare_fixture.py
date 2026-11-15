"""Create a new synthetic Git baseline for the read-only LocalRun experiment."""
import argparse
import os
import subprocess
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dest", type=Path, required=True)
    args = parser.parse_args()
    requested = args.dest.expanduser()
    checkout = Path(__file__).resolve().parents[3]
    if requested.is_symlink():
        parser.error("destination must not be a symlink")
    dest = requested.resolve()
    if dest == checkout or dest.is_relative_to(checkout) or checkout.is_relative_to(dest):
        parser.error("destination must not overlap the NeoMind checkout")
    if dest.exists() or not dest.parent.is_dir():
        parser.error("destination must be new and its parent must exist")
    dest.mkdir(mode=0o700)
    files = {
        "docs/brief.md": "Retention: 90 days. Publication requires no approval.\n",
        "source/facts.txt": "Product: Alder\nRetention: 30 days\nApproval: required before publication\n",
        "task.txt": "Read facts, repair both incorrect statements, cite the local source, review again and report.\n",
    }
    for name, content in files.items():
        target = dest / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_ALLOW_PROTOCOL": "file", "GIT_TERMINAL_PROMPT": "0"})

    def git(*arguments):
        subprocess.run(["git", "-C", str(dest), *arguments], env=env, check=True)

    git("init", "-q")
    git("add", "--", *files)
    git("-c", "user.name=NeoMind Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "test: initialize synthetic review fixture")
    print(f"Prepared synthetic baseline at {dest}; no existing checkout was modified.")


if __name__ == "__main__":
    main()
