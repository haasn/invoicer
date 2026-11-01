"""Optional git integration for the data directory."""

import os
import subprocess
from pathlib import Path


class GitError(Exception):
    pass


def _git(root, *args, check=True, timeout=30):
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0")
    # Never block on an interactive ssh prompt; the server has no terminal.
    env.setdefault("GIT_SSH_COMMAND", "ssh -o BatchMode=yes")
    try:
        res = subprocess.run(["git", "-C", str(root), *args], capture_output=True,
                             text=True, timeout=timeout, env=env, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        raise GitError(f"git {args[0]} timed out") from None
    if check and res.returncode != 0:
        raise GitError((res.stderr or res.stdout).strip() or f"git {args[0]} failed")
    return res


def is_repo(root):
    res = _git(root, "rev-parse", "--show-toplevel", check=False)
    return res.returncode == 0 and Path(res.stdout.strip()).resolve() == Path(root).resolve()


def commit(root, paths, message):
    """Commit exactly `paths` (including deletions); returns False if unchanged."""
    root = Path(root)
    rel = [os.path.relpath(p, root) for p in paths]
    tracked = set(_git(root, "ls-files", "-z", "--", *rel).stdout.split("\0"))
    rel = [p for p in rel if (root / p).exists() or p in tracked]
    if not rel:
        return False
    _git(root, "add", "-A", "--", *rel)
    if _git(root, "diff", "--cached", "--quiet", "--", *rel, check=False).returncode == 0:
        return False
    _git(root, "commit", "-q", "-m", message, "--", *rel)
    return True


def status(root):
    out = {"branch": None, "ahead": 0, "behind": 0, "dirty": 0, "upstream": False}
    res = _git(root, "status", "--porcelain=v2", "--branch")
    for line in res.stdout.splitlines():
        if line.startswith("# branch.head "):
            out["branch"] = line.split(" ", 2)[2]
        elif line.startswith("# branch.upstream "):
            out["upstream"] = True
        elif line.startswith("# branch.ab "):
            ahead, behind = line.split()[2:4]
            out["ahead"], out["behind"] = int(ahead), -int(behind)
        elif not line.startswith("#"):
            out["dirty"] += 1
    return out


def sync(root):
    pull = _git(root, "pull", "--rebase", "--autostash", timeout=120)
    push = _git(root, "push", timeout=120)
    return "\n".join(s.strip() for s in (pull.stdout, pull.stderr, push.stdout, push.stderr)
                     if s.strip())
