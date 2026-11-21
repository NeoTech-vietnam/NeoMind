"""Tests for the OpenCode native role and skills (plan langflow-native-skills-plan.md, Phase 3, OpenCode part): the
extended instance config (agents.lf-role, skills dir), the copied skill folders, verify_server / verify_skills /
verify_agent against fake server answers, the session agent and skill rules, the prompt attachments, the loaded
check, the instruction-entry role channel and resume (a new server re-opens the session). No OpenCode process is
started: the server is a fake that answers the V2 API calls.

Run with the langflow tool's Python:
  "%APPDATA%/uv/tools/langflow/Scripts/python.exe" -m unittest tests.test_opencode_native -v
"""
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from langflow import catalog
from langflow.agents import opencode as oc
from langflow.agents.base import AgentError

SKILL_MD = "---\nname: probe\ndescription: test skill\n---\n\nAdd SKILL-CANARY-41 to canaries.\n"
ROLE_MD = "---\nname: probe-role\ndescription: test role\n---\n\nAdd ROLE-CANARY-17 to canaries.\n"
SCHEMA = {"type": "object", "required": ["answer"], "properties": {"answer": {"type": "string"}}}


def make_project(tmp: Path) -> Path:
    (tmp / ".langflow").mkdir(parents=True)
    (tmp / ".langflow/config.toml").write_text("[project]\nname = \"t\"\n", encoding="utf-8")
    sk = tmp / ".agents/skills/probe"
    (sk / "ref").mkdir(parents=True)
    (sk / "SKILL.md").write_text(SKILL_MD, encoding="utf-8")
    (sk / "ref/notes.md").write_text("companion", encoding="utf-8")
    (tmp / ".langflow/agents").mkdir()
    (tmp / ".langflow/agents/probe-role.md").write_text(ROLE_MD, encoding="utf-8")
    return tmp


class FakeServer:
    """Answers the V2 API like an isolated `opencode serve` would, from the config it was given."""

    def __init__(self, tmp: Path, cwd: Path, role_agent=None, skills=None, saved_session=None):
        self.cwd, self.dir = cwd, Path(tempfile.mkdtemp(prefix="inst_", dir=tmp))
        self.config_dir = self.dir / "config" / "opencode"
        self.config_file = self.config_dir / "opencode.json"
        self.skills_dir = self.dir / "skills"
        self.role_agent, self.skills = role_agent, list(skills or [])
        self.skill_bodies = {}
        self.cfg = oc.instance_config(role_agent, str(self.skills_dir) if self.skills else None)
        if self.skills:
            self.skills_dir.mkdir(parents=True)
            oc.Server._copy_skills(self)
        self.calls: list[tuple] = []
        self.sessions: dict[str, dict] = dict(saved_session or {})
        self.timeline: dict[str, list] = {}
        self.fail_put = False
        # what the fake registries report (tests change these)
        self.config_info = self.cfg
        self.skill_list = [{"id": "opencode", "path": "skill://opencode/SKILL.md", "content": "x", "name": "OpenCode"}]
        for s in self.skills:
            self.skill_list.append({"id": s["id"], "name": s["id"], "path": str(self.skills_dir / s["id"] / "SKILL.md"),
                                    "content": self.skill_bodies[s["id"]]})
        self.agent_list = [{"id": "build", "mode": "primary"}]
        if role_agent:
            self.agent_list.append({"id": oc.ROLE_AGENT, "system": role_agent["system"], "mode": "primary"})
        self.entries: list[dict] = []
        self.answer_text = '{"answer": "4"}'
        self.load_skills_skill_message = False
        self.render_body = True                    # False: the attachment text lacks the skill body

    def events(self, on_event):
        pass

    def kill(self):
        pass

    def request(self, method, path, body=None, timeout=30):
        self.calls.append((method, path, body))
        base = path.split("?")[0]
        if base == "/api/info":
            return {"version": oc.VERSION, "pid": 42}
        if base == "/api/config":
            return [{"type": "document", "path": str(self.config_file), "info": self.config_info},
                    {"type": "directory", "path": str(self.config_dir)}]
        if base == "/api/permission/saved":
            return {"data": []}
        if base in ("/api/mcp", "/api/plugin"):
            return {"data": []}
        if base == "/api/skill":
            return {"data": self.skill_list}
        if base == "/api/agent":
            return {"data": self.agent_list}
        if base == "/api/model":
            return {"data": [{"providerID": "openai", "id": "m", "enabled": True, "variants": [{"id": "low"}]}]}
        if base == "/api/session" and method == "POST":
            sid = "ses_new1"
            self.sessions[sid] = {"id": sid, "location": body["location"], "agent": body["agent"],
                                  "model": body["model"], "metadata": body["metadata"],
                                  "permissions": body["permissions"]}
            return {"data": self.sessions[sid]}
        parts = base.split("/")
        if base.startswith("/api/session/") and len(parts) == 4 and method == "GET":
            sid = parts[3]
            if sid not in self.sessions:
                raise AgentError(f"OpenCode GET {base}: HTTP 404")
            return {"data": {**self.sessions[sid], "outcome": "succeeded",
                             "tokens": {"input": 999, "output": 99}, "cost": 0}}
        if base.endswith("/instructions/entries") and method == "GET":
            return {"data": self.entries}
        if "/instructions/entries/" in base and method == "PUT":
            if self.fail_put:
                raise AgentError("OpenCode PUT entries: HTTP 413")
            self.entries = [{"key": parts[-1], "value": body["value"]}]
            return None
        if base.endswith("/prompt"):
            sid = parts[3]
            tl = self.timeline.setdefault(sid, [])
            uid = f"msg_u{len(tl)}"
            user = {"id": uid, "type": "user", "text": body["text"]}
            if body.get("skills"):
                user["skills"] = [{"id": a["id"], "name": a["id"],
                                   "text": f"<skill_content name=\"{a['id']}\">\n# Skill: {a['id']}\n"
                                           f"{self.skill_bodies.get(a['id'], '') if self.render_body else ''}"
                                           f"\n</skill_content>"}
                                  for a in body["skills"]]
            tl.append(user)
            if self.load_skills_skill_message:
                tl.append({"id": "msg_s", "type": "skill", "skill": "probe", "text": self.skill_bodies["probe"]})
            s = self.sessions[sid]
            tl.append({"id": f"msg_a{len(tl)}", "type": "assistant", "agent": s["agent"], "finish": "stop",
                       "model": {"id": s["model"]["id"], "providerID": s["model"]["providerID"],
                                 "variant": s["model"].get("variant")},
                       "content": [{"type": "text", "text": self.answer_text}],
                       "tokens": {"input": 10, "output": 2}, "cost": 0})
            return {"data": {"sessionID": sid, "type": "user", "id": uid}}
        if base.endswith("/wait"):
            return None
        if base.endswith("/message"):
            return {"data": self.timeline.get(parts[3], []), "cursor": {}}
        raise AssertionError(f"unexpected call {method} {path}")


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="lf_ocn_"))
        self.root = make_project(self.tmp / "proj")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.proj = SimpleNamespace(root=self.root, name="t", state_dir=self.tmp / "state", cfg={})
        self.bound = catalog.resolve(self.proj, "opencode", "probe-role", ["probe"], "native")

    def role(self, mode):
        return {**self.bound["role"], "mode": mode}

    def opts(self, mode="prompt", native=True, **kw):
        skills = [dict(s, via="native" if native else "inject") for s in self.bound["skills"]]
        return {"sandbox": "read-only", "effort": "low", "role": self.role(mode), "skills": skills, **kw}

    def server(self, opts, cfg=None, **kw):
        how = oc.delivery(opts, cfg or {})
        src = oc.skill_sources(self.root, how["native"]) if how["native"] else []
        return FakeServer(self.tmp, self.root, how["role_agent"], src, **kw), how

    def session(self, s, how, opts, cfg=None, prompt="PROMPT"):
        said = []
        out = oc._session(self.proj, s, prompt, SCHEMA, self.root, 60, said.append, cfg or {}, "openai", "m",
                          "low", [], False, "run1", "step1", 10 ** 12, opts, how)
        return out, said


class ConfigTests(Base):
    def test_instance_config_plain_is_unchanged(self):
        cfg = oc.instance_config()
        self.assertNotIn("agents", cfg)
        self.assertNotIn("skills", cfg)
        self.assertEqual(cfg["policies"][0], {"action": "plugin.use", "resource": "*", "effect": "deny"})

    def test_instance_config_extended(self):
        cfg = oc.instance_config({"system": "ROLE", "description": "d"}, "C:/inst/skills")
        self.assertEqual(cfg["agents"], {"lf-role": {"system": "ROLE", "mode": "primary", "description": "d"}})
        self.assertEqual(cfg["skills"], ["C:/inst/skills"])
        self.assertEqual(cfg["policies"], oc.instance_config()["policies"])

    def test_server_env_hides_personal_skills(self):
        s = oc.Server("opencode", self.root)
        self.addCleanup(shutil.rmtree, s.dir, True)
        env = s._env()
        self.assertEqual(env["OPENCODE_DISABLE_CLAUDE_CODE"], "1")
        self.assertEqual(env["OPENCODE_TEST_HOME"], str(s.dir / "home"))
        self.assertEqual(s.cfg, oc.instance_config())


class SkillsPlaceTests(Base):
    def test_copies_under_state_dir_when_step_folder_holds_it(self):
        self.assertEqual(oc.skills_parent(self.proj, self.tmp), self.tmp / "state" / "opencode" / "skills")
        self.assertIsNone(oc.skills_parent(self.proj, self.root))      # state dir outside the step's folder
        self.assertIsNone(oc.skills_parent(SimpleNamespace(), self.root))

    def test_server_skill_dir_and_cleanup(self):
        src = oc.skill_sources(self.root, self.bound["skills"])
        parent = self.tmp / "state" / "opencode" / "skills"
        s = oc.Server("opencode", self.root, skills=src, skills_parent=parent)
        self.assertEqual(s.skills_dir, parent / s.dir.name)
        self.assertEqual(s.cfg["skills"], [str(s.skills_dir)])
        s.skills_dir.mkdir(parents=True)
        s._copy_skills()
        self.assertTrue((s.skills_dir / "probe" / "ref" / "notes.md").is_file())
        s.close()                                                     # no process: only the folders go
        self.assertFalse(s.skills_dir.exists())
        self.assertFalse(s.dir.exists())
        plain = oc.Server("opencode", self.root, skills=src)
        self.addCleanup(plain.close)
        self.assertEqual(plain.skills_dir, plain.dir / "skills")


class DeliveryTests(Base):
    def test_modes_to_channels(self):
        self.assertEqual(oc.delivery(self.opts("agent"), {})["channel"], "agent")
        self.assertEqual(oc.delivery(self.opts("prompt"), {})["channel"], "prompt")
        d = oc.delivery(self.opts("append"), {})
        self.assertEqual(d["channel"], "prompt")
        self.assertIn("role_channel prompt", d["note"])
        self.assertEqual(oc.delivery(self.opts("append"), {"role_channel": "instructions"})["channel"], "instructions")
        # role_channel only changes "append"
        self.assertEqual(oc.delivery(self.opts("prompt"), {"role_channel": "instructions"})["channel"], "prompt")

    def test_agent_carries_role_text(self):
        d = oc.delivery(self.opts("agent"), {})
        self.assertIn("ROLE-CANARY-17", d["role_agent"]["system"])
        self.assertEqual(d["role_agent"]["system"], catalog.role_text(self.role("agent")).strip())

    def test_bad_role_channel(self):
        with self.assertRaises(AgentError):
            oc.delivery(self.opts("append"), {"role_channel": "system"})

    def test_native_skills_only(self):
        self.assertEqual([s["id"] for s in oc.delivery(self.opts(native=True), {})["native"]], ["probe"])
        self.assertEqual(oc.delivery(self.opts(native=False), {})["native"], [])
        self.assertEqual(oc.delivery({"skills": []}, {}), {"channel": None, "role_agent": None, "native": []})


class SkillCopyTests(Base):
    def test_sources_and_copy(self):
        src = oc.skill_sources(self.root, self.bound["skills"])
        self.assertEqual([r for _, r in src[0]["files"]], ["SKILL.md", "ref/notes.md"])
        s, _ = self.server(self.opts())
        self.assertEqual((s.skills_dir / "probe/SKILL.md").read_text(encoding="utf-8"), SKILL_MD)
        self.assertEqual((s.skills_dir / "probe/ref/notes.md").read_text(encoding="utf-8"), "companion")
        self.assertEqual(s.skill_bodies["probe"].strip(), "Add SKILL-CANARY-41 to canaries.")

    def test_changed_skill_refused(self):
        src = oc.skill_sources(self.root, self.bound["skills"])
        (self.root / ".agents/skills/probe/SKILL.md").write_text(SKILL_MD + "x", encoding="utf-8")
        with self.assertRaisesRegex(AgentError, "changed after"):
            FakeServer(self.tmp, self.root, None, src)

    def test_outside_paths_refused(self):
        bad = [dict(self.bound["skills"][0], path="../outside/SKILL.md")]
        with self.assertRaises(AgentError):
            oc.skill_sources(self.root, bad)
        # a companion outside the skill folder is not part of the skill
        odd = [dict(self.bound["skills"][0], files=[".langflow/config.toml"])]
        self.assertEqual([r for _, r in oc.skill_sources(self.root, odd)[0]["files"]], ["SKILL.md"])


class VerifyTests(Base):
    def test_extended_config_verified(self):
        s, _ = self.server(self.opts("agent"))
        oc.verify_server(s)                          # no error
        s.config_info = oc.instance_config()          # the server did not load the extension
        with self.assertRaisesRegex(AgentError, "differs"):
            oc.verify_server(s)

    def test_extra_skill_refused(self):
        s, _ = self.server(self.opts())
        s.skill_list.append({"id": "humanizer", "path": "C:/Users/x/.agents/skills/humanizer/SKILL.md",
                             "content": "x"})
        with self.assertRaisesRegex(AgentError, "did not bind: humanizer"):
            oc.verify_skills(s, wait=0)

    def test_unbound_personal_skill_refused_without_native(self):
        s, _ = self.server(self.opts(native=False))
        s.skill_list.append({"id": "pdf", "path": "C:/Users/x/.claude/skills/pdf/SKILL.md", "content": "x"})
        with self.assertRaisesRegex(AgentError, "did not bind: pdf"):
            oc.verify_skills(s, wait=0)

    def test_skill_from_other_path_or_text_refused(self):
        s, _ = self.server(self.opts())
        s.skill_list[1] = {**s.skill_list[1], "path": str(self.root / ".agents/skills/probe/SKILL.md")}
        with self.assertRaisesRegex(AgentError, "not from langflow's copy"):
            oc.verify_skills(s, wait=0)
        s, _ = self.server(self.opts())
        s.skill_list[1] = {**s.skill_list[1], "content": "something else"}
        with self.assertRaisesRegex(AgentError, "differs"):
            oc.verify_skills(s, wait=0)

    def test_missing_skill_and_empty_registry(self):
        s, _ = self.server(self.opts())
        s.skill_list = s.skill_list[:1]
        with self.assertRaisesRegex(AgentError, "did not register"):
            oc.verify_skills(s, wait=0)
        s.skill_list = []
        with self.assertRaisesRegex(AgentError, "did not load"):
            oc.verify_skills(s, wait=0)

    def test_role_agent_checked(self):
        s, _ = self.server(self.opts("agent"))
        oc.verify_agent(s, wait=0)
        s.agent_list[-1] = {**s.agent_list[-1], "system": "other"}
        with self.assertRaisesRegex(AgentError, "differs"):
            oc.verify_agent(s, wait=0)
        s.agent_list = s.agent_list[:1]
        with self.assertRaisesRegex(AgentError, "did not register"):
            oc.verify_agent(s, wait=0)


class RulesAndSessionTests(Base):
    def test_rules_allow_bound_skills_only(self):
        r = oc.rules(False, [], ["probe"])
        self.assertEqual(r[0], {"action": "*", "resource": "*", "effect": "deny"})
        self.assertIn({"action": "skill", "resource": "probe", "effect": "allow"}, r)
        self.assertLess(r.index({"action": "skill", "resource": "probe", "effect": "allow"}),
                        r.index({"action": "read", "resource": "../*", "effect": "deny"}))
        self.assertFalse(any(x["action"] == "skill" for x in oc.rules(False, [])))
        self.assertEqual(oc.rules(True, ["git --version"]), oc.rules(True, ["git --version"], ()))

    def test_verify_session_uses_spec_agent(self):
        spec = {"cwd": str(self.root), "provider": "openai", "model": "m", "variant": None, "agent": "lf-role",
                "metadata": {}, "permissions": []}
        d = {"id": "ses_a", "location": {"directory": str(self.root)}, "agent": "lf-role",
             "model": {"providerID": "openai", "id": "m"}, "metadata": {}, "permissions": []}
        self.assertEqual(oc.verify_session({"data": d}, spec), "ses_a")
        with self.assertRaisesRegex(AgentError, "agent"):
            oc.verify_session({"data": {**d, "agent": "build"}}, spec)
        with self.assertRaisesRegex(AgentError, "agent"):
            oc.verify_session({"data": d}, {**spec, "agent": "build"})

    def test_skills_loaded(self):
        body = "\nAdd SKILL-CANARY-41 to canaries.\n"
        att = [{"type": "user", "skills": [{"id": "probe", "text": f"<skill_content>\n{body}\nBase dir</skill_content>"}]}]
        self.assertEqual(oc.skills_loaded(att, ["probe"], {"probe": body}), ["probe"])
        self.assertEqual(oc.skills_loaded(att, ["probe"], {"probe": "other text"}), [])
        msg = [{"type": "skill", "skill": "probe", "text": body}]
        self.assertEqual(oc.skills_loaded(msg, ["probe", "x"], {"probe": body}), ["probe"])
        self.assertEqual(oc.skills_loaded([{"type": "user", "text": body}], ["probe"], {"probe": body}), [])

    def test_usage_without_totals(self):
        tl = [{"id": "u1", "type": "user"}, {"type": "assistant", "tokens": {"input": 5, "output": 1}},
              {"id": "u2", "type": "user"}, {"type": "assistant", "tokens": {"input": 7, "output": 2}, "cost": 0.5}]
        use, cost = oc.session_usage({"tokens": {"input": 12, "output": 3}, "cost": 9}, tl, "u2", totals=False)
        self.assertEqual((use["input_tokens"], use["output_tokens"], cost), (7, 2, 0.5))
        use, cost = oc.session_usage({"tokens": {"input": 12, "output": 3}, "cost": 9}, tl, "u2")
        self.assertEqual((use["input_tokens"], cost), (12, 9.0))


class SessionFlowTests(Base):
    def test_agent_and_native_fresh(self):
        opts = self.opts("agent")
        s, how = self.server(opts)
        out, said = self.session(s, how, opts)
        post = next(b for m, p, b in s.calls if m == "POST" and p == "/api/session")
        self.assertEqual(post["agent"], "lf-role")
        self.assertIn({"action": "skill", "resource": "probe", "effect": "allow"}, post["permissions"])
        prompt = next(b for m, p, b in s.calls if p.endswith("/prompt"))
        self.assertEqual(prompt["skills"], [{"id": "probe"}])
        self.assertTrue(prompt["text"].startswith("PROMPT"))          # the role is the agent, not a preamble
        self.assertNotIn("ROLE-CANARY-17", prompt["text"])
        self.assertEqual((out["role_channel"], out["skills_loaded"], out["resumed"]), ("agent", ["probe"], False))
        self.assertEqual(out["result"], {"answer": "4"})
        self.assertTrue(any("agent lf-role" in x for x in said))

    def test_prompt_channel_keeps_preamble(self):
        opts = self.opts("prompt", native=False)
        s, how = self.server(opts)
        out, _ = self.session(s, how, opts)
        prompt = next(b for m, p, b in s.calls if p.endswith("/prompt"))
        self.assertIn("ROLE-CANARY-17", prompt["text"])
        self.assertNotIn("skills", prompt)
        self.assertEqual(next(b for m, p, b in s.calls if p == "/api/session")["agent"], "build")
        self.assertEqual((out["role_channel"], out["skills_loaded"]), ("prompt", []))

    def test_native_not_loaded_is_reported(self):
        opts = self.opts("prompt")
        s, how = self.server(opts)
        s.render_body = False
        out, said = self.session(s, how, opts)
        self.assertEqual(out["skills_loaded"], [])
        self.assertTrue(any("not loaded: probe" in x for x in said))

    def test_instructions_channel(self):
        opts, cfg = self.opts("append", native=False), {"role_channel": "instructions"}
        s, how = self.server(opts, cfg)
        out, _ = self.session(s, how, opts, cfg)
        put = next(b for m, p, b in s.calls if m == "PUT")
        self.assertIn("ROLE-CANARY-17", put["value"]["instructions"])
        self.assertTrue(any(p.endswith(f"/instructions/entries/{oc.ROLE_KEY}") for m, p, b in s.calls if m == "PUT"))
        prompt = next(b for m, p, b in s.calls if p.endswith("/prompt"))
        self.assertNotIn("ROLE-CANARY-17", prompt["text"])
        self.assertEqual(out["role_channel"], "instructions")

    def test_instructions_refused_falls_back_to_preamble(self):
        opts, cfg = self.opts("append", native=False), {"role_channel": "instructions"}
        s, how = self.server(opts, cfg)
        s.fail_put = True
        out, said = self.session(s, how, opts, cfg)
        prompt = next(b for m, p, b in s.calls if p.endswith("/prompt"))
        self.assertIn("ROLE-CANARY-17", prompt["text"])
        self.assertEqual(out["role_channel"], "prompt")
        self.assertTrue(any("instruction entry refused" in x for x in said))

    def test_resume_reopens_session(self):
        opts = self.opts("agent")
        s, how = self.server(opts)
        first, _ = self.session(s, how, opts)
        # a new server on the same OpenCode data: the saved session is there
        s2, how2 = self.server(opts, saved_session=s.sessions)
        s2.timeline = s.timeline
        out, said = self.session(s2, how2, {**opts, "resume": first["session"]}, prompt="FEEDBACK")
        self.assertFalse(any(m == "POST" and p == "/api/session" for m, p, b in s2.calls))
        prompt = next(b for m, p, b in s2.calls if p.endswith("/prompt"))
        self.assertNotIn("skills", prompt)
        self.assertTrue(prompt["text"].startswith("FEEDBACK"))
        self.assertEqual((out["session"], out["resumed"], out["skills_loaded"]), (first["session"], True, ["probe"]))
        self.assertEqual(out["usage"]["input_tokens"], 10)             # this call's messages, not the totals (999)
        self.assertTrue(any(x.startswith("resume session") for x in said))

    def test_resume_keeps_instruction_entry(self):
        opts, cfg = self.opts("append", native=False), {"role_channel": "instructions"}
        s, how = self.server(opts, cfg)
        first, _ = self.session(s, how, opts, cfg)
        s2, how2 = self.server(opts, cfg, saved_session=s.sessions)
        s2.timeline, s2.entries = s.timeline, list(s.entries)
        out, _ = self.session(s2, how2, {**opts, "resume": first["session"]}, cfg, prompt="FEEDBACK")
        self.assertFalse(any(m == "PUT" for m, p, b in s2.calls))      # not sent again
        self.assertEqual(out["role_channel"], "instructions")
        s3, how3 = self.server(opts, cfg, saved_session=s.sessions)
        s3.timeline = s.timeline                                       # the entry is gone
        with self.assertRaisesRegex(AgentError, "lost the role instruction entry"):
            self.session(s3, how3, {**opts, "resume": first["session"]}, cfg, prompt="FEEDBACK")

    def test_resume_checks_the_session(self):
        opts = self.opts("agent")
        s, how = self.server(opts)
        first, _ = self.session(s, how, opts)
        changed = {k: {**v, "agent": "build"} for k, v in s.sessions.items()}
        s2, how2 = self.server(opts, saved_session=changed)
        with self.assertRaisesRegex(AgentError, "agent"):
            self.session(s2, how2, {**opts, "resume": first["session"]})
        s3, how3 = self.server(opts)                                   # the session is gone
        with self.assertRaises(AgentError):
            self.session(s3, how3, {**opts, "resume": "ses_gone"})


if __name__ == "__main__":
    unittest.main()
