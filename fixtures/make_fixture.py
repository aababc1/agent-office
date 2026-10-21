#!/usr/bin/env python3
"""Copy a Claude Code transcript (+ sub-agent sidecars) into a small, shareable fixture.

Structure is preserved exactly (every record, every block type, every key).
Only *values* are shortened: long strings are truncated, tool_result bodies
cut to 200 chars, image data dropped. The result is safe to commit and is what
the test-suite parses.

  python3 fixtures/make_fixture.py ~/.claude/projects/<enc>/<session>.jsonl fixtures/session-sample
"""
from __future__ import annotations

import json
import os
import shutil
import sys

TEXT_MAX = 200
LIST_MAX = 30


def shrink(obj, depth=0):
    if isinstance(obj, str):
        return obj if len(obj) <= TEXT_MAX else obj[:TEXT_MAX] + "…[truncated]"
    if isinstance(obj, list):
        return [shrink(v, depth + 1) for v in obj[:LIST_MAX]]
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if k == "source" and isinstance(v, dict) and v.get("type") == "base64":
                out[k] = {"type": "base64", "media_type": v.get("media_type"), "data": "[dropped]"}
            elif k == "attachment" and depth == 0 and isinstance(v, dict):
                out[k] = {"type": v.get("type"), "note": "[body dropped by make_fixture]"}
            else:
                out[k] = shrink(v, depth + 1)
        return out
    return obj


def convert(src: str, dst: str) -> None:
    os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
    with open(src, encoding="utf-8") as fin, open(dst, "w", encoding="utf-8") as fout:
        for line in fin:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                fout.write(line + "\n")  # keep malformed lines: the parser must survive them
                continue
            fout.write(json.dumps(shrink(rec), ensure_ascii=False) + "\n")


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    transcript, out_dir = sys.argv[1], sys.argv[2]
    session = os.path.basename(transcript).removesuffix(".jsonl")
    if os.path.isdir(out_dir):
        shutil.rmtree(out_dir)
    os.makedirs(out_dir)
    convert(transcript, os.path.join(out_dir, f"{session}.jsonl"))
    sidecar = os.path.join(os.path.dirname(transcript), session, "subagents")
    if os.path.isdir(sidecar):
        for name in sorted(os.listdir(sidecar)):
            src = os.path.join(sidecar, name)
            dst = os.path.join(out_dir, session, "subagents", name)
            if name.endswith(".jsonl"):
                convert(src, dst)
            elif name.endswith(".meta.json"):
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copyfile(src, dst)
            # *.prefix.json: prompt-cache bookkeeping, not needed
    print(f"fixture written to {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
