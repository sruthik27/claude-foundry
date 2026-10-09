"""Short digests of the newest N session transcripts in a project dir, as JSON (stdout)."""
import json, os, re, sys

d, me, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
query = sys.argv[4] if len(sys.argv) > 4 else ''
STOP = {'the','a','an','and','or','of','to','in','on','for','with','where','was','were','we','i','that','this','it','is','one','session','sessions','added','ability','between','different','from','my','me','some'}
words = [w for w in re.findall(r'[a-z0-9]{3,}', query.lower()) if w not in STOP]
allf = [f for f in os.listdir(d) if f.endswith('.jsonl') and f != me + '.jsonl']
allf.sort(key=lambda f: os.path.getmtime(os.path.join(d, f)), reverse=True)
files = allf[:n]
TS = re.compile(r'"timestamp":"([^"]+)"')
FP = re.compile(r'"name":"(?:Edit|Write|MultiEdit)".{0,200}?"file_path":"([^"]+)"')

def spread(ps, k=8):
    """First two, last one, then the prompts that best match the query, then an even sample:
    mid-session work stays visible, and what the user is looking for is never cut."""
    if len(ps) <= k: return ps
    keep = {0, 1, len(ps) - 1}
    by_hit = sorted(range(2, len(ps) - 1), key=lambda i: -sum(w in ps[i].lower() for w in words))
    for i in by_hit:
        if len(keep) >= k - 2 or sum(w in ps[i].lower() for w in words) == 0: break
        keep.add(i)
    step = (len(ps) - 3) / max(1, k - len(keep))
    j = 2.0
    while len(keep) < k and j < len(ps) - 1:
        keep.add(int(j)); j += step
    return [ps[i] for i in sorted(keep)]

def ask(text):
    text = text.strip()
    if text.startswith('<command-name>'):
        args = re.search(r'<command-args>([\s\S]*?)</command-args>', text)
        name = re.search(r'<command-name>([^<]*)</command-name>', text)
        return f"{name.group(1) if name else ''} {args.group(1)}".strip() if args and args.group(1).strip() else ''
    if text.startswith('<'):
        return ''
    return ' '.join(text.split())

out = []
for f in files:
    title = ai = branch = first = last = None
    prompts, edits = [], []
    with open(os.path.join(d, f), errors='ignore') as fh:
        for line in fh:
            if first is None and (m := TS.search(line)):
                first = m.group(1)
            if '"custom-title"' in line:
                title = json.loads(line).get('customTitle') or title
            elif '"ai-title"' in line:
                try: ai = json.loads(line).get('aiTitle') or ai
                except ValueError: pass
            elif '"type":"user"' in line and '"tool_result"' not in line:
                try:
                    j = json.loads(line)
                    c = j.get('message', {}).get('content')
                    if isinstance(c, str) and not j.get('isMeta') and (a := ask(c)) and not a.startswith('Another Claude session'):
                        prompts.append(a[:140])
                    branch = j.get('gitBranch') or branch
                    last = j.get('timestamp') or last
                except ValueError:
                    pass
            elif '"tool_use"' in line:
                for p in FP.findall(line):
                    b = os.path.basename(p)
                    if b not in edits: edits.append(b)
    if not prompts:
        continue
    out.append({'id': f[:-6], 'title': title or ai or prompts[0][:60], 'branch': branch, 'date': (last or first or '')[:10],
                'prompts': spread(prompts), 'edits': edits[:8]})
print(json.dumps(out))
