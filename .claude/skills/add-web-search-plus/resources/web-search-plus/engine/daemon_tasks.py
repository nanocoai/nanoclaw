"""Future-like tasks on daemon threads that never block interpreter exit.

``concurrent.futures`` registers an atexit hook that joins every worker
thread, so even after ``ThreadPoolExecutor.shutdown(wait=False)`` a hung
provider call keeps the *process* alive until the worker finishes. The
budget-bounded caller returns on time, but a CLI/subprocess invocation then
stalls at exit — exactly the path web-search-plus uses for its subprocess
fallback. Daemon threads are abandoned at interpreter shutdown instead, so
the time budget bounds both the function return and the process lifetime.
"""

from __future__ import annotations

import threading
from concurrent.futures import TimeoutError as FuturesTimeoutError
from typing import Any, Callable, Optional


class DaemonTask:
    """Run a callable on a daemon thread with a Future-like ``result(timeout)``."""

    def __init__(self, fn: Callable[..., Any], *args: Any, **kwargs: Any):
        self._done = threading.Event()
        self._result: Any = None
        self._exc: Optional[BaseException] = None
        self._thread = threading.Thread(
            target=self._run,
            args=(fn, args, kwargs),
            daemon=True,
            name="wsp-daemon-task",
        )
        self._thread.start()

    def _run(self, fn: Callable[..., Any], args: tuple, kwargs: dict) -> None:
        try:
            self._result = fn(*args, **kwargs)
        except BaseException as exc:  # re-raised to result() callers
            self._exc = exc
        finally:
            self._done.set()

    def done(self) -> bool:
        return self._done.is_set()

    def result(self, timeout: Optional[float] = None) -> Any:
        """Return the callable's result, raising FuturesTimeoutError on timeout.

        A timeout abandons the task: the daemon thread keeps running in the
        background (bounded by per-request HTTP timeouts) but neither blocks
        the caller nor interpreter shutdown.
        """
        if not self._done.wait(timeout):
            raise FuturesTimeoutError("daemon task did not finish in time")
        if self._exc is not None:
            raise self._exc
        return self._result
