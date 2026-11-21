"""langflow ui: watch and drive the runs of a project from the terminal (Textual).

  left    runs of the project (status, current step), refreshed every second
  right   steps of the selected run in run order, coloured by state, with details; the gate question when waiting
  bottom  live log of the selected run
  keys    a approve gate · r reject gate (both ask for an optional note and the run name to confirm)
          x stop (cancel) the run (asks for the run name) · c continue a failed, cut-off or cancelled run
          g open the files the waiting gate shows · t open the selected step's transcript
          p open the live page (.md, Mermaid) · l open the log · q quit

Answering a gate needs a real console, as `langflow approve` does: the UI refuses to start without one, unless the
project sets allow_agent_approval. After an answer the run goes on inside this UI process (worker thread); if you quit
while a step is running, the step is cut off and `langflow continue <run>` re-runs it.
"""
import getpass
import json
import os
import subprocess
import sys
from pathlib import Path

from rich.text import Text
from textual import work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import DataTable, Footer, Header, Input, Label, RichLog, Static

from . import cli, engine, project as projmod, view

STATE_STYLE = {"done": "green", "running": "bold yellow", "waiting": "bold dark_orange", "failed": "bold red",
               "rejected": "grey50", "cancelled": "grey50 italic", "todo": "grey62"}
RUN_STYLE = {"done": "green", "running": "yellow", "waiting": "dark_orange", "failed": "red", "rejected": "grey50",
             "cancelled": "grey50"}


def open_path(p: str | Path):
    p = str(p)
    if sys.platform == "win32":
        os.startfile(p)  # noqa: S606 - opens with the user's default app
    else:
        subprocess.Popen(["xdg-open" if sys.platform != "darwin" else "open", p])


class AnswerScreen(ModalScreen[tuple[str, str] | None]):
    """Ask for an optional note and the run name typed back."""
    CSS = """
    AnswerScreen { align: center middle; }
    #box { width: 90; height: auto; padding: 1 2; border: thick $accent; background: $surface; }
    #box Label { margin-bottom: 1; }
    """

    def __init__(self, run: str, gate: str, question: str, decision: str):
        super().__init__()
        self.run, self.gate, self.question, self.decision = run, gate, question, decision

    def compose(self) -> ComposeResult:
        with Vertical(id="box"):
            yield Label(f"[b]{self.decision.upper()}[/b] gate [b]{self.gate}[/b] of run [b]{self.run}[/b]")
            yield Label(self.question)
            yield Input(placeholder="note (optional), Enter to go on", id="note")
            yield Input(placeholder=f"type the run name ({self.run}) to confirm, Esc to cancel", id="confirm")

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "note":
            self.query_one("#confirm", Input).focus()
            return
        if event.value.strip() == self.run:
            self.dismiss((self.decision, self.query_one("#note", Input).value.strip()))
        else:
            self.notify("Run name does not match; nothing changed", severity="warning")
            self.dismiss(None)

    def key_escape(self) -> None:
        self.dismiss(None)


class StopScreen(ModalScreen[bool]):
    """Confirm a cancel by typing the run name."""
    CSS = """
    StopScreen { align: center middle; }
    #box { width: 90; height: auto; padding: 1 2; border: thick $error; background: $surface; }
    #box Label { margin-bottom: 1; }
    """

    def __init__(self, run: str, status: str, step: str | None):
        super().__init__()
        self.run, self.status, self.step = run, status, step

    def compose(self) -> ComposeResult:
        with Vertical(id="box"):
            yield Label(f"[b]STOP[/b] run [b]{self.run}[/b] ({self.status}, step {self.step})")
            yield Label("A running agent or script is killed; a waiting gate stops waiting. "
                        "`c` (continue) re-runs the cut step later.")
            yield Input(placeholder=f"type the run name ({self.run}) to confirm, Esc to go back", id="confirm")

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.value.strip() == self.run:
            self.dismiss(True)
        else:
            self.notify("Run name does not match; nothing changed", severity="warning")
            self.dismiss(False)

    def key_escape(self) -> None:
        self.dismiss(False)


class LangflowUI(App):
    TITLE = "langflow"
    CSS = """
    #runs { width: 46; border: round $primary; }
    #right { border: round $primary; }
    #steps { height: 1fr; }
    #gate { height: auto; max-height: 6; padding: 0 1; }
    #log { height: 14; border: round $primary; }
    """
    BINDINGS = [
        Binding("a", "answer('approve')", "Approve"),
        Binding("r", "answer('reject')", "Reject"),
        Binding("x", "stop_run", "Stop"),
        Binding("c", "continue_run", "Continue"),
        Binding("g", "gate_files", "Gate files"),
        Binding("t", "transcript", "Transcript"),
        Binding("p", "page", "Page"),
        Binding("l", "open_log", "Log"),
        Binding("q", "quit", "Quit"),
    ]

    def __init__(self, project):
        super().__init__()
        self.project = project
        self.run_id: str | None = None
        self.log_pos = 0
        self.busy: set[str] = set()
        self.step_rows: list[str] = []
        self.sub_title = f"{project.name} — {project.root}"

    def compose(self) -> ComposeResult:
        yield Header()
        with Horizontal():
            yield DataTable(id="runs", cursor_type="row")
            with Vertical(id="right"):
                yield Static("", id="gate")
                yield DataTable(id="steps", cursor_type="row")
        yield RichLog(id="log", wrap=True, markup=False)
        yield Footer()

    def on_mount(self) -> None:
        runs = self.query_one("#runs", DataTable)
        runs.add_columns("run", "workflow", "status", "step")
        steps = self.query_one("#steps", DataTable)
        steps.add_columns("", "step", "kind", "state", "start", "end", "detail")
        self.refresh_all()
        self.set_interval(1.0, self.refresh_all)

    # ------------------------------------------------------------ data

    def statuses(self) -> list[dict]:
        out = []
        d = self.project.runs_dir
        for f in sorted(d.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True) if d.exists() else []:
            try:
                out.append(json.loads(f.read_text(encoding="utf-8")))
            except ValueError:
                continue
        return out

    def refresh_all(self) -> None:
        runs = self.query_one("#runs", DataTable)
        sts = self.statuses()
        keep = runs.cursor_row
        runs.clear()
        for st in sts:
            s = st.get("status", "?")
            busy = " ⟳" if st["run"] in self.busy else ""
            runs.add_row(st["run"], st.get("workflow", ""), Text(f"{view.STATE_ICON.get(s, '')} {s}{busy}",
                         style=RUN_STYLE.get(s, "")), str(st.get("step") or ""), key=st["run"])
        if sts:
            runs.move_cursor(row=min(max(keep, 0), len(sts) - 1))
            sel = sts[runs.cursor_row]["run"]
            if sel != self.run_id:
                self.run_id, self.log_pos = sel, 0
                self.query_one("#log", RichLog).clear()
            self.show_run(next(s for s in sts if s["run"] == self.run_id))

    def show_run(self, st: dict) -> None:
        states, info = view.step_states(st)
        table = self.query_one("#steps", DataTable)
        keep = table.cursor_row
        table.clear()
        self.step_rows = []
        nodes = [n for n in (st.get("graph") or {}).get("nodes", []) if n["kind"] not in ("start", "end")]
        for i, n in enumerate(nodes, 1):
            d, s = info.get(n["id"], {}), states.get(n["id"], "todo")
            table.add_row(str(i), n["id"], view.KIND_LABEL.get(n["kind"], n["kind"]),
                          Text(f"{view.STATE_ICON[s]} {s}", style=STATE_STYLE[s]),
                          (d.get("start") or "")[11:], (d.get("end") or "")[11:], view._detail(d, n)[:110])
            self.step_rows.append(n["id"])
        if nodes:
            table.move_cursor(row=min(max(keep, 0), len(nodes) - 1))
        gate = self.query_one("#gate", Static)
        spend = f"\n{view.totals_line(st['totals'])}" if st.get("totals") else ""
        if st.get("status") == "waiting":
            files = st.get("gate_files") or []
            gate.update(Text.assemble(("WAITING ", "bold dark_orange"), (f"gate {st.get('gate')}: ", "bold"),
                                      st.get("question") or "",
                                      (f"\nread: {', '.join(Path(f).name for f in files)}" if files else ""),
                                      ("   a = approve, r = reject" + (", g = open files" if files else ""),
                                       "italic"), spend))
        elif st.get("status") == "failed":
            gate.update(Text.assemble(("FAILED ", "bold red"), str(st.get("error"))[:300], ("   c = continue", "italic"),
                                      spend))
        elif st.get("status") == "cancelled":
            gate.update(Text.assemble(("CANCELLED ", "bold grey50"), f"at step {st.get('step')}",
                                      ("   c = continue (re-runs that step)", "italic"), spend))
        else:
            gate.update(Text(f"{st.get('status')} · started {st.get('started')} · args {st.get('args')}{spend}"))
        self.tail_log()

    def tail_log(self) -> None:
        p = engine.log_path(self.run_id)
        if not p.exists():
            return
        size = p.stat().st_size
        if size < self.log_pos:
            self.log_pos = 0
        if size > self.log_pos:
            with open(p, "rb") as f:
                f.seek(self.log_pos)
                chunk = f.read()
            self.log_pos = size
            logw = self.query_one("#log", RichLog)
            for line in chunk.decode("utf-8", "replace").splitlines():
                style = "bold dark_orange" if "WAITING" in line else "red" if "failed" in line or "ERROR" in line else ""
                logw.write(Text(line, style=style))

    def on_data_table_row_highlighted(self, event: DataTable.RowHighlighted) -> None:
        if event.data_table.id == "runs" and event.row_key and event.row_key.value != self.run_id:
            self.run_id, self.log_pos = event.row_key.value, 0
            self.query_one("#log", RichLog).clear()
            st = engine.read_status(self.run_id)
            if st:
                self.show_run(st)

    # ------------------------------------------------------------ actions

    def selected(self) -> dict:
        return engine.read_status(self.run_id) if self.run_id else {}

    def action_answer(self, decision: str) -> None:
        st = self.selected()
        if st.get("status") != "waiting":
            self.notify("The selected run is not waiting at a gate", severity="warning")
            return

        def done(res):
            if res:
                self.answer(st["run"], res[0], res[1] or None)
        self.push_screen(AnswerScreen(st["run"], st.get("gate"), st.get("question") or "", decision), done)

    @work(thread=True)
    def answer(self, run: str, decision: str, note: str | None) -> None:
        by = getpass.getuser() if cli._is_console() else "agent"
        self.busy.add(run)
        try:
            state, msg = cli.answer_gate(run, decision, note, by)
        finally:
            self.busy.discard(run)
        self.call_from_thread(self.notify, f"{run}: {state} {msg[:200]}",
                              severity="error" if state in ("failed", "error") else "information")

    def action_stop_run(self) -> None:
        st = self.selected()
        if st.get("status") in (None, "done", "rejected", "cancelled"):
            self.notify(f"Nothing to stop (status {st.get('status')})", severity="warning")
            return

        def done(ok):
            if ok:
                self.stop_run(st["run"])
        self.push_screen(StopScreen(st["run"], st.get("status"), st.get("step")), done)

    @work(thread=True)
    def stop_run(self, run: str) -> None:
        by = getpass.getuser() if cli._is_console() else "agent"
        try:
            state = engine.request_cancel(run, by=by)
        except ValueError as e:
            self.call_from_thread(self.notify, str(e), severity="warning")
            return
        self.call_from_thread(self.notify, f"{run}: {'cancelled' if state == 'cancelled' else 'stop requested'}")

    def action_gate_files(self) -> None:
        st = self.selected()
        files = [f for f in st.get("gate_files") or [] if Path(f).exists()]
        if st.get("status") != "waiting" or not files:
            self.notify("No gate files to open", severity="warning")
            return
        for f in files:
            open_path(f)

    @work(thread=True)
    def action_continue_run(self) -> None:
        st = self.selected()
        if st.get("status") not in ("failed", "running", "stopped", "cancelled"):
            self.call_from_thread(self.notify, "Continue is for a failed, cut-off or cancelled run",
                                  severity="warning")
            return
        self.busy.add(st["run"])
        try:
            state, msg = cli.continue_run(st["run"])
        finally:
            self.busy.discard(st["run"])
        self.call_from_thread(self.notify, f"{st['run']}: {state} {msg[:200]}",
                              severity="error" if state in ("failed", "error") else "information")

    def action_transcript(self) -> None:
        st = self.selected()
        table = self.query_one("#steps", DataTable)
        if not st or not self.step_rows:
            return
        name = self.step_rows[table.cursor_row]
        _, info = view.step_states(st)
        t = info.get(name, {}).get("transcript")
        if t and Path(t).exists():
            open_path(t)
        else:
            self.notify(f"No transcript for step {name}", severity="warning")

    def action_page(self) -> None:
        if self.run_id and engine.page_path(self.run_id).exists():
            open_path(engine.page_path(self.run_id))

    def action_open_log(self) -> None:
        if self.run_id and engine.log_path(self.run_id).exists():
            open_path(engine.log_path(self.run_id))

    def action_quit(self) -> None:
        if self.busy:
            self.notify(f"Run(s) still going: {', '.join(self.busy)}. Quitting now cuts the running step "
                        "(`langflow continue` re-runs it). Press q again to quit.", severity="warning")
            self.busy = set()
            return
        self.exit()


def main():
    p = projmod.current()
    if not cli._is_console() and not p.allow_agent_approval:
        raise SystemExit("langflow ui needs an interactive console (it answers gates). Use Windows Terminal / "
                         "PowerShell, not mintty or an agent shell.")
    LangflowUI(p).run()
