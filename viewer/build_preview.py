#!/usr/bin/env python3
"""Build a self-contained preview of the viewer with a DATA_DIR embedded.

  python3 viewer/build_preview.py DATA_DIR OUT.html [--artifact]

--artifact  strips the document skeleton (doctype/html/head/body) because the
            claude.ai Artifact tool wraps the page itself.
Without it, OUT.html is a normal standalone page (open it from disk, no server needed).
"""
from __future__ import annotations

import glob
import json
import os
import sys


def collect(data_dir: str) -> dict:
    files: dict[str, object] = {}
    for path in glob.glob(os.path.join(data_dir, "**", "*"), recursive=True):
        if not os.path.isfile(path) or os.path.basename(path).startswith("."):
            continue
        rel = os.path.relpath(path, data_dir).replace(os.sep, "/")
        with open(path, encoding="utf-8") as f:
            if rel.endswith(".jsonl"):
                files[rel] = [json.loads(l) for l in f if l.strip()]
            elif rel.endswith(".json"):
                files[rel] = json.load(f)
    return files


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    data_dir, out = sys.argv[1], sys.argv[2]
    artifact = "--artifact" in sys.argv
    here = os.path.dirname(os.path.abspath(__file__))
    html = open(os.path.join(here, "index.html"), encoding="utf-8").read()
    payload = json.dumps({"files": collect(data_dir)}, ensure_ascii=False).replace("</", "<\\/")
    inject = f"<script>window.OFFICE_DATA={payload};window.OFFICE_DATA_BASE='data';</script>\n"
    if artifact:
        start = html.index("<!--OFFICE:INNER-START-->") + len("<!--OFFICE:INNER-START-->")
        end = html.index("<!--OFFICE:INNER-END-->")
        inner = html[start:end]
        inner = inner.replace("<!--OFFICE:HEAD-END-->\n</head>\n<body>\n<!--OFFICE:BODY-START-->\n", "")
        html = inner.replace("<!--OFFICE:BODY-START-->", "")
        import re as _re
        html = _re.sub(r"<!--OFFICE:PWA-START-->.*?<!--OFFICE:PWA-END-->\n?", "", html, flags=_re.S)
        html = html.replace("</style>\n", "</style>\n" + inject, 1)
    else:
        html = html.replace("<!--OFFICE:BODY-START-->\n", inject, 1)
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"wrote {out} ({len(html)//1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
