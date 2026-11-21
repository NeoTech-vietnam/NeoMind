"""Timed runs: tasks that start `langflow <args>` at a time of day (used by `langflow schedule` and the web API).

Windows: Task Scheduler tasks in the folder \\langflow\\<project folder name>\\, run as the current user only while
they are logged on. The task runs `cmd /c cd /d "<root>" && "<langflow>" <args> >> "<state_dir>/schedule.log" 2>&1`.
Other systems: not supported here; add_task raises ScheduleError with the crontab line to add by hand.

  list_tasks(project)                              -> [{name, schedule, days, time, next_run, last_run, last_result,
                                                       state, command, args}]
  add_task(project, name, time, days, args)        -> the new task (as list_tasks gives it)
  remove_task(project, name)
Every function raises ScheduleError with a message a person can read.
"""
import json
import os
import re
import shutil
import subprocess

DAY_NAMES = ("MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN")
# MSFT_TaskWeeklyTrigger.DaysOfWeek bits: Sunday = 1, Monday = 2, ... Saturday = 64
DAY_BITS = {"SUN": 1, "MON": 2, "TUE": 4, "WED": 8, "THU": 16, "FRI": 32, "SAT": 64}
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
TIME = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")
# cmd.exe would act on these inside the task's command line; refuse them instead of escaping.
CMD_SPECIAL = set('&|<>^%"\r\n')
MAX_TR = 261                                          # schtasks /TR limit


class ScheduleError(Exception):
    pass


def supported() -> bool:
    return os.name == "nt"


def folder(project) -> str:
    """Task Scheduler folder of the project (no leading or trailing backslash)."""
    return f"langflow\\{project.root.name}"


def norm_days(days: str | list | None) -> str:
    """DAILY, MON-FRI, or a comma list of MON..SUN (in week order)."""
    if days is None or days == "" or days == []:
        return "DAILY"
    if isinstance(days, (list, tuple)):
        days = ",".join(str(d) for d in days)
    d = str(days).strip().upper().replace(" ", "")
    if d in ("DAILY", "*", "ALL"):
        return "DAILY"
    if d in ("MON-FRI", "WEEKDAYS"):
        return "MON-FRI"
    parts = [p[:3] for p in d.split(",") if p]
    bad = [p for p in parts if p not in DAY_NAMES]
    if bad or not parts:
        raise ScheduleError(f"days: {days!r} is not DAILY, MON-FRI or a list like MON,WED,FRI")
    return ",".join(x for x in DAY_NAMES if x in parts)


def norm_time(at: str) -> str:
    m = TIME.match(str(at).strip())
    if not m:
        raise ScheduleError(f"time: {at!r} is not HH:MM (24 h)")
    return f"{int(m.group(1)):02d}:{m.group(2)}"


def check_args(args: list) -> list[str]:
    if not isinstance(args, (list, tuple)) or not args:
        raise ScheduleError("args: give the langflow arguments as a list, e.g. [\"start\", \"daily_plan\", "
                            "\"daily-{date}\"]")
    out = [str(a) for a in args]
    for a in out:
        if not a or set(a) & CMD_SPECIAL:
            raise ScheduleError(f"args: {a!r} is empty or holds one of & | < > ^ % \" (not allowed in a task)")
    return out


def _quote(a: str) -> str:
    return f'"{a}"' if (" " in a or "\t" in a) else a


def command_line(project, args: list[str]) -> str:
    exe = shutil.which("langflow") or "langflow"
    log = project.state_dir / "schedule.log"
    return f'cmd /c cd /d "{project.root}" && "{exe}" {" ".join(_quote(a) for a in args)} >> "{log}" 2>&1'


def crontab_line(project, at: str, days: str, args: list[str]) -> str:
    h, m = at.split(":")
    dow = {"DAILY": "*", "MON-FRI": "1-5"}.get(days) or ",".join(
        str((DAY_NAMES.index(d) + 1) % 7) for d in days.split(","))
    exe = shutil.which("langflow") or "langflow"
    return (f"{int(m)} {int(h)} * * {dow} cd '{project.root}' && '{exe}' "
            f"{' '.join(repr(a) for a in args)} >> '{project.state_dir / 'schedule.log'}' 2>&1")


def parse_args(command: str) -> list[str]:
    """The langflow arguments back from a task's command line (as written by command_line)."""
    m = re.search(r'&& "[^"]+" (.*?) >> "', command or "")
    if not m:
        return []
    return [a.strip('"') for a in re.findall(r'"[^"]*"|\S+', m.group(1))]


# ---------------------------------------------------------------- Windows

_LIST_PS = r"""
$ErrorActionPreference = 'Stop'
$path = $env:LANGFLOW_TASK_PATH
$tasks = @(Get-ScheduledTask -TaskPath $path -ErrorAction SilentlyContinue)
$out = @(foreach ($t in $tasks) {
  $i = $null
  try { $i = $t | Get-ScheduledTaskInfo } catch { }
  $a = @($t.Actions)[0]
  [pscustomobject]@{
    name = $t.TaskName
    state = [string]$t.State
    next_run = if ($i -and $i.NextRunTime) { $i.NextRunTime.ToString('yyyy-MM-dd HH:mm:ss') } else { $null }
    last_run = if ($i -and $i.LastRunTime -and $i.LastRunTime.Year -gt 2000) { $i.LastRunTime.ToString('yyyy-MM-dd HH:mm:ss') } else { $null }
    last_result = if ($i) { [int64]$i.LastTaskResult } else { $null }
    execute = if ($a) { [string]$a.Execute } else { '' }
    arguments = if ($a) { [string]$a.Arguments } else { '' }
    triggers = @(foreach ($g in $t.Triggers) { [pscustomobject]@{
      kind = [string]$g.CimClass.CimClassName; start = [string]$g.StartBoundary
      days = if ($g.PSObject.Properties['DaysOfWeek']) { [int]$g.DaysOfWeek } else { $null } } })
  }
})
ConvertTo-Json -InputObject $out -Depth 5 -Compress
"""


def _ps(script: str, env: dict) -> str:
    exe = shutil.which("powershell") or "powershell"
    r = subprocess.run([exe, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60,
                       env=dict(os.environ, **env), stdin=subprocess.DEVNULL)
    if r.returncode != 0:
        raise ScheduleError(f"Task Scheduler query failed: {(r.stderr or r.stdout).strip()[-400:]}")
    return r.stdout


def _days_of(trigger: dict) -> str:
    kind = trigger.get("kind") or ""
    if "Daily" in kind:
        return "DAILY"
    bits = trigger.get("days")
    if "Weekly" in kind and isinstance(bits, int):
        names = [d for d in DAY_NAMES if bits & DAY_BITS[d]]
        return "MON-FRI" if names == list(DAY_NAMES[:5]) else ",".join(names)
    return kind.replace("MSFT_Task", "").replace("Trigger", "").upper() or "?"


def _result_text(code) -> str | None:
    if code is None:
        return None
    return {0: "ok", 267011: "never run", 267009: "running", 267014: "stopped"}.get(code, f"0x{code & 0xFFFFFFFF:X}")


def list_tasks(project) -> list[dict]:
    if not supported():
        raise ScheduleError("langflow schedule supports Windows Task Scheduler only; on this system add a crontab "
                            "line by hand (`langflow schedule add ...` prints it)")
    raw = _ps(_LIST_PS, {"LANGFLOW_TASK_PATH": f"\\{folder(project)}\\"}).strip()
    data = json.loads(raw) if raw else []
    if isinstance(data, dict):
        data = [data]
    out = []
    for t in data:
        trig = (t.get("triggers") or [{}])[0] or {}
        start = trig.get("start") or ""
        cmd = f"{t.get('execute') or ''} {t.get('arguments') or ''}".strip()
        days = _days_of(trig)
        out.append({"name": t.get("name"), "schedule": "daily" if days == "DAILY" else "weekly", "days": days,
                    "time": start[11:16] if len(start) >= 16 else None, "next_run": t.get("next_run"),
                    "last_run": t.get("last_run"), "last_result": _result_text(t.get("last_result")),
                    "state": (t.get("state") or "").lower() or None, "command": cmd, "args": parse_args(cmd)})
    return sorted(out, key=lambda x: x["name"] or "")


def add_task(project, name: str, time: str, days, args: list) -> dict:
    """Create (or replace) a task. time HH:MM; days DAILY, MON-FRI or MON,WED,...; args = langflow arguments,
    e.g. ["start", "daily_plan", "daily-{date}"] (a run name may use {date} and {time})."""
    if not NAME.match(str(name or "")):
        raise ScheduleError(f"name: {name!r}: use letters, digits, _ . - (max 64)")
    at, d, largs = norm_time(time), norm_days(days), check_args(args)
    if not supported():
        raise ScheduleError("not supported on this system; crontab line (crontab -e):\n"
                            + crontab_line(project, at, d, largs))
    line = command_line(project, largs)
    if len(line) > MAX_TR:
        raise ScheduleError(f"the task command is {len(line)} characters; Task Scheduler (schtasks) takes "
                            f"{MAX_TR} at most. Use shorter arguments.")
    sched = ["/SC", "DAILY"] if d == "DAILY" else ["/SC", "WEEKLY", "/D",
                                                  "MON,TUE,WED,THU,FRI" if d == "MON-FRI" else d]
    project.state_dir.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(["schtasks", "/Create", "/TN", f"{folder(project)}\\{name}", "/TR", line, *sched, "/ST", at,
                        "/F"], capture_output=True, text=True, errors="replace", stdin=subprocess.DEVNULL)
    if r.returncode != 0:
        raise ScheduleError(f"schtasks /Create failed: {(r.stdout + r.stderr).strip()[-400:]}")
    try:
        return next(t for t in list_tasks(project) if t["name"] == name)
    except (StopIteration, ScheduleError):
        return {"name": name, "schedule": "daily" if d == "DAILY" else "weekly", "days": d, "time": at,
                "next_run": None, "last_run": None, "last_result": None, "state": None, "command": line,
                "args": largs}


def remove_task(project, name: str):
    if not NAME.match(str(name or "")):
        raise ScheduleError(f"name: {name!r}: use letters, digits, _ . - (max 64)")
    if not supported():
        raise ScheduleError("not supported on this system; remove the line with crontab -e")
    r = subprocess.run(["schtasks", "/Delete", "/TN", f"{folder(project)}\\{name}", "/F"], capture_output=True,
                       text=True, errors="replace", stdin=subprocess.DEVNULL)
    if r.returncode != 0:
        raise ScheduleError(f"schtasks /Delete failed (no task '{name}'?): {(r.stdout + r.stderr).strip()[-300:]}")
