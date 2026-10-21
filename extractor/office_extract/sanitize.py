"""Allow-list sanitizer: everything that leaves the container passes through here.

Rules
- Only *captions* (short strings) ever leave; tool results never do.
- Captions are truncated, tag-stripped and secret-masked.
- Paths are reduced to a basename (plus one parent dir for context).
"""
from __future__ import annotations

import os
import re

CAPTION_MAX = 120

_SYSTEM_BLOCK = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)
_XML_TAG = re.compile(r"</?(?:antml:)?[A-Za-z_][\w:-]{0,40}(?:\s[^<>]{0,200})?/?>")
_MD_NOISE = re.compile(r"(^|\n)\s*(#{1,6}\s+|[-*]\s+|\d+\.\s+)")
_WS = re.compile(r"\s+")
_MD_LINK = re.compile(r"\[([^\]]{0,120})\]\((?:https?://|mailto:)[^)]*\)")
_URL = re.compile(r"https?://\S+")

# Order matters: specific tokens first, generic key=value last.
_SECRET_PATTERNS = [
    re.compile(r"\b(?:sk|ghp|gho|ghu|ghs|ghr|xox[baprs]|glpat|npm)[-_][A-Za-z0-9_\-]{10,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}(?:\.[A-Za-z0-9_\-]{5,})?"),
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._\-]{12,}"),
    re.compile(r"\b[A-Fa-f0-9]{40,}\b"),
    re.compile(r"(?i)\b(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key)\b(\s*[=:]\s*)\S+"),
]
_EMAIL = re.compile(r"\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b")


def mask_secrets(text: str) -> str:
    for pat in _SECRET_PATTERNS[:-1]:
        text = pat.sub("***", text)
    text = _SECRET_PATTERNS[-1].sub(lambda m: f"{m.group(1)}{m.group(2)}***", text)
    text = _EMAIL.sub(lambda m: f"{m.group(1)}***@{m.group(2)}", text)
    return text


def clean_text(text: str, limit: int = CAPTION_MAX) -> str:
    """Strip system blocks/tags/markdown, collapse whitespace, mask, truncate."""
    if not text:
        return ""
    text = _SYSTEM_BLOCK.sub(" ", text)
    text = _XML_TAG.sub(" ", text)
    text = _MD_LINK.sub(r"\1", text)          # [label](https://…) → label
    text = _URL.sub("🔗", text)                # bare links carry no meaning in a bubble
    text = _MD_NOISE.sub(r"\1", text)
    text = _WS.sub(" ", text).strip()
    text = mask_secrets(text)
    return truncate(text, limit)


def truncate(text: str, limit: int = CAPTION_MAX) -> str:
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)].rstrip() + "…"


def short_path(path: str, cwd: str | None = None) -> str:
    """'/home/me/proj/src/app/main.py' -> 'app/main.py'. Never leaks absolute paths."""
    if not path:
        return ""
    path = str(path)
    if cwd and path.startswith(cwd.rstrip("/") + "/"):
        rel = path[len(cwd.rstrip("/")) + 1 :]
    else:
        rel = path
    parts = [p for p in rel.replace("\\", "/").split("/") if p]
    if len(parts) <= 2:
        return "/".join(parts)
    return "/".join(parts[-2:])


def basename(path: str) -> str:
    return os.path.basename(str(path).rstrip("/")) if path else ""
