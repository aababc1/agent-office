"""office-probe — read a compute site's logs and report project progress. Nothing is installed.

Sources (each optional; whatever exists is used):
  * Nextflow trace.txt   one line per finished task → per-process done/failed, durations, last activity
  * Nextflow work/       .command.begin without .exitcode → tasks in flight right now
  * .nextflow.log        run start/end, "Submitted process", "Error executing process"
  * plan.yaml stage markers   done files/dirs per run/sample (+ mtime = completion time), FAILED logs
  * squeue -u <user>     my Slurm jobs: RUNNING / PENDING and the pending reason
  * sinfo                partition availability: idle vs allocated nodes → "can more be submitted?"

Output: the same pipeline progress model office-emit writes (pipeline/<run>/progress.json + summary.json),
plus `cluster` (squeue/sinfo) and `nextflow` (per-process) blocks, and an ETA per stage from the
completion rate of the last few hours.

  office-probe once --plan plan.yaml --to https://…workers.dev   (OFFICE_TOKEN)   # or --to DATA_DIR
  office-probe loop --plan plan.yaml --every 300 --to …                            # tmux/nohup on the login node
Dependency-free (python3 ≥ 3.8). Login-node friendly: stat() calls and log reads only.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from typing import Any

from .emit import RunStore, iso, post
from .plan import expand_vars, load_plan, resolved_paths, stages_for_site

RATE_WINDOWS_H = (3, 12, 48)


# ---------------------------------------------------------------- helpers
def _read_lines(path: str) -> list[str]:
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return [l.rstrip("\n") for l in f]
    except OSError:
        return []


def _run(cmd: list[str], timeout: int = 20) -> str | None:
    if not shutil.which(cmd[0]):
        return None
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    except (subprocess.SubprocessError, OSError):
        return None


def _parse_ts(s: str) -> float | None:
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(s.strip(), fmt).timestamp()
        except ValueError:
            pass
    return None


def _dur(s: str) -> float | None:
    """Nextflow duration like '1h 23m 4s', '4.5s', '850ms' → seconds."""
    if not s or s == "-":
        return None
    total, found = 0.0, False
    for num, unit in re.findall(r"([\d.]+)\s*(ms|[dhms])", s):
        found = True
        total += float(num) * {"d": 86400, "h": 3600, "m": 60, "s": 1, "ms": 0.001}[unit]
    return total if found else None


def _pct(values: list[float], q: float) -> float | None:
    if not values:
        return None
    v = sorted(values)
    return v[min(len(v) - 1, int(q * len(v)))]


# ---------------------------------------------------------------- Nextflow
def read_trace(path: str) -> list[dict[str, Any]]:
    lines = _read_lines(path)
    if not lines:
        return []
    header = lines[0].split("\t")
    out = []
    for l in lines[1:]:
        if not l.strip():
            continue
        row = dict(zip(header, l.split("\t")))
        name = row.get("name", "")
        m = re.match(r"^(.*?)\s*\((.*)\)\s*$", name)
        proc = row.get("process") or (m.group(1) if m else name)
        row["_process"] = proc.split(":")[-1]              # strip workflow prefixes
        row["_tag"] = row.get("tag") or (m.group(2) if m else "")
        row["_complete"] = _parse_ts(row.get("complete", "") or "") or _parse_ts(row.get("start", "") or "")
        row["_submit"] = _parse_ts(row.get("submit", "") or "")
        row["_realtime"] = _dur(row.get("realtime", "") or "")
        row["_status"] = (row.get("status") or "").upper()
        out.append(row)
    return out


def summarize_trace(rows: list[dict[str, Any]]) -> dict[str, Any]:
    procs: dict[str, dict[str, Any]] = {}
    for r in rows:
        p = procs.setdefault(r["_process"], {"done": 0, "failed": 0, "cached": 0, "other": 0, "tags_done": [], "tags_failed": {}, "realtime": [], "lastAt": None, "firstAt": None})
        st = r["_status"]
        if st == "COMPLETED":
            p["done"] += 1; p["tags_done"].append(r["_tag"])
            if r["_realtime"] is not None: p["realtime"].append(r["_realtime"])
        elif st == "CACHED":
            p["cached"] += 1; p["tags_done"].append(r["_tag"])
        elif st in ("FAILED", "ABORTED"):
            p["failed"] += 1; p["tags_failed"][r["_tag"]] = f"{st} exit={r.get('exit', '?')}"
        else:
            p["other"] += 1
        t = r["_complete"]
        if t:
            p["lastAt"] = max(p["lastAt"] or 0, t); p["firstAt"] = min(p["firstAt"] or t, t)
    for p in procs.values():
        rt = p.pop("realtime")
        p["realtimeS"] = {"n": len(rt), "p50": _pct(rt, .5), "p90": _pct(rt, .9)} if rt else None
        p["lastAt"] = iso(p["lastAt"]) if p["lastAt"] else None
        p["firstAt"] = iso(p["firstAt"]) if p["firstAt"] else None
        p["tags_done"] = sorted(set(p["tags_done"]))
    return procs


def inflight_tasks(work_dir: str, limit: int = 2000) -> list[dict[str, Any]]:
    """Nextflow task dirs that began but have no exit code yet. Cheap: two stat() per dir."""
    out = []
    if not work_dir or not os.path.isdir(work_dir):
        return out
    n = 0
    for begin in glob.iglob(os.path.join(work_dir, "??", "*", ".command.begin")):
        n += 1
        if n > limit:
            break
        d = os.path.dirname(begin)
        if os.path.exists(os.path.join(d, ".exitcode")):
            continue
        try:
            started = os.path.getmtime(begin)
        except OSError:
            continue
        proc, tag = "", ""
        for l in _read_lines(os.path.join(d, ".command.run"))[:40]:
            m = re.search(r"NEXTFLOW TASK:\s*(.+)$", l)
            if m:
                nm = m.group(1).strip(); mm = re.match(r"^(.*?)\s*\((.*)\)$", nm)
                proc = (mm.group(1) if mm else nm).split(":")[-1]; tag = mm.group(2) if mm else ""
                break
        out.append({"process": proc, "tag": tag, "startedAt": iso(started), "runningS": int(time.time() - started), "dir": os.path.relpath(d, work_dir)})
    out.sort(key=lambda x: x["startedAt"])
    return out


def read_nextflow_log(path: str) -> dict[str, Any]:
    lines = _read_lines(path)
    if not lines:
        return {}
    info: dict[str, Any] = {"lines": len(lines)}
    first_ts = last_ts = None
    submitted = cached = errors = 0
    last_error = None
    for l in lines:
        m = re.match(r"^(\w{3}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})", l)
        if m:
            last_ts = m.group(1); first_ts = first_ts or last_ts
        if "Submitted process" in l:
            submitted += 1
        elif "Cached process" in l:
            cached += 1
        elif "Error executing process" in l or "ERROR ~" in l:
            errors += 1; last_error = l[-200:]
        if "Pipeline completed" in l or "Execution complete" in l:
            info["completed"] = True
        if "Nextflow" in l and "version" in l and "version" not in info:
            info["version"] = l.strip()[-80:]
    info.update(first=first_ts, last=last_ts, submitted=submitted, cached=cached, errors=errors, lastError=last_error)
    return info


def read_node_loads(pattern: str, now: float, max_age_s: int = 600) -> list[dict[str, Any]]:
    """Node heartbeats written by a node job every minute: iso  host  load1  ncpu  [procA procB chunk].
    util = load1 / ncpu (1.0 = every core busy). Files older than max_age are ignored (the job ended)."""
    import glob as _glob
    out = []
    for f in sorted(_glob.glob(pattern)):
        try:
            if now - os.path.getmtime(f) > max_age_s:
                continue
            parts = _read_lines(f)[0].rstrip("\n").split("\t")
            if len(parts) < 4:
                continue
            load1 = float(parts[2]); ncpu = int(parts[3]) or 1
            out.append({"host": parts[1], "load1": load1, "ncpu": ncpu, "util": round(min(1.0, load1 / ncpu), 3), "at": parts[0],
                        "procs": {"a": int(parts[4]) if len(parts) > 4 and parts[4].isdigit() else None, "b": int(parts[5]) if len(parts) > 5 and parts[5].isdigit() else None},
                        "chunk": parts[6] if len(parts) > 6 else os.path.basename(f)})
        except (OSError, ValueError, IndexError):
            continue
    return out


# ---------------------------------------------------------------- plan stage markers
def _units(path: str) -> list[str]:
    return [l.strip() for l in _read_lines(path) if l.strip() and not l.startswith("#")]


def load_groups(plan: dict[str, Any], paths: dict[str, str]) -> dict[str, dict[str, str]]:
    """plan.groups = {file: $MANIFEST, columns: {run: run_accession, sample: sample_accession, cohort: cohort_accession}}
    → {"run": {run: cohort}, "sample": {sample: cohort}}. A TSV with a header; nothing is parsed out of file names."""
    g = plan.get("groups") or {}
    if not g.get("file"):
        return {}
    cols = g.get("columns") or {}
    gcol = cols.get("cohort") or cols.get("group") or "cohort"
    lines = _read_lines(expand_vars(str(g["file"]), paths))
    if not lines:
        return {}
    header = lines[0].rstrip("\n").split("\t")
    try:
        gi = header.index(gcol)
    except ValueError:
        return {}
    out: dict[str, dict[str, str]] = {}
    for kind in ("run", "sample"):
        col = cols.get(kind)
        if col and col in header:
            ci = header.index(col); m: dict[str, str] = {}
            for l in lines[1:]:
                f = l.rstrip("\n").split("\t")
                if len(f) > max(ci, gi) and f[ci]:
                    m[f[ci]] = f[gi]
            out[kind] = m
    return out


def stage_markers(st: dict[str, Any], paths: dict[str, str], now: float, groups: dict[str, dict[str, str]] | None = None) -> dict[str, Any]:
    done = st.get("done") or {}
    kind = done.get("kind", "file")
    res: dict[str, Any] = {"name": st["name"], "unit": st["unit"], "kind": kind}
    if kind == "manual":
        return res
    if st["unit"] == "once":
        p = expand_vars(done.get("path", ""), paths)
        ok = os.path.isdir(p) if kind == "dir" else os.path.isfile(p)
        res.update(total=1, done=1 if ok else 0, doneAt=[os.path.getmtime(p)] if ok else [])
        return res
    if kind != "file" and kind != "dir":
        return res
    ufile = expand_vars(str((st.get("units") or {}).get("file", "")), paths)
    units = _units(ufile)
    if not units:
        res.update(total=None, done=0, note=f"unit list missing: {os.path.basename(ufile)}")
        return res
    key = "{run}" if st["unit"] == "run" else "{sample}"
    tmpl = expand_vars(done.get("path", ""), paths)
    gmap = (groups or {}).get(st["unit"]) or {}
    if "{cohort}" in tmpl and not gmap:
        res.update(total=len(units), done=0, note="path uses {cohort} but plan.groups gives no mapping")
        return res
    check = os.path.isdir if kind == "dir" else os.path.isfile
    done_at: list[float] = []; done_ids: list[str] = []
    for u in units:
        p = tmpl.replace(key, u)
        if "{cohort}" in p:
            p = p.replace("{cohort}", gmap.get(u, "_"))
        if check(p):
            done_ids.append(u)
            try:
                done_at.append(os.path.getmtime(p))
            except OSError:
                pass
    failed: dict[str, str] = {}
    flog = expand_vars(str((st.get("failed") or {}).get("log", "")), paths)
    if flog:
        for l in _read_lines(flog):
            parts = l.split()
            if parts and parts[0] not in done_ids:
                failed[parts[0]] = " ".join(parts[1:]) or "FAILED"
    res.update(total=len(units), done=len(done_ids), doneIds=done_ids, failed=failed, doneAt=done_at)
    if gmap:   # per-cohort counts: the viewer's 코호트 보드 and "run the next step for finished cohorts"
        per: dict[str, dict[str, int]] = {}
        for u in units:
            c = gmap.get(u, "_"); per.setdefault(c, {"total": 0, "done": 0, "failed": 0})["total"] += 1
        dset = set(done_ids)
        for u in units:
            c = gmap.get(u, "_")
            if u in dset: per[c]["done"] += 1
            elif u in failed: per[c]["failed"] += 1
        res["groups"] = per
    return res


def rates(done_at: list[float], now: float) -> dict[str, Any]:
    out = {}
    for h in RATE_WINDOWS_H:
        n = sum(1 for t in done_at if now - t <= h * 3600)
        out[f"per_h_{h}h"] = round(n / h, 3)
    return out


def eta(remaining: int, done_at: list[float], now: float) -> dict[str, Any] | None:
    """ETA from the best recent rate window that actually saw completions; None if nothing moved."""
    if remaining <= 0:
        return {"hours": 0, "at": iso(now), "basis": "done"}
    for h in RATE_WINDOWS_H:
        n = sum(1 for t in done_at if now - t <= h * 3600)
        if n >= 3:
            rate = n / h
            return {"hours": round(remaining / rate, 1), "at": iso(now + remaining / rate * 3600), "basis": f"{n} done in last {h}h"}
    return None


# ---------------------------------------------------------------- Slurm
def read_squeue(user: str | None) -> dict[str, Any] | None:
    cmd = ["squeue", "-h", "-o", "%i|%P|%j|%T|%M|%l|%D|%R"] + (["-u", user] if user else [])
    out = _run(cmd)
    if out is None:
        return None
    jobs = []
    for l in out.splitlines():
        f = l.split("|")
        if len(f) < 8:
            continue
        jobs.append({"id": f[0], "partition": f[1], "name": f[2], "state": f[3], "time": f[4], "limit": f[5], "nodes": f[6], "reason": f[7]})
    by_state: dict[str, int] = {}
    reasons: dict[str, int] = {}
    for j in jobs:
        by_state[j["state"]] = by_state.get(j["state"], 0) + 1
        if j["state"] == "PENDING":
            r = j["reason"].strip("()"); reasons[r] = reasons.get(r, 0) + 1
    by_name: dict[str, dict[str, int]] = {}
    for j in jobs:
        d = by_name.setdefault(j["name"], {}); d[j["state"]] = d.get(j["state"], 0) + 1
    return {"user": user, "jobs": jobs[:200], "byState": by_state, "pendingReasons": reasons, "byName": by_name, "at": iso(time.time())}


def read_sinfo(partitions: list[str] | None) -> dict[str, Any] | None:
    out = _run(["sinfo", "-h", "-o", "%P|%a|%l|%D|%T"])
    if out is None:
        return None
    # Every partition is reported (the compute hall shows CPU and GPU racks alike); the plan's own
    # partitions are flagged `mine` and are what canSubmit is judged on.
    parts: dict[str, dict[str, Any]] = {}
    for l in out.splitlines():
        f = l.split("|")
        if len(f) < 5:
            continue
        name = f[0].rstrip("*")
        p = parts.setdefault(name, {"avail": f[1], "timelimit": f[2], "nodes": {}, "total": 0,
                                    "mine": (not partitions) or name in partitions, "gpu": "gpu" in name.lower()})
        n = int(f[3] or 0); st = f[4]
        p["nodes"][st] = p["nodes"].get(st, 0) + n; p["total"] += n
    for p in parts.values():
        p["idle"] = p["nodes"].get("idle", 0); p["alloc"] = p["nodes"].get("alloc", 0) + p["nodes"].get("mix", 0)
        p["down"] = sum(v for k, v in p["nodes"].items() if k.rstrip("*~#!%$@^-") in ("down", "drain", "drng", "fail", "maint", "inval", "unk", "unknown"))
    return {"partitions": parts, "at": iso(time.time())}


# ---------------------------------------------------------------- main probe
def probe(plan: dict[str, Any], run_id: str | None = None, site_key: str | None = None) -> dict[str, Any]:
    now = time.time()
    paths = resolved_paths(plan, site_key)
    sites = plan.get("sites") or {}
    site = (sites.get(site_key) if site_key else None) or plan.get("site") or {}
    # the Nextflow run belongs to one site: the plan's default `where`, or a site with its own `pipeline:` block
    pipe = dict(plan.get("pipeline") or {}) if (site_key is None or site_key == plan.get("where")) else {}
    pipe.update(site.get("pipeline") or {})
    my_stages = stages_for_site(plan, site_key)
    report: dict[str, Any] = {"v": 1, "project": plan["project"], "at": iso(now), "site": site.get("name") or site_key, "siteKey": site_key, "stages": {}, "unplanned": {}}

    # 1) Nextflow — `trace`/`work`/`log` may be globs (one run directory per cohort: runs/<stage>/<cohort>/trace.txt)
    trace_path = expand_vars(str(pipe.get("trace", "")), paths) if pipe.get("trace") else ""
    trace_files = sorted(glob.glob(trace_path)) if trace_path else []
    rows: list[dict[str, Any]] = []
    for tf in trace_files:
        rows.extend(read_trace(tf))
    procs = summarize_trace(rows) if rows else {}
    work_pat = expand_vars(str(pipe.get("work", "")), paths) if pipe.get("work") else ""
    inflight: list[dict[str, Any]] = []
    for wd in (sorted(glob.glob(work_pat)) if work_pat else []):
        inflight.extend(inflight_tasks(wd))
    log_pat = expand_vars(str(pipe.get("log", "")), paths) if pipe.get("log") else ""
    log_files = sorted(glob.glob(log_pat), key=lambda f: os.path.getmtime(f)) if log_pat else []
    nflog = read_nextflow_log(log_files[-1]) if log_files else {}
    inflight_by_proc: dict[str, int] = {}
    for t in inflight:
        inflight_by_proc[t["process"]] = inflight_by_proc.get(t["process"], 0) + 1
    report["nextflow"] = {"trace": os.path.basename(trace_path) if trace_path else None, "traceFiles": len(trace_files), "tasks": len(rows), "processes": procs,
                          "inflight": inflight[:100], "inflightByProcess": inflight_by_proc, "log": nflog or None}

    # 2) plan stages: markers first, nextflow mapping second, "implied by later stage" last
    groups = load_groups(plan, paths)
    report["cohorts"] = sorted({c for m in groups.values() for c in m.values()}) if groups else []
    mapped_procs: set[str] = set()
    for st in my_stages:
        name = st["name"]; done = st.get("done") or {}
        s: dict[str, Any] = {"name": name, "desc": st.get("desc"), "unit": st["unit"], "after": st.get("after") or [], "runner": st.get("runner") or {}}
        if done.get("kind") == "nextflow":
            pnames = [p for p in (done.get("process") or [])]
            mapped_procs.update(pnames)
            d = sum(procs.get(p, {}).get("done", 0) + procs.get(p, {}).get("cached", 0) for p in pnames)
            f = sum(procs.get(p, {}).get("failed", 0) for p in pnames)
            tags_done = sorted({t for p in pnames for t in procs.get(p, {}).get("tags_done", [])})
            fails = {t: r for p in pnames for t, r in procs.get(p, {}).get("tags_failed", {}).items() if t not in tags_done}
            total = None
            ufile = (st.get("units") or {}).get("file")
            if ufile:
                units = _units(expand_vars(str(ufile), paths)); total = len(units) or None
            elif st["unit"] == "once":
                total = 1
            last = [procs.get(p, {}).get("lastAt") for p in pnames if procs.get(p, {}).get("lastAt")]
            rt = [procs.get(p, {}).get("realtimeS") for p in pnames if procs.get(p, {}).get("realtimeS")]
            s.update(source="nextflow", processes=pnames, total=total, done=len(tags_done) if tags_done else d, failed=fails,
                     running=sum(inflight_by_proc.get(p, 0) for p in pnames), lastAt=max(last) if last else None,
                     taskS=rt[0] if len(rt) == 1 else ({"p50": _pct([x["p50"] for x in rt if x["p50"]], .5)} if rt else None))
            done_at = [r["_complete"] for r in rows if r["_process"] in pnames and r["_status"] == "COMPLETED" and r["_complete"]]
        else:
            m = stage_markers(st, paths, now, groups)
            s.update(source=m.get("kind"), total=m.get("total"), done=m.get("done", 0), failed=m.get("failed", {}), note=m.get("note"))
            if m.get("groups"): s["groups"] = m["groups"]
            done_at = m.get("doneAt", [])
            s["doneIds"] = m.get("doneIds")
            s["lastAt"] = iso(max(done_at)) if done_at else None
            job = (st.get("runner") or {}).get("job")
            s["running"] = 0  # filled from squeue below when the job name matches
            s["_job"] = job
            # markers say what is done; a Nextflow process (if named) says what is running / failed / how long a task takes
            pnames = [p for p in ((st.get("nextflow") or {}).get("process") or [])]
            mapped_procs.update((st.get("nextflow") or {}).get("aux") or [])      # per-job/per-cohort helpers: known, not counted
            if pnames:
                mapped_procs.update(pnames)
                done_set = set(s.get("doneIds") or []); retrying = {t["tag"] for t in inflight if t["process"] in pnames}
                fails = {t: r for p in pnames for t, r in procs.get(p, {}).get("tags_failed", {}).items() if t not in done_set and t not in retrying}
                s["failed"] = {**(s.get("failed") or {}), **fails}
                s["running"] = sum(inflight_by_proc.get(p, 0) for p in pnames); s["_nf_running"] = True
                rt = [procs.get(p, {}).get("realtimeS") for p in pnames if procs.get(p, {}).get("realtimeS")]
                s["taskS"] = rt[0] if len(rt) == 1 else ({"p50": _pct([x["p50"] for x in rt if x["p50"]], .5)} if rt else None)
                s["processes"] = pnames
            loadglob = (st.get("runner") or {}).get("load")
            if loadglob:
                s["nodes"] = read_node_loads(expand_vars(str(loadglob), paths), now)
                if s["nodes"]:
                    s["cpuUtil"] = round(sum(n["util"] for n in s["nodes"]) / len(s["nodes"]), 3)
        s["rates"] = rates(done_at, now)
        est = (st.get("est") or {}); s["estS"] = est.get("s_per_unit")
        remaining = (s["total"] - s["done"] - len(s.get("failed") or {})) if s.get("total") is not None else None
        s["remaining"] = remaining
        s["eta"] = eta(remaining, done_at, now) if remaining is not None else None
        s["ratio"] = round(s["done"] / s["total"], 4) if s.get("total") else None
        report["stages"][name] = s

    # implied-by: a unit done in a later stage counts as done earlier (markers may have been deleted on purpose)
    stages = report["stages"]
    for st in my_stages:
        imp = st.get("implied_by")
        if imp and imp in stages and st["name"] in stages:
            a, b = stages[st["name"]], stages[imp]
            if a.get("doneIds") is not None and b.get("doneIds"):
                merged = set(a["doneIds"]) | set(b["doneIds"]); a["done"] = len(merged); a["doneIds"] = sorted(merged)
                gm = groups.get(st["unit"]) or {}
                if a.get("groups") and gm:
                    for c in a["groups"].values(): c["done"] = 0
                    for u in merged:
                        c = gm.get(u, "_")
                        if c in a["groups"]: a["groups"][c]["done"] += 1
                a["failed"] = {k: v for k, v in (a.get("failed") or {}).items() if k not in merged}
                if a.get("total"):
                    a["remaining"] = a["total"] - a["done"] - len(a["failed"]); a["ratio"] = round(a["done"] / a["total"], 4)
    for s in stages.values():
        if s.get("doneIds") is not None:
            s["doneIds"] = len(s["doneIds"])           # counts only in the report; ids stay local

    # processes seen in the trace but not mapped to any stage → reported as they are
    for pname, p in procs.items():
        if pname not in mapped_procs:
            report["unplanned"][pname] = {"done": p["done"] + p["cached"], "failed": p["failed"], "running": inflight_by_proc.get(pname, 0), "lastAt": p["lastAt"], "taskS": p["realtimeS"]}

    # 3) Slurm
    has_slurm = bool(site.get("slurm_user")) or shutil.which("squeue") is not None
    sq = read_squeue(site.get("slurm_user") or os.environ.get("USER")) if has_slurm else None
    si = read_sinfo(site.get("partitions")) if has_slurm else None
    if sq:
        for s in stages.values():
            job = s.pop("_job", None)
            if job:   # the runner's job name, or that name with a ":<cohort>" suffix (03_dump_kbds.sh names jobs per BioProject)
                hits = [v for n, v in sq["byName"].items() if n == job or n.startswith(job + ":")]
                if hits:
                    if not s.pop("_nf_running", False):
                        s["running"] = sum(v.get("RUNNING", 0) for v in hits)
                    s["pending"] = sum(v.get("PENDING", 0) for v in hits)
                    s["nodeJobs"] = sum(v.get("RUNNING", 0) for v in hits)
                    s["jobsByCohort"] = {n.split(":", 1)[1]: v for n, v in sq["byName"].items() if n.startswith(job + ":")} or None
    for s in stages.values():
        s.pop("_job", None); s.pop("_nf_running", None)
    report["cluster"] = {"squeue": sq, "sinfo": si,
                         "canSubmit": (any(p["idle"] > 0 for p in si["partitions"].values() if p.get("mine")) if si and si["partitions"] else None)}

    # 4) roll-up
    tot = sum(s["total"] for s in stages.values() if s.get("total")); dn = sum(s["done"] for s in stages.values() if s.get("total"))
    fl = sum(len(s.get("failed") or {}) for s in stages.values())
    running = sum(s.get("running", 0) for s in stages.values()) + sum(n for p, n in inflight_by_proc.items() if p not in mapped_procs)
    last = [s["lastAt"] for s in stages.values() if s.get("lastAt")] + [p["lastAt"] for p in report["unplanned"].values() if p.get("lastAt")]
    report["rollup"] = {"done": dn, "total": tot, "ratio": round(dn / tot, 4) if tot else None, "failed": fl, "running": running,
                        "lastAt": max(last) if last else None, "status": "running" if running else ("idle" if last else "empty")}
    return report


def to_pipeline_state(report: dict[str, Any], run_id: str) -> dict[str, Any]:
    """Shape the viewer/Worker already understand (office-emit's progress.json), with the extra blocks attached."""
    st = {}
    for name, s in report["stages"].items():
        st[name] = {"done": s.get("done", 0), "total": s.get("total"), "unit": s.get("unit"), "failed": len(s.get("failed") or {}),
                    "running": s.get("running", 0), "pending": s.get("pending", 0), "ratio": s.get("ratio"), "eta": s.get("eta"),
                    "rates": s.get("rates"), "lastAt": s.get("lastAt"), "desc": s.get("desc"), "after": s.get("after"),
                    "source": s.get("source"), "note": s.get("note"), "taskS": s.get("taskS"), "updatedAt": report["at"], "groups": s.get("groups"),
                    "nodes": s.get("nodes"), "cpuUtil": s.get("cpuUtil"), "jobsByCohort": s.get("jobsByCohort"), "nodeJobs": s.get("nodeJobs"),
                    "estS": s.get("estS"), "processes": s.get("processes")}
    jobs = {}
    for name, s in report["stages"].items():
        for unit, reason in list((s.get("failed") or {}).items())[:200]:
            jobs[f"{name}:{unit}"] = {"stage": name, "status": "failed", "msg": reason}
    for t in (report.get("nextflow") or {}).get("inflight", [])[:100]:
        jobs[f"{t['process']}:{t['tag']}"] = {"stage": t["process"], "status": "running", "startedAt": t["startedAt"]}
    r = report["rollup"]
    return {"v": 1, "id": run_id, "project": report["project"], "site": report.get("site"), "siteKey": report.get("siteKey"), "startedAt": None, "lastAt": r.get("lastAt") or report["at"],
            "status": r["status"], "stages": st, "jobs": jobs, "notes": [], "counters": {"done": r["done"], "failed": r["failed"]},
            "rollup": r, "cluster": report.get("cluster"), "nextflow": {k: v for k, v in (report.get("nextflow") or {}).items() if k != "inflight"},
            "unplanned": report.get("unplanned"), "probedAt": report["at"], "cohorts": report.get("cohorts") or []}


def deliver(state: dict[str, Any], targets: list[str], token: str | None, project: str,
            plan: dict[str, Any] | None = None, send_plan: bool = False) -> int:
    """Send one probe result. `plan` names the floor's data repo (membership check) and, with send_plan,
    carries the plan itself so stage descriptions show without a separate plan.json push."""
    rc = 0
    repo = (plan or {}).get("repo")
    for t in targets:
        if t.startswith("http"):
            try:
                summary = {"v": 1, "name": project, "emitterAt": iso(time.time()), "sessions": {"total": 0, "active": 0, "latest": None}, "alerts": [],
                           "pipeline": {"run": state["id"], "status": state["status"], "lastAt": state["lastAt"], "done": state["rollup"]["done"], "total": state["rollup"]["total"],
                                        "ratio": state["rollup"]["ratio"], "stages": {k: {"done": v["done"], "total": v["total"], "eta": v.get("eta")} for k, v in state["stages"].items()},
                                        "running": state["rollup"]["running"], "failed": state["rollup"]["failed"], "canSubmit": (state.get("cluster") or {}).get("canSubmit")}}
                if not token:
                    sys.stderr.write("office-probe: OFFICE_TOKEN required for a Worker target\n"); rc = 2; continue
                payload: dict[str, Any] = {"project": project, "pipeline": state, "summary": summary}
                if repo:
                    payload["repo"] = repo                      # the Worker gates the floor by read access to this repo
                if send_plan and plan:
                    payload["plan"] = plan
                post(t, token, payload)
            except Exception as e:  # noqa: BLE001 — keep the loop alive on a login node
                sys.stderr.write(f"office-probe: post failed ({e}); spooling locally\n"); rc = 1
                spool = os.path.join(os.path.expanduser("~"), ".agent-office", "spool"); os.makedirs(spool, exist_ok=True)
                with open(os.path.join(spool, f"{project}.{state['id']}.json"), "w", encoding="utf-8") as f:
                    json.dump(state, f, ensure_ascii=False)
        else:
            store = RunStore(t, project, state["id"]); store.state = state; store.save()
            if send_plan and plan:                              # webhook path picks plan.json up like the Worker does
                with open(os.path.join(t, "plan.json"), "w", encoding="utf-8") as f:
                    json.dump(plan, f, ensure_ascii=False, indent=1)
    return rc


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="office-probe", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mode", choices=["once", "loop", "show"], help="show = print the report, deliver nothing")
    ap.add_argument("--plan", required=True)
    ap.add_argument("--site", default=os.environ.get("OFFICE_SITE"), help="which plan.sites entry this host is (local, kbds, …); only its stages are probed")
    ap.add_argument("--run", default=os.environ.get("OFFICE_RUN"), help="run id (default: the site name)")
    ap.add_argument("--to", action="append", default=None, help="DATA_DIR and/or Worker URL (repeatable; OFFICE_TO)")
    ap.add_argument("--token", default=os.environ.get("OFFICE_TOKEN"))
    ap.add_argument("--every", type=int, default=300, help="seconds between probes in loop mode")
    a = ap.parse_args(argv)
    plan = load_plan(a.plan)
    if a.site and a.site not in (plan.get("sites") or {}):
        sys.stderr.write(f"office-probe: --site {a.site} is not in plan.sites ({', '.join((plan.get('sites') or {}).keys()) or 'none'})\n"); return 2
    run_id = a.run or a.site or "run"
    targets = a.to or ([os.environ["OFFICE_TO"]] if os.environ.get("OFFICE_TO") else [])
    plan_sent_mtime = None                                      # the plan goes along on the first push and whenever plan.yaml changes
    while True:
        report = probe(plan, run_id, a.site)
        state = to_pipeline_state(report, run_id)
        if a.mode == "show":
            print(json.dumps({k: v for k, v in state.items() if k not in ("jobs",)}, ensure_ascii=False, indent=1)); return 0
        if not targets:
            sys.stderr.write("office-probe: --to DATA_DIR or --to https://…worker URL (or OFFICE_TO)\n"); return 2
        try:
            plan_mtime = os.stat(a.plan).st_mtime
        except OSError:
            plan_mtime = None
        send_plan = plan_mtime != plan_sent_mtime
        if send_plan and plan_sent_mtime is not None:
            try:
                plan = load_plan(a.plan)                            # edited while the loop runs → pick it up
            except Exception as e:  # noqa: BLE001
                sys.stderr.write(f"office-probe: plan reload failed ({e}); keeping the previous plan\n"); send_plan = False
        rc = deliver(state, targets, a.token, plan["project"], plan, send_plan)
        if send_plan and rc == 0:
            plan_sent_mtime = plan_mtime
        r = report["rollup"]
        sys.stderr.write(f"[probe] {plan['project']}@{a.site or '-'} {report['at']} done {r['done']}/{r['total']} failed {r['failed']} running {r['running']} canSubmit={(report.get('cluster') or {}).get('canSubmit')} rc={rc}\n")
        if a.mode == "once":
            return rc
        time.sleep(max(30, a.every))


if __name__ == "__main__":
    sys.exit(main())
