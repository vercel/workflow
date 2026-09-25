#!/usr/bin/env python3
"""Digest of results/*.txt for the StartStamping model.

For each variant: its header line, the unescaped Layer-A summary printed by
the ASSUME block (full runs only), then one line per result file with the
verdict and state count, and for a violation a compact trace (scenario +
the actions and the variables they changed).
"""
import glob
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "results")
SHOW = ("row", "log", "xpc", "cpc", "held", "kpc", "att", "outc", "rdone", "mint")


def verdict(txt):
    m = re.search(r"^Error: Invariant (\w+) is violated", txt, re.M)
    if m:
        return "VIOLATED " + m.group(1)
    if "No error has been found" in txt:
        return "holds"
    if "Assumption" in txt and "is false" in txt:
        return "ASSUME FAILED"
    return "ERROR/TIMEOUT"


def states(txt):
    m = re.findall(r"^(\d+) states generated, (\d+) distinct states found", txt, re.M)
    return f"{m[-1][1]} distinct" if m else "?"


def compact_trace(txt):
    i = txt.find("Error: Invariant")
    if i < 0:
        return []
    body = txt[i:]
    if "violated by the initial state" in body.splitlines()[0]:
        m = re.search(r"^/\\ scn = (.*?)(?=^/\\ |\n\n|\Z)", body, re.S | re.M)
        return ["      initial state, scn " + (" ".join(m.group(1).split()) if m else "?")]
    parts = re.split(r"\nState (\d+): ", body)
    out, prev = [], {}
    for k in range(1, len(parts), 2):
        n, s = parts[k], parts[k + 1]
        hdr = s.splitlines()[0]
        m = re.match(r"<(\w+)", hdr)
        act = m.group(1) if m else hdr
        vs = {}
        for mm in re.finditer(r"^/\\ (\w+) = (.*?)(?=^/\\ |\n\n|\Z)", s, re.S | re.M):
            vs[mm.group(1)] = " ".join(mm.group(2).split())
        if n == "1":
            out.append(f"      scn {vs.get('scn')}  mint {vs.get('mint')}")
        else:
            ch = [f"{v}={vs[v]}" for v in SHOW if v in vs and prev.get(v) != vs[v]]
            out.append(f"      {n} {act}: " + "; ".join(ch))
        prev = vs
    return out


def main():
    cfgs = sorted(glob.glob(os.path.join(HERE, "StartStamping_*.cfg")))
    for cfg in cfgs:
        v = os.path.basename(cfg)[len("StartStamping_"):-4]
        with open(cfg) as f:
            head = f.readline().strip().lstrip("\\* ")
        print(f"=== {v}: {head}")
        full = os.path.join(RES, f"{v}.txt")
        if os.path.exists(full):
            txt = open(full).read()
            for line in re.findall(r'^"<<.*>>"$', txt, re.M):
                print("  " + line[1:-1].replace('\\"', '"'))
        files = sorted(glob.glob(os.path.join(RES, f"{v}.txt"))
                       + glob.glob(os.path.join(RES, f"{v}__*.txt")))
        for rf in files:
            txt = open(rf).read()
            name = os.path.basename(rf)[:-4]
            print(f"  [{verdict(txt)}] {name} ({states(txt)})")
            if verdict(txt).startswith("VIOLATED"):
                for line in compact_trace(txt):
                    print(line[:900])
        print()


if __name__ == "__main__":
    main()
