"""Filesystem helpers: atomic writes, JSON files and advisory locks."""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import uuid


class LockBusy(RuntimeError):
    pass


def atomic_write(path, data, mode=None):
    """Replace a file in one step, keeping its permissions unless `mode` is given."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f'.{path.name}.{uuid.uuid4().hex}.tmp')
    try:
        with open(temporary, 'wb') as handle:
            handle.write(data if isinstance(data, bytes) else data.encode())
            handle.flush()
            os.fsync(handle.fileno())
        if mode is not None:
            os.chmod(temporary, mode)
        elif path.exists():
            os.chmod(temporary, path.stat().st_mode & 0o7777)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def read_bytes(path):
    """File contents, or None when the file does not exist."""
    try:
        return Path(path).read_bytes()
    except FileNotFoundError:
        return None


def write_or_delete(path, data):
    if data is None:
        Path(path).unlink(missing_ok=True)
    else:
        atomic_write(path, data)


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (FileNotFoundError, ValueError):
        return default


def write_json(path, value, mode=None):
    atomic_write(path, json.dumps(value, ensure_ascii=False, indent=2) + '\n', mode)


@contextmanager
def locked(path, blocking=True):
    """Hold an exclusive advisory lock on `path` for the duration of the block."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'a') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        except BlockingIOError:
            raise LockBusy(str(path)) from None
        yield handle
