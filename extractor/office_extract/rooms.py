"""Tool → room mapping and speech-bubble captions.

Rooms (viewer draws these):
  archive  자료실     reading / searching files
  dev      개발실     editing / writing files
  server   서버실     running commands, git, builds
  search   정보검색실  web, MCP / external tools
  meeting  회의실     planning, task lists, skills
  desk     내 자리    talking to the user
  elevator 엘리베이터 delegating to sub-agents
  lounge   라운지     idle (viewer-only)
"""
from __future__ import annotations

import re
import shlex
from typing import Any

from .sanitize import basename, clean_text, mask_secrets, short_path, truncate

_ROOM_BY_TOOL: dict[str, str] = {
    # archive
    "Read": "archive", "Glob": "archive", "Grep": "archive", "LS": "archive",
    "NotebookRead": "archive", "ReadMcpResourceTool": "archive",
    "ReadMcpResourceDirTool": "archive", "ListMcpResourcesTool": "archive",
    # dev
    "Edit": "dev", "Write": "dev", "MultiEdit": "dev", "NotebookEdit": "dev",
    # server
    "Bash": "server", "Monitor": "server", "KillShell": "server", "BashOutput": "server",
    # search
    "WebSearch": "search", "WebFetch": "search", "ToolSearch": "search",
    "SearchMcpRegistry": "search", "SearchPlugins": "search", "SearchSkills": "search",
    # meeting
    "TodoWrite": "meeting", "TaskCreate": "meeting", "TaskUpdate": "meeting",
    "TaskList": "meeting", "TaskGet": "meeting", "EnterPlanMode": "meeting",
    "ExitPlanMode": "meeting", "Skill": "meeting",
    # desk
    "AskUserQuestion": "desk", "SendUserMessage": "desk", "SendUserFile": "desk",
    # elevator
    "Agent": "elevator", "Task": "elevator", "SendMessage": "elevator",
}

# Bash first-command classification (cowboy76 rule: rg/cat → archive, sed -i → dev, curl → search)
_BASH_ARCHIVE = {"rg", "grep", "cat", "head", "tail", "less", "ls", "find", "fd", "tree",
                 "wc", "stat", "file", "du", "diff", "jq", "bat", "which", "pwd", "env"}
_BASH_DEV = {"sed", "tee", "mv", "cp", "mkdir", "touch", "rm", "chmod", "chown", "patch",
             "ln", "truncate", "rsync"}
_BASH_SEARCH = {"curl", "wget", "http", "httpie", "dig", "nslookup", "ping"}
_PREFIX_SKIP = {"cd", "sudo", "env", "time", "nohup", "nice", "command", "exec", "set"}
_NOISE_COMMANDS = {"echo", "printf", "true", "false", "export", "source", ".", "sleep", "date"}


def bash_room(command: str) -> str:
    """Classify a shell command line into a room by its first meaningful command."""
    if not command:
        return "server"
    cmd = _NOISE_REDIRECT.sub(" ", command.strip())   # drop 2>&1, >/dev/null, 2>/dev/null
    unquoted = _QUOTED.sub(" ", cmd)                  # a `->` inside python -c "..." is not a redirect
    writes_file = bool(_REDIRECT.search(unquoted))    # `cat x > y` is writing, not reading
    first = _first_command(cmd)
    if first in _BASH_ARCHIVE:
        return "dev" if writes_file else "archive"
    if first in _BASH_DEV:
        return "dev"
    if first in _BASH_SEARCH:
        return "search"
    if first in ("git", "gh"):
        return "server"
    if writes_file:
        return "dev"
    return "server"


_NOISE_REDIRECT = re.compile(r"(?:\d?&?>{1,2}\s*/dev/null|\d>&\d)")
_QUOTED = re.compile(r""""(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|<<-?\s*'?(\w+)'?[\s\S]*?\n\1\b""")
_REDIRECT = re.compile(r"(?<![<>])>{1,2}\s*[^&\s>]")


def _first_command(cmd: str) -> str:
    # Walk `cd a && b | c ; d` style chains and return the first non-trivial command word.
    segments = re.split(r"\s*(?:&&|\|\||;|\|)\s*", cmd, maxsplit=12)
    for seg in segments:
        seg = seg.strip()
        if not seg:
            continue
        try:
            words = shlex.split(seg, posix=True)
        except ValueError:
            words = seg.split()
        words = [w for w in words if "=" not in w or w.startswith("-")]  # drop VAR=val prefixes
        if not words:
            continue
        w = basename(words[0])
        if w in _PREFIX_SKIP:
            if w == "cd":
                continue
            rest = words[1:]
            w = basename(rest[0]) if rest else w
        if w in _NOISE_COMMANDS or w in ("for", "while", "if", "{", "("):
            continue
        return w
    return ""


def room_for(tool: str, tool_input: dict[str, Any] | None) -> str:
    if tool == "Bash":
        return bash_room(str((tool_input or {}).get("command", "")))
    if tool in _ROOM_BY_TOOL:
        return _ROOM_BY_TOOL[tool]
    if tool.startswith("mcp__"):
        return "search"
    return "server"


def caption_for(tool: str, tool_input: dict[str, Any] | None, cwd: str | None) -> str:
    """Short, non-sensitive description of what a tool call is doing."""
    i = tool_input or {}
    if tool in ("Read", "NotebookRead"):
        return f"{short_path(i.get('file_path') or i.get('notebook_path') or '', cwd)} 읽는 중"
    if tool in ("Edit", "MultiEdit", "NotebookEdit"):
        return f"{short_path(i.get('file_path') or i.get('notebook_path') or '', cwd)} 수정 중"
    if tool == "Write":
        return f"{short_path(i.get('file_path') or '', cwd)} 작성 중"
    if tool in ("Glob", "Grep"):
        pat = str(i.get("pattern", ""))
        return f"'{truncate(mask_secrets(pat), 40)}' 검색 중"
    if tool == "Bash":
        cmd = re.sub(r"\s+", " ", str(i.get("command", ""))).strip()
        desc = str(i.get("description") or "").strip()
        if desc:
            return truncate(mask_secrets(desc), 80)
        return "$ " + truncate(mask_secrets(cmd), 70)
    if tool == "WebSearch":
        return f"🔍 {truncate(mask_secrets(str(i.get('query', ''))), 60)}"
    if tool == "WebFetch":
        url = str(i.get("url", ""))
        host = re.sub(r"^https?://([^/]+).*$", r"\1", url)
        return f"🌐 {truncate(host, 50)} 읽는 중"
    if tool == "TodoWrite":
        todos = i.get("todos") or []
        done = sum(1 for t in todos if isinstance(t, dict) and t.get("status") == "completed")
        return f"할 일 정리 ({done}/{len(todos)} 완료)"
    if tool == "TaskCreate":
        return f"할 일 추가: {clean_text(str(i.get('subject', '')), 60)}"
    if tool == "TaskUpdate":
        st = i.get("status")
        return f"할 일 #{i.get('taskId', '?')} → {st}" if st else f"할 일 #{i.get('taskId', '?')} 갱신"
    if tool == "AskUserQuestion":
        qs = i.get("questions") or []
        q = qs[0].get("question", "") if qs and isinstance(qs[0], dict) else ""
        return "질문: " + clean_text(str(q), 80)
    if tool in ("SendUserMessage",):
        return clean_text(str(i.get("message", "")), 100)
    if tool == "SendUserFile":
        files = i.get("files") or []
        return "파일 전달: " + ", ".join(basename(f) for f in files[:3])
    if tool in ("Agent", "Task"):
        return "맡기기: " + clean_text(str(i.get("description") or i.get("prompt") or ""), 60)
    if tool == "Skill":
        return f"스킬 {i.get('skill', '')}"
    if tool == "ToolSearch":
        return f"도구 찾는 중: {truncate(str(i.get('query', '')), 40)}"
    if tool.startswith("mcp__"):
        parts = tool.split("__")
        server = parts[1] if len(parts) > 1 else "mcp"
        name = parts[-1]
        return f"{server}: {name}"
    return tool
