"""Run argv[1:] with macOS responsibility disclaimed, then mirror its exit.

posix_spawn + responsibility_spawnattrs_setdisclaim makes the child its own
"responsible process" for TCC, instead of inheriting the terminal or IDE that
started us. stdio is inherited. Used by src/native.mjs; run with `python3 -I`.
"""
import ctypes
import os
import signal
import sys

libc = ctypes.CDLL(None, use_errno=True)
attr = ctypes.c_void_p()
pid = ctypes.c_int()
if libc.posix_spawnattr_init(ctypes.byref(attr)) != 0 or libc.responsibility_spawnattrs_setdisclaim(ctypes.byref(attr), 1) != 0:
    sys.exit("spawn-disclaimed: could not set up spawn attributes")
args = sys.argv[1:]
argv = (ctypes.c_char_p * (len(args) + 1))(*[a.encode() for a in args], None)
env = [f"{k}={v}".encode() for k, v in os.environ.items()]
envp = (ctypes.c_char_p * (len(env) + 1))(*env, None)
rc = libc.posix_spawn(ctypes.byref(pid), args[0].encode(), None, ctypes.byref(attr), argv, envp)
if rc != 0:
    sys.exit(f"spawn-disclaimed: posix_spawn failed: {os.strerror(rc)}")
for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(s, lambda n, _f: os.kill(pid.value, n))
while True:
    try:
        _, status = os.waitpid(pid.value, 0)
        break
    except InterruptedError:
        continue
sys.exit(os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))
