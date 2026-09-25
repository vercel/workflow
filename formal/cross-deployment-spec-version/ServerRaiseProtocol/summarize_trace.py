#!/usr/bin/env python3
"""Condense TLC counterexamples: python3 summarize_trace.py results/*.txt (prints only the variables that change per step)."""
import re,sys
for f in sys.argv[1:]:
    s=open(f).read()
    print("#####",f.split('/')[-1])
    m=re.search(r'Error: (Invariant \w+ is violated|Temporal properties were violated|Action property \w+ .*)',s)
    if 'No error has been found' in s:
        print("PASS", re.findall(r'(\d[\d,]*) distinct states found',s)[-1:]); continue
    print(m.group(0) if m else "??")
    states=re.split(r'\nState (\d+): ',s)
    prev={}
    for i in range(1,len(states),2):
        n=states[i]; body=states[i+1]
        act=body.split('\n')[0]
        act=re.sub(r' line.*','',act)
        vals={}
        for k in ['stamp','exec','row','log','epc','eatt','eheld','kpc','kheld','cpc','sawUlid','crashes']:
            mm=re.search(r'^/\\ '+k+r' = (.*?)(?=\n/\\ |\n\n|\Z)',body,re.S|re.M)
            if mm: vals[k]=' '.join(mm.group(1).split())
        diff={k:v for k,v in vals.items() if prev.get(k)!=v}
        if n=='1': diff={k:vals[k] for k in ['stamp','exec'] if k in vals}
        d=' | '.join(f"{k}={v}" for k,v in diff.items())
        d=d.replace('[st |-> ','[').replace(', sp |-> ',',').replace(', ex |-> TRUE','').replace('k |-> ','').replace(', n |-> ',':').replace('[sp |-> 0, ','[').replace('sp |-> ','sp=').replace(', t |-> ',' ')
        print(f"  {n}. {act}: {d}")
        prev=vals
