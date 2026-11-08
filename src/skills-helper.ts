/** Restricted user-skill IO. Requests arrive over stdin, not the command line. */
export const SKILLS_HELPER = String.raw`
import base64, fcntl, hashlib, json, os, re, shutil, signal, stat, sys, tempfile

def interrupted(signum,frame): raise KeyboardInterrupt('Skill sync interrupted')
signal.signal(signal.SIGTERM,interrupted)
signal.signal(signal.SIGINT,interrupted)

MAX_BYTES=10*1024*1024
MAX_FILES=1024
MAX_BATCH=20*1024*1024
NAME=re.compile(r'^[a-z0-9]+(?:-[a-z0-9]+)*$')

def hash_files(files):
    h=hashlib.sha256()
    for f in sorted(files,key=lambda f:f['path']):
        h.update((f['path']+'\0'+f['hash']+'\0'+('x' if f['executable'] else '')+'\n').encode())
    return h.hexdigest()

def tree(path):
    files=[]; total=0
    protected=[]
    def walk(directory,prefix=''):
        nonlocal total
        for entry in sorted(os.scandir(directory),key=lambda e:e.name):
            relative=prefix+entry.name
            if entry.name in ('.git','node_modules','__pycache__') or entry.name=='.env' or entry.name.startswith('.env.'):
                protected.append(relative)
                continue
            info=entry.stat(follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode): raise ValueError('包含符号链接，请先将资源放入技能目录')
            if stat.S_ISDIR(info.st_mode): walk(entry.path,relative+'/')
            elif stat.S_ISREG(info.st_mode):
                total+=info.st_size
                if total>MAX_BYTES or len(files)>=MAX_FILES: raise ValueError('超过单个技能 10 MiB / 1024 文件上限')
                with open(entry.path,'rb') as stream: data=stream.read(MAX_BYTES+1)
                if len(data)!=info.st_size: raise ValueError('技能文件在读取时发生变化，请刷新')
                files.append({'path':relative,'hash':hashlib.sha256(data).hexdigest(),'executable':bool(info.st_mode&0o111)})
            else: raise ValueError('包含特殊文件，不能同步')
    walk(path)
    return hash_files(files),bool(protected)

def header(path):
    with open(path,'rb') as stream: data=stream.read(128*1024+1)
    if len(data)>128*1024: raise ValueError('技能指令文件超过 128 KiB')
    text=data.decode('utf-8-sig')
    frontmatter=re.match(r'\A---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)',text)
    return frontmatter.group(0) if frontmatter else ''

home=os.path.abspath(os.path.expanduser(os.environ.get('DSH_HOME','~/.dsh')))
agents=os.path.abspath(os.path.expanduser(os.environ.get('DSH_AGENTS_HOME','~/.agents')))
root=os.path.join(home,'skills')

def catalog():
    rows=[]
    for bucket,directory in [('dsh',root),('agents',os.path.join(agents,'skills'))]:
        if not os.path.lexists(directory): continue
        if os.path.islink(directory) or not os.path.isdir(directory): raise ValueError('远端技能根目录不是普通目录，不能安全同步')
        for entry in sorted(os.scandir(directory),key=lambda e:e.name):
            if entry.name.startswith('.'): continue
            if len(rows)>=1024: raise ValueError('远端技能数量超过 1024')
            info=entry.stat(follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode):
                rows.append({'key':bucket+'/'+entry.name,'bucket':bucket,'entry':entry.name,'blocked':'目标是符号链接，不能覆盖'})
                continue
            instruction=os.path.join(entry.path,'SKILL.md') if stat.S_ISDIR(info.st_mode) else entry.path if entry.name.endswith('.md') else None
            if instruction is None: continue
            row={'key':bucket+'/'+entry.name,'bucket':bucket,'entry':entry.name}
            try:
                if stat.S_ISLNK(info.st_mode) or os.path.islink(instruction): raise ValueError('目标是符号链接，不能覆盖')
                if not os.path.isfile(instruction): continue
                row['text']=header(instruction)
                if stat.S_ISDIR(info.st_mode): row['hash'],row['protected']=tree(entry.path)
                else: row['hash']=hashlib.sha256(open(instruction,'rb').read()).hexdigest()
                row['bundle']=stat.S_ISDIR(info.st_mode)
            except Exception as e: row['blocked']=str(e)
            rows.append(row)
    digest=hashlib.sha256(json.dumps(rows,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    return {'destination':root,'rows':rows,'hash':digest}

def safe_component(value):
    if not isinstance(value,str) or value in ('','.','..') or '/' in value or '\\' in value or '\0' in value or value.startswith('.'): raise ValueError('无效的技能目标目录')
    return value

def apply(r):
    os.makedirs(home,mode=0o700,exist_ok=True)
    lockfd=os.open(os.path.join(home,'.dsh-ssh-skills.lock'),os.O_WRONLY|os.O_CREAT|getattr(os,'O_NOFOLLOW',0),0o600)
    with os.fdopen(lockfd,'w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        current=catalog()
        if current['hash']!=r.get('expected'): raise ValueError('远端技能已变化，请刷新列表后重新选择')
        items=r.get('items')
        if not isinstance(items,list) or not 0<len(items)<=128: raise ValueError('单次请选择 1 至 128 个技能')
        os.makedirs(root,mode=0o700,exist_ok=True)
        if os.path.islink(root): raise ValueError('目标技能目录不能是符号链接')
        results=[]; names=set(); batch=0
        for item in items:
            name=item.get('name','')
            try:
                if not NAME.fullmatch(name) or name in names: raise ValueError('无效或重复的技能名称')
                names.add(name)
                entry=safe_component(item.get('entry',name))
                destination=os.path.join(root,entry)
                before=next((row for row in current['rows'] if row['key']=='dsh/'+entry),None)
                exists=os.path.lexists(destination)
                if exists and (not before or before.get('blocked') or before.get('protected') or not before.get('bundle') or item.get('overwrite') is not True): raise ValueError('目标已存在，未授权覆盖或目标包含需要保留的本机数据')
                files=item.get('files')
                if not isinstance(files,list) or not 0<len(files)<=MAX_FILES: raise ValueError('无效的技能文件列表')
                staging=tempfile.mkdtemp(prefix='.dsh-ssh-sync-',dir=root)
                try:
                    new=os.path.join(staging,'new'); os.mkdir(new,0o700)
                    seen=set(); total=0; manifest=[]
                    for file in files:
                        path=file.get('path')
                        if not isinstance(path,str) or '\\' in path or '\0' in path or any(p in ('','.','..') for p in path.split('/')) or path.startswith('/') or path in seen: raise ValueError('无效的技能资源路径')
                        seen.add(path)
                        data=base64.b64decode(file.get('data',''),validate=True)
                        total+=len(data); batch+=len(data)
                        if total>MAX_BYTES or batch>MAX_BATCH: raise ValueError('同步内容超过大小上限')
                        dest=os.path.join(new,*path.split('/'))
                        os.makedirs(os.path.dirname(dest),mode=0o700,exist_ok=True)
                        with open(dest,'xb') as out: out.write(data)
                        executable=file.get('executable') is True
                        os.chmod(dest,0o700 if executable else 0o600)
                        manifest.append({'path':path,'hash':hashlib.sha256(data).hexdigest(),'executable':executable})
                    if 'SKILL.md' not in seen or hash_files(manifest)!=item.get('hash'): raise ValueError('技能内容校验失败')
                    if catalog()['hash']!=current['hash']: raise ValueError('远端技能已变化，请刷新后重试')
                    backup=os.path.join(staging,'backup')
                    moved=False
                    mask=signal.pthread_sigmask(signal.SIG_BLOCK,{signal.SIGTERM,signal.SIGINT})
                    try:
                        try:
                            if exists:
                                os.rename(destination,backup)
                                moved=True
                            os.rename(new,destination)
                        except BaseException:
                            if moved and not os.path.lexists(destination): os.rename(backup,destination)
                            raise
                    finally: signal.pthread_sigmask(signal.SIG_SETMASK,mask)
                    results.append({'id':item['id'],'name':name,'status':'updated' if exists else 'created'})
                    current=catalog()
                finally: shutil.rmtree(staging)
            except Exception as e: results.append({'id':item.get('id',''),'name':name,'status':'failed','message':str(e)})
        return {'items':results}

try:
    line=sys.stdin.buffer.readline(30*1024*1024+1)
    if len(line)>30*1024*1024: raise ValueError('同步请求过大')
    r=json.loads(line)
    if r.get('op')=='preview': value=catalog()
    elif r.get('op')=='apply': value=apply(r)
    else: raise ValueError('未知的技能操作')
    print(json.dumps(value,ensure_ascii=True,separators=(',',':')),flush=True)
except Exception as e:
    print('Skill sync: '+str(e),file=sys.stderr,flush=True)
    sys.exit(1)
`.trim()
