#!/usr/bin/env python3
"""Analyze an EventRecorder shadow-log dump (the JSON from the "Dump Shadow
Event Buffer" command, or a pre_event_window).

Usage:
    python analyze_log.py <path-to-dump.json>

Prints a struggle-oriented readout: event mix, noise/flicker, idle gaps,
focus/googling episodes, diagnostic persistence, edit thrash, terminal runs,
and hint anchors. No thresholds decide "stuck" — it surfaces facts for you.
"""
import json
import sys
from collections import Counter


def load(path):
    with open(path, encoding="utf-8") as fh:
        d = json.load(fh)
    return d["events"] if isinstance(d, dict) and "events" in d else d


def pct(n, d):
    return f"{(n / d * 100):.0f}%" if d else "n/a"


# Events that imply the user is actively present (reset engagement). Diagnostics
# are excluded — the TS server emits them in the background without user action.
ACTIVITY_KINDS = {
    "edit", "selection_change", "save", "editor_switch",
    "terminal_exec_start", "terminal_exec_end", "struggle_reported",
}


def engagement(ev):
    """Split wall-clock into engaged vs idle using the window_state.active bit
    (VS Code's own inactivity flag — no threshold we invent) plus any user
    activity event. Returns (engaged_s, idle_s). This is the denominator that
    makes every other rate meaningful: a 12h span that is 93% idle must not be
    read as 12h of work."""
    engaged = idle = 0
    last = ev[0]["ts"]
    active = True
    for e in ev:
        dt = (e["ts"] - last) / 1000.0
        if active:
            engaged += dt
        else:
            idle += dt
        last = e["ts"]
        if e["kind"] == "window_state":
            active = bool(e["meta"].get("active"))
        elif e["kind"] in ACTIVITY_KINDS:
            active = True
    return engaged, idle


def main(path):
    ev = load(path)
    if not ev:
        print("empty log")
        return
    n = len(ev)
    span = (ev[-1]["ts"] - ev[0]["ts"]) / 1000.0
    print(f"events={n}  span={span:.0f}s ({span/60:.1f} min)  "
          f"rate={n/span*60:.1f}/min" if span else f"events={n}")

    kinds = Counter(e["kind"] for e in ev)
    print("\n=== event mix ===")
    for k, c in kinds.most_common():
        print(f"  {k:22s} {c:5d}  {pct(c, n)}")

    # --- engagement: the denominator for everything else ---
    engaged_s, idle_s = engagement(ev)
    print("\n=== engagement (active-bit segmentation) ===")
    print(f"  wall-clock : {span/60:7.1f} min")
    print(f"  engaged    : {engaged_s/60:7.1f} min  ({pct(engaged_s, span)})  <- use THIS as denominator")
    print(f"  idle/away  : {idle_s/60:7.1f} min  ({pct(idle_s, span)})  (breaks, overnight - not work)")

    # --- focus-out, BUCKETED by duration (never summed: a 6h focus-out is a
    #     break, not research). Buckets are descriptive, not struggle thresholds.
    ws = [e for e in ev if e["kind"] == "window_state"]
    if ws:
        away, start = [], None
        for e in ws:
            f = e["meta"].get("focused")
            if f is False and start is None:
                start = e["ts"]
            elif f is True and start is not None:
                away.append((e["ts"] - start) / 1000.0)
                start = None
        glance = [d for d in away if d <= 30]
        research = [d for d in away if 30 < d <= 300]
        brk = [d for d in away if d > 300]
        print("\n=== focus-out episodes (bucketed, not summed) ===")
        print(f"  <=30s glance/lookup      : {len(glance):4d}  {sum(glance)/60:6.1f} min")
        print(f"  30s-5m research/context  : {len(research):4d}  {sum(research)/60:6.1f} min")
        print(f"  >5m  break/walked-away   : {len(brk):4d}  {sum(brk)/60:6.1f} min  (NOT research)")
        plausible = sum(glance) + sum(research)
        print(f"  -> plausible lookup/research time: {plausible/60:.1f} min "
              f"({pct(plausible, engaged_s)} of engaged)")

    # --- in-editor dwell gaps: pauses NOT explained by a focus change.
    #     Excludes window_state<->window_state pairs (those are alt-tab toggles
    #     already counted in the focus buckets) and breaks >5m. What remains is
    #     genuine thinking/reading-in-editor. Top 12 by duration.
    dwell = []
    for i in range(n - 1):
        gap = (ev[i + 1]["ts"] - ev[i]["ts"]) / 1000.0
        a, b = ev[i]["kind"], ev[i + 1]["kind"]
        if 15 < gap <= 300 and not (a == "window_state" and b == "window_state"):
            dwell.append((gap, a, b))
    dwell.sort(reverse=True)
    print(f"\n=== in-editor dwell gaps (15s-5m, non-focus) : {len(dwell)} total ===")
    for gap, a, b in dwell[:12]:
        print(f"  {gap:5.0f}s  [{a} -> {b}]")
    if not dwell:
        print("  (none)")

    # --- diagnostic persistence ---
    diags = [e for e in ev if e["kind"] == "diagnostic_change"]
    if diags:
        fp = Counter()
        for e in diags:
            for f in e["meta"].get("fingerprints", []):
                fp[f] += 1
        persistent = [(k, c) for k, c in fp.most_common() if c >= 3]
        print("\n=== diagnostics ===")
        print(f"  transition events: {len(diags)}  distinct identities: {len(fp)}")
        print(f"  persistent (>=3 transitions): {len(persistent)}")
        for k, c in persistent[:5]:
            print(f"    {k}: survived {c} transitions  <-- candidate unsolved error")

    # --- edit thrash / paste ---
    edits = [e for e in ev if e["kind"] == "edit"]
    if edits:
        ins = [e["meta"]["inserted_chars"] for e in edits]
        undo = sum(1 for e in edits if e["meta"].get("reason") == "undo")
        big = sum(1 for e in edits if e["meta"]["inserted_chars"] >= 40)
        print("\n=== edits ===")
        print(f"  edits: {len(edits)}  undo: {undo} ({pct(undo, len(edits))})  "
              f"large-insert(>=40c, paste-like): {big}  max_insert: {max(ins)}c")

    # --- terminal runs ---
    term = [e for e in ev if e["kind"] == "terminal_exec_end"]
    if term:
        fails = sum(1 for e in term if e["meta"].get("exit_code") not in (0, None))
        heads = Counter(e["meta"].get("command_head") for e in term)
        print("\n=== terminal runs ===")
        print(f"  finished: {len(term)}  nonzero-exit: {fails}  tools: {dict(heads)}")

    # --- hint anchors + efficacy hint ---
    hints = [e for e in ev if e["kind"] in ("struggle_reported", "hint_shown")]
    if hints:
        print("\n=== intervention anchors ===")
        for e in hints:
            label = e["meta"].get("concept_name", e["meta"]) if e.get("meta") else ""
            print(f"  +{(e['ts']-ev[0]['ts'])/1000:7.0f}s  {e['kind']:18s} {label}")
        # Repeated struggle shortly after a hint = hint likely didn't resolve it.
        reports = [e for e in ev if e["kind"] == "struggle_reported"]
        for a, b in zip(reports, reports[1:]):
            gap = (b["ts"] - a["ts"]) / 60000.0
            if gap <= 5:
                print(f"  ! re-struggled {gap:.1f} min after a prior report "
                      f"-> hint may not have helped")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1])
