"""plan.yaml — what a project consists of, in a form machines can check.

A dependency-free YAML *subset* reader lives here so the probe runs on an HPC login node with a
bare python3 (no PyYAML). The subset: block maps, block lists (`- item` / `- key: v` + indented
keys), scalars (strings, ints, floats, bools, null), quoted strings, flow lists of scalars
`[a, b]`, one-level flow maps `{k: v, k2: v2}`, and `#` comments. No anchors, no multi-line strings.

  office-plan check plan.yaml            validate, print a summary, write plan.json next to it
"""
from __future__ import annotations

import json
import os
import re
import sys
from typing import Any

# ---------------------------------------------------------------- YAML subset
_SCALAR_INT = re.compile(r"^[-+]?\d+$")
_SCALAR_FLOAT = re.compile(r"^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$")


class PlanError(ValueError):
    pass


def _strip_comment(line: str) -> str:
    out, q = [], None
    for i, ch in enumerate(line):
        if q:
            out.append(ch)
            if ch == q:
                q = None
        elif ch in ("'", '"'):
            q = ch; out.append(ch)
        elif ch == "#" and (i == 0 or line[i - 1] in " \t"):
            break
        else:
            out.append(ch)
    return "".join(out).rstrip()


def _scalar(s: str) -> Any:
    s = s.strip()
    if s == "" or s in ("~", "null", "Null", "NULL"):
        return None
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "'\"":
        return s[1:-1]
    if s in ("true", "True", "TRUE"):
        return True
    if s in ("false", "False", "FALSE"):
        return False
    if s.startswith("[") and s.endswith("]"):
        inner = s[1:-1].strip()
        return [] if not inner else [_scalar(x) for x in _split_flow(inner)]
    if s.startswith("{") and s.endswith("}"):
        inner = s[1:-1].strip()
        out: dict[str, Any] = {}
        for part in ([] if not inner else _split_flow(inner)):
            kv = _split_kv(part)
            if not kv:
                raise PlanError(f"bad flow mapping entry: {part!r}")
            out[kv[0]] = _scalar(kv[1])
        return out
    if _SCALAR_INT.match(s):
        return int(s)
    if _SCALAR_FLOAT.match(s):
        return float(s)
    return s


def _split_flow(s: str) -> list[str]:
    parts, cur, q, depth = [], [], None, 0
    for ch in s:
        if q:
            cur.append(ch)
            if ch == q:
                q = None
        elif ch in "'\"":
            q = ch; cur.append(ch)
        elif ch in "[{":
            depth += 1; cur.append(ch)
        elif ch in "]}":
            depth -= 1; cur.append(ch)
        elif ch == "," and depth == 0:
            parts.append("".join(cur)); cur = []
        else:
            cur.append(ch)
    parts.append("".join(cur))
    return [p for p in (x.strip() for x in parts) if p != ""]


def _split_kv(s: str) -> tuple[str, str] | None:
    """`key: value` with the first unquoted `: ` (or trailing `:`)."""
    q = None
    for i, ch in enumerate(s):
        if q:
            if ch == q:
                q = None
        elif ch in "'\"":
            q = ch
        elif ch == ":" and (i == len(s) - 1 or s[i + 1] in " \t"):
            return s[:i].strip(), s[i + 1:].strip()
    return None


def load_yaml(text: str) -> Any:
    lines = []
    for raw in text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        body = _strip_comment(raw)
        if not body.strip():
            continue
        indent = len(body) - len(body.lstrip(" "))
        lines.append((indent, body.strip()))
    value, pos = _parse_block(lines, 0, -1)
    if pos != len(lines):
        raise PlanError(f"unexpected line: {lines[pos][1]!r}")
    return value


def _parse_block(lines: list[tuple[int, str]], pos: int, parent_indent: int) -> tuple[Any, int]:
    if pos >= len(lines):
        return None, pos
    indent, text = lines[pos]
    if indent <= parent_indent:
        return None, pos
    if text.startswith("- ") or text == "-":
        return _parse_list(lines, pos, indent)
    return _parse_map(lines, pos, indent)


def _parse_map(lines, pos, indent):
    out: dict[str, Any] = {}
    while pos < len(lines):
        ind, text = lines[pos]
        if ind < indent:
            break
        if ind > indent:
            raise PlanError(f"bad indentation near: {text!r}")
        if text.startswith("- "):
            break
        kv = _split_kv(text)
        if not kv:
            raise PlanError(f"expected `key: value`, got: {text!r}")
        key, rest = kv
        pos += 1
        if rest == "":
            child, pos = _parse_block(lines, pos, indent)
            out[key] = child if child is not None else None
        else:
            out[key] = _scalar(rest)
    return out, pos


def _parse_list(lines, pos, indent):
    out: list[Any] = []
    while pos < len(lines):
        ind, text = lines[pos]
        if ind != indent or not (text.startswith("- ") or text == "-"):
            break
        item = text[1:].strip()
        pos += 1
        if item == "":
            child, pos = _parse_block(lines, pos, indent)
            out.append(child)
            continue
        kv = _split_kv(item)
        if kv and not (item.startswith(("'", '"', "[", "{"))):
            # `- key: value` opens a map whose further keys are indented past the dash
            first: dict[str, Any] = {}
            key, rest = kv
            if rest == "":
                child, pos = _parse_block(lines, pos, indent + 1)
                first[key] = child
            else:
                first[key] = _scalar(rest)
            # continuation keys: any following lines indented deeper than the dash, as a map
            if pos < len(lines) and lines[pos][0] > indent and not lines[pos][1].startswith("- "):
                more, pos = _parse_map(lines, pos, lines[pos][0])
                first.update(more)
            out.append(first)
        else:
            out.append(_scalar(item))
    return out, pos


# ---------------------------------------------------------------- plan schema
STAGE_UNITS = {"run", "sample", "once"}
DONE_KINDS = {"file", "dir", "manual", "nextflow"}


def validate(plan: dict[str, Any]) -> list[str]:
    errs: list[str] = []
    if not isinstance(plan, dict):
        return ["plan must be a mapping"]
    for k in ("project", "stages"):
        if k not in plan:
            errs.append(f"missing `{k}`")
    stages = plan.get("stages") or []
    names = set()
    for i, st in enumerate(stages):
        p = f"stages[{i}]"
        if not isinstance(st, dict):
            errs.append(f"{p}: must be a mapping"); continue
        n = st.get("name")
        if not n:
            errs.append(f"{p}: missing name")
        elif n in names:
            errs.append(f"{p}: duplicate name {n}")
        names.add(n)
        if st.get("unit") not in STAGE_UNITS:
            errs.append(f"{p}: unit must be one of {sorted(STAGE_UNITS)}")
        done = st.get("done") or {}
        kind = done.get("kind", "file")
        if kind not in DONE_KINDS:
            errs.append(f"{p}: done.kind must be one of {sorted(DONE_KINDS)}")
        if kind in ("file", "dir") and not done.get("path"):
            errs.append(f"{p}: done.path is required for kind={kind}")
        if kind == "nextflow" and not done.get("process"):
            errs.append(f"{p}: done.process (list of Nextflow process names) is required for kind=nextflow")
        if st.get("unit") != "once" and kind in ("file", "dir") and not (st.get("units") or {}).get("file"):
            errs.append(f"{p}: units.file is required for per-{st.get('unit')} file/dir stages")
        for dep in st.get("after") or []:
            if dep not in names:
                errs.append(f"{p}: after={dep} must name an earlier stage")
    for m in plan.get("milestones") or []:
        if not isinstance(m, dict) or not m.get("date") or not m.get("name"):
            errs.append("milestones: each needs date and name")
    return errs


def load_plan(path: str) -> dict[str, Any]:
    with open(path, encoding="utf-8") as f:
        plan = load_yaml(f.read())
    errs = validate(plan)
    if errs:
        raise PlanError("; ".join(errs))
    return plan


def expand_vars(s: str, env: dict[str, str]) -> str:
    """$VAR and ${VAR} from the plan's `paths` block, then the process environment."""
    def rep(m):
        k = m.group(1) or m.group(2)
        return str(env.get(k, os.environ.get(k, m.group(0))))
    return re.sub(r"\$\{(\w+)\}|\$(\w+)", rep, s)


def resolved_paths(plan: dict[str, Any]) -> dict[str, str]:
    """Resolve `paths:` in order so later entries may use earlier ones (like 00_env.sh)."""
    out: dict[str, str] = {}
    for k, v in (plan.get("paths") or {}).items():
        out[k] = expand_vars(str(v), out)
    return out


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) < 2 or argv[0] != "check":
        print(__doc__); return 2
    path = argv[1]
    try:
        plan = load_plan(path)
    except (OSError, PlanError) as e:
        print(f"plan: INVALID — {e}"); return 1
    out = os.path.join(os.path.dirname(os.path.abspath(path)), "plan.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(plan, f, ensure_ascii=False, indent=1)
    print(f"plan: OK — {plan['project']}, {len(plan['stages'])} stages → {out}")
    for st in plan["stages"]:
        print(f"  {st['name']:<10} unit={st['unit']:<7} where={st.get('where','?'):<6} done={ (st.get('done') or {}).get('path','(manual)') }")
    return 0


if __name__ == "__main__":
    sys.exit(main())
