#!/usr/bin/env python3
"""Classify every result file under */results/ and print one line per file.

    <model>/results/<file>  <verdict>

TLC outputs give PASS, VIOLATION(<property>), or ERROR. Lean outputs give
PROVED or FAILED. run.sh compares this listing with expected-verdicts.txt.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
MODELS = ["StartStamping", "ServerRaiseProtocol", "MidRunRaiseGates",
          "ResolveLean", "Completeness"]
LEAN_FILES = {("ResolveLean", n) for n in
              ("Spec", "Resolve", "Raise", "StaleSkip", "Combined")}
LEAN_FILES.add(("Completeness", "AttestSound"))
SKIP = {"summary.txt", "run-all.txt", "lean-version.txt"}


def tlc(text):
    if "No error has been found" in text:
        return "PASS"
    m = re.search(r"(?:Invariant|Action property|Property) (\w+) is violated", text)
    if m:
        return f"VIOLATION({m.group(1)})"
    if "Temporal properties were violated" in text:
        return "VIOLATION(temporal)"
    if re.search(r"Assumption .* is false|ASSUME .* violated", text):
        return "ERROR(assume)"
    return "ERROR"


def lean(text):
    ok = re.search(r"^exit=0\b", text, re.M) and \
        not re.search(r"(^|: )error", text, re.M) and \
        "declaration uses 'sorry'" not in text
    return "PROVED" if ok else "FAILED"


def main():
    rows = []
    for model in MODELS:
        d = os.path.join(ROOT, model, "results")
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            if not name.endswith(".txt") or name in SKIP:
                continue
            with open(os.path.join(d, name), errors="replace") as f:
                text = f.read()
            stem = name[:-4]
            v = lean(text) if (model, stem) in LEAN_FILES else tlc(text)
            rows.append(f"{model}/results/{name}  {v}")
    out = "\n".join(rows) + "\n"
    if len(sys.argv) > 1:
        with open(sys.argv[1], "w") as f:
            f.write(out)
    else:
        sys.stdout.write(out)


if __name__ == "__main__":
    main()
