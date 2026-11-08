/** A version-pinned, user-owned remote DSH. No root installation or local credentials are copied. */
export const BACKEND_BOOTSTRAP = String.raw`
import base64, fcntl, hashlib, json, os, platform, re, shutil, subprocess, sys, tarfile, time, urllib.request
r=json.loads(base64.b64decode(sys.argv[1]))
version=r['version']
if not re.fullmatch(r'[0-9A-Za-z.+-]+',version): raise ValueError('Invalid DSH version')
project=os.path.realpath(r['path'])
if not os.path.isdir(project): raise ValueError('Remote project directory does not exist')
if platform.system()!='Linux': raise RuntimeError('Remote backends currently require Linux or WSL')
root=os.path.expanduser('~/.local/share/dsh-ssh-workspaces')
os.makedirs(root,mode=0o700,exist_ok=True)
os.chmod(root,0o700)
lock=open(os.path.join(root,'bootstrap.lock'),'a')
os.chmod(lock.name,0o600)
fcntl.flock(lock,fcntl.LOCK_EX)
install=os.path.join(root,'dsh-'+version)
node=shutil.which('node')
if node:
    try:
        v=subprocess.check_output([node,'-p','process.versions.node'],text=True).strip()
        if tuple(map(int,v.split('.')[:2])) < (24,9): node=None
    except Exception: node=None
if not node:
    arch={'x86_64':'x64','aarch64':'arm64'}.get(platform.machine())
    if not arch or platform.system()!='Linux': raise RuntimeError('Automatic Node installation supports Linux x64/arm64')
    release='node-v24.12.0-linux-'+arch
    directory=os.path.join(root,release)
    node=os.path.join(directory,'bin','node')
    if not os.path.isfile(node):
        archive=release+'.tar.xz'
        url='https://nodejs.org/dist/v24.12.0/'
        checks=urllib.request.urlopen(url+'SHASUMS256.txt',timeout=60).read().decode()
        expected=next(line.split()[0] for line in checks.splitlines() if line.split()[-1]==archive)
        staging=os.path.join(root,archive+'.part')
        with urllib.request.urlopen(url+archive,timeout=120) as source,open(staging,'wb') as out: shutil.copyfileobj(source,out)
        with open(staging,'rb') as source: actual=hashlib.file_digest(source,'sha256').hexdigest() if hasattr(hashlib,'file_digest') else hashlib.sha256(source.read()).hexdigest()
        if actual!=expected: raise RuntimeError('Node archive checksum mismatch')
        with tarfile.open(staging) as bundle:
            for item in bundle.getmembers():
                destination=os.path.realpath(os.path.join(root,item.name))
                if not destination.startswith(os.path.realpath(root)+os.sep): raise RuntimeError('Unsafe Node archive path')
            bundle.extractall(root)
        os.unlink(staging)
env=dict(os.environ)
env['PATH']=os.path.dirname(node)+os.pathsep+env.get('PATH','')
entry=os.path.join(install,'node_modules','@deepseek-ai','dsh','bin','dsh.js')
manifest=os.path.join(install,'node_modules','@deepseek-ai','dsh','package.json')
complete=os.path.join(install,'installed.ok')
if not os.path.isfile(manifest) or not os.path.isfile(complete):
    npm=os.path.join(os.path.dirname(node),'npm')
    if not os.path.isfile(npm): npm=shutil.which('npm',path=env['PATH'])
    if not npm: raise RuntimeError('npm is required to install remote DSH')
    os.makedirs(install,mode=0o700,exist_ok=True)
    try: result=subprocess.run([npm,'install','--prefix',install,'--no-audit','--no-fund','--omit=dev','@deepseek-ai/dsh@'+version],env=env,stdout=sys.stderr,stderr=sys.stderr,timeout=480)
    except subprocess.TimeoutExpired: raise RuntimeError('Remote DSH installation timed out; check registry connectivity')
    if result.returncode: raise RuntimeError('Remote DSH installation failed; check registry connectivity')
with open(manifest) as f: package=json.load(f)
if package['version']!=version: raise RuntimeError('Remote DSH version does not match the desktop protocol')
binary=package.get('bin',{})
binary=binary.get('dsh') if isinstance(binary,dict) else binary
if not binary: raise RuntimeError('Remote DSH package does not expose its CLI')
entry=os.path.realpath(os.path.join(os.path.dirname(manifest),binary))
if not os.path.isfile(entry): raise RuntimeError('Remote DSH installation is incomplete')
with open(complete,'w') as f: f.write(version)
statefile=os.path.join(install,'backend.json')
state=None
try:
    with open(statefile) as f: candidate=json.load(f)
    os.kill(candidate['pid'],0)
    with open('/proc/'+str(candidate['pid'])+'/cmdline','rb') as f: command=f.read().decode(errors='replace')
    if entry in command and candidate.get('version')==version: state=candidate
except (OSError,ValueError,KeyError): pass
if state is None:
    logpath=os.path.join(install,'backend.log')
    with open(logpath,'wb') as log:
        os.chmod(logpath,0o600)
        process=subprocess.Popen([node,entry,'web','--host','127.0.0.1','--port','0','--no-open'],cwd=os.path.expanduser('~'),env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
    deadline=time.monotonic()+120
    while time.monotonic()<deadline:
        if process.poll() is not None: raise RuntimeError('Remote DSH failed to start; inspect '+logpath)
        with open(logpath,'r',errors='replace') as f: content=f.read()
        match=re.search(r'http://127\.0\.0\.1:(\d+)/\?token=([A-Za-z0-9_-]+)',content)
        if match:
            state={'pid':process.pid,'port':int(match.group(1)),'token':match.group(2),'version':version}
            fd=os.open(statefile,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
            with os.fdopen(fd,'w') as f: json.dump(state,f)
            break
        time.sleep(.2)
    else: raise RuntimeError('Remote DSH startup timed out')
print(json.dumps(dict(state,path=project)),flush=True)
`.trim()

/** A raw TCP channel over SSH/WSL stdin/stdout; HTTP and WebSocket framing remain native. */
export const BACKEND_TUNNEL = String.raw`
import base64,json,os,select,socket,sys
r=json.loads(base64.b64decode(sys.argv[1]))
s=socket.create_connection(('127.0.0.1',int(r['port'])),15)
while True:
    ready,_,_=select.select([s,sys.stdin.buffer],[],[])
    if s in ready:
        data=s.recv(65536)
        if not data: break
        sys.stdout.buffer.write(data);sys.stdout.buffer.flush()
    if sys.stdin.buffer in ready:
        data=os.read(sys.stdin.fileno(),65536)
        if not data: break
        s.sendall(data)
s.close()
`.trim()
