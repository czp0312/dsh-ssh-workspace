/** One short-lived helper per request. No remote files, daemon, or shell bootstrap. */
export type HelperRequest =
  | { op: 'inspect' | 'browse'; path: string }
  | { op: 'probe-create' | 'probe-remove'; path: string; name: string; token: string }
  | { op: 'run'; cwd: string; command: string; timeoutMs: number; leaseMs: number }

export const REMOTE_HELPER = String.raw`
import base64, getpass, json, os, platform, re, select, signal, stat, subprocess, sys, time

stopping = False

def stop(signum, frame):
    global stopping
    stopping = True

for sig in (signal.SIGTERM, signal.SIGINT, getattr(signal, "SIGHUP", None)):
    if sig is not None:
        signal.signal(sig, stop)

def emit(value):
    print(json.dumps(value, ensure_ascii=True, separators=(",", ":")), flush=True)

def directory(path):
    if not isinstance(path, str) or not path or "\0" in path:
        raise ValueError("Invalid directory")
    resolved = os.path.realpath(os.path.expanduser(path))
    if not os.path.isdir(resolved):
        raise ValueError("Remote directory does not exist or is not a directory")
    return resolved

class Heartbeat:
    def __init__(self, lease):
        self.lease = lease
        self.last = time.monotonic()
        self.seen = False
        self.closed = False
        self.fd = sys.stdin.fileno()
        # Windows select() accepts sockets only. This branch also lets the exact
        # helper be tested with a local Windows Python; Linux/WSL use select().
        if os.name == "nt":
            import threading
            def reader():
                try:
                    while os.read(self.fd, 4096):
                        self.last = time.monotonic()
                        self.seen = True
                finally:
                    self.closed = True
            threading.Thread(target=reader, daemon=True).start()

    def poll(self, wait=0):
        if os.name == "nt":
            if wait:
                time.sleep(wait)
        else:
            # Drain buffered heartbeats as well as EOF before starting a command.
            for attempt in range(32):
                ready, _, _ = select.select([self.fd], [], [], wait if attempt == 0 else 0)
                if not ready:
                    break
                data = os.read(self.fd, 4096)
                if not data:
                    self.closed = True
                    break
                self.last = time.monotonic()
                self.seen = True
        return not (self.closed or stopping or time.monotonic() - self.last >= self.lease)

def windows_job(process):
    # A job owns descendants even if bash exits first. Used only by local Windows
    # tests; actual SSH/WSL targets use a POSIX session/process group below.
    if os.name != "nt":
        return None
    import ctypes
    from ctypes import wintypes
    class Basic(ctypes.Structure):
        _fields_ = [("process_time", ctypes.c_int64), ("job_time", ctypes.c_int64),
                    ("flags", wintypes.DWORD), ("minimum", ctypes.c_size_t),
                    ("maximum", ctypes.c_size_t), ("active", wintypes.DWORD),
                    ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD),
                    ("scheduling", wintypes.DWORD)]
    class IO(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in
                    ("read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes")]
    class Extended(ctypes.Structure):
        _fields_ = [("basic", Basic), ("io", IO), ("process_memory", ctypes.c_size_t),
                    ("job_memory", ctypes.c_size_t), ("peak_process", ctypes.c_size_t),
                    ("peak_job", ctypes.c_size_t)]
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.CreateJobObjectW(None, None)
    limits = Extended()
    limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not handle:
        raise OSError("Cannot create command job")
    if not kernel.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
        kernel.CloseHandle(handle)
        raise OSError("Cannot configure command job")
    if not kernel.AssignProcessToJobObject(handle, wintypes.HANDLE(int(process._handle))):
        kernel.CloseHandle(handle)
        raise OSError("Cannot contain command process")
    return (kernel, handle)

def cleanup(process, job):
    if os.name == "nt":
        if job:
            kernel, handle = job
            kernel.TerminateJobObject(handle, 1)
            kernel.CloseHandle(handle)
        elif process.poll() is None:
            try:
                subprocess.run(["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=1)
            except (OSError, subprocess.TimeoutExpired):
                process.kill()
    else:
        # The leader may have exited while its descendants still hold our pipes.
        # Always signal its group, including on a successful foreground exit.
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        until = time.monotonic() + 0.3
        while time.monotonic() < until:
            process.poll()
            try:
                os.killpg(process.pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.02)
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=1)

def run(request):
    command = request.get("command")
    if not isinstance(command, str) or not command.strip() or "\0" in command:
        raise ValueError("Invalid command")
    timeout = request["timeoutMs"] / 1000
    lease = request["leaseMs"] / 1000
    if not 0 < timeout <= 600 or not 0 < lease <= 30:
        raise ValueError("Invalid command deadline or lease")
    cwd = directory(request["cwd"])
    heartbeat = Heartbeat(lease)
    while not heartbeat.seen:
        if not heartbeat.poll(0.02):
            return 125
    if not heartbeat.poll():
        return 125
    # A login profile is allowed to cd. Restore cwd afterwards, without embedding
    # either the directory or user command in the wrapper's shell source.
    process = subprocess.Popen(["bash", "-lc", 'cd -- "$1" && eval "$2"', "dsh-ssh", cwd, command], cwd=cwd,
                               start_new_session=True, stdin=subprocess.DEVNULL)
    job = None
    try:
        job = windows_job(process)
        deadline = time.monotonic() + timeout
        while True:
            code = process.poll()
            if code is not None:
                return code if code >= 0 else 128 - code
            if time.monotonic() >= deadline:
                return 124
            if not heartbeat.poll(min(0.05, max(0, deadline - time.monotonic()))):
                return 125
    finally:
        cleanup(process, job)

def probe(request, root):
    name, token = request.get("name"), request.get("token")
    if not isinstance(name, str) or not re.fullmatch(r"\.dsh-ssh-probe-[a-f0-9]{32}", name):
        raise ValueError("Invalid probe name")
    if not isinstance(token, str) or not re.fullmatch(r"[a-f0-9]{64}", token):
        raise ValueError("Invalid probe token")
    path = os.path.join(root, name)
    expected = token.encode("ascii")
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    if request["op"] == "probe-create":
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | nofollow, 0o600)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(expected)
        except BaseException:
            os.unlink(path)
            raise
        emit({"name": name, "token": token})
        return
    try:
        before = os.lstat(path)
    except FileNotFoundError:
        emit({"ok": True})
        return
    if not stat.S_ISREG(before.st_mode):
        raise ValueError("Probe is not a regular file")
    fd = os.open(path, os.O_RDONLY | nofollow | getattr(os, "O_NONBLOCK", 0))
    with os.fdopen(fd, "rb") as stream:
        opened = os.fstat(stream.fileno())
        if not stat.S_ISREG(opened.st_mode) or opened.st_size != len(expected):
            raise ValueError("Probe content does not match")
        import hmac
        if not hmac.compare_digest(stream.read(len(expected) + 1), expected):
            raise ValueError("Probe content does not match")
        current = os.lstat(path)
        if (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino) or \
           (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino):
            raise ValueError("Probe changed during verification")
    os.unlink(path)
    emit({"ok": True})

def main():
    request = json.loads(base64.b64decode(sys.argv[1], validate=True).decode("utf-8"))
    op = request.get("op")
    if op == "run":
        return run(request)
    root = directory(request["path"])
    if op == "inspect":
        emit({"path": root, "home": os.path.expanduser("~"), "user": getpass.getuser(),
              "platform": platform.system(), "python": platform.python_version()})
    elif op == "browse":
        entries = []
        with os.scandir(root) as iterator:
            for entry in iterator:
                if entry.is_dir():
                    entries.append(entry.name)
                    if len(entries) > 4096:
                        raise ValueError("Too many subdirectories (limit 4096)")
        emit({"path": root, "directories": sorted(entries, key=str.casefold)})
    elif op in ("probe-create", "probe-remove"):
        probe(request, root)
    else:
        raise ValueError("Unknown helper operation")
    return 0

try:
    sys.exit(main())
except (Exception, KeyboardInterrupt) as error:
    # Never echo the request, command, or probe token in diagnostics.
    print("dsh-ssh helper: " + str(error), file=sys.stderr, flush=True)
    sys.exit(1)
`.trim()
