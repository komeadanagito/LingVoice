"""Shared cross-process GPU lease. OS releases it even after a crashed process.
Dependencies and model objects are NOT shared between plugin environments.
"""
from contextlib import contextmanager
from pathlib import Path
import os

ROOT = Path(__file__).resolve().parent

@contextmanager
def gpu_lease():
    state = ROOT / '.state'
    state.mkdir(exist_ok=True)
    with (state / 'gpu.lock').open('a+b') as handle:
        handle.seek(0,2)
        if handle.tell()==0:
            handle.write(b'0')
            handle.flush()
        handle.seek(0)
        try:
            if os.name=='nt':
                import msvcrt
                msvcrt.locking(handle.fileno(),msvcrt.LK_NBLCK,1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
        except OSError as exc:
            raise RuntimeError('Another local plugin owns the GPU lease. Stop its process before loading this model.') from exc
        try:
            yield
        finally:
            handle.seek(0)
            if os.name=='nt':
                import msvcrt
                msvcrt.locking(handle.fileno(),msvcrt.LK_UNLCK,1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(),fcntl.LOCK_UN)
