"""Create a fresh pinned upstream clone and install this experiment's overlay."""
import argparse
import shutil
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent.resolve()
COMMIT = "eb786cf8efe0b6cc9e45d07362e66da6ec465424"
UPSTREAM = "https://github.com/LangConfig/langconfig.git"
OVERLAY = (
    "backend/tools/fixture_request_guard.py",
    "backend/tools/opencode_http.py",
    "backend/tools/opencode_review.py",
    "backend/tools/fixture_review_runtime.py",
    "backend/core/workflows/safe_condition.py",
    "tests/prototype/test_opencode_review.py",
    "tests/prototype/test_tool_failure.py",
    "tests/prototype/test_task_failure.py",
    "tests/prototype/test_approval_safety.py",
    "tests/prototype/test_http_review_flow.py",
    "tests/prototype/test_review_repair_flow.py",
    "tests/prototype/test_safe_condition.py",
    "tests/prototype/test_fixture_review_runtime.py",
)


def run(*args, cwd=None):
    subprocess.run(args, cwd=cwd, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dest", type=Path, required=True, help="new path outside the NeoMind checkout")
    parser.add_argument("--source", default=UPSTREAM, help="upstream URL or local Git repository")
    args = parser.parse_args()
    requested = args.dest.expanduser()
    if requested.is_symlink():
        parser.error("destination must not be a symlink")
    dest = requested.resolve()
    if dest == REPO or dest.is_relative_to(REPO) or REPO.is_relative_to(dest):
        parser.error("destination must not overlap the NeoMind checkout")
    if dest.exists() or dest.is_symlink():
        parser.error("destination already exists; choose a new path")
    if not dest.parent.is_dir():
        parser.error("destination parent must already exist")
    run("git", "clone", "--no-checkout", "--", args.source, str(dest))
    run("git", "switch", "--detach", COMMIT, cwd=dest)
    actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=dest, text=True).strip()
    if actual != COMMIT:
        raise RuntimeError("upstream revision mismatch")
    run("git", "apply", "--check", str(HERE / "registration.patch"), cwd=dest)
    run("git", "apply", str(HERE / "registration.patch"), cwd=dest)
    for relative in OVERLAY:
        source = HERE / "overlay" / relative
        target = dest / relative
        if target.exists() or target.is_symlink():
            raise RuntimeError(f"overlay collision: {target}")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    print(f"Prepared {dest} at {COMMIT}")


if __name__ == "__main__":
    main()
