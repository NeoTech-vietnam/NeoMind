"""Run-argument specs for the web forms (argspec.py, GET /api/workflows args / last_args, GET /api/paths)."""
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from langflow import argspec, web
from langflow import project as projmod

DOC = '''Client document.

  langflow start report <run> area=<folder under docs> name=<base file name>
        request=<file with the request, verbatim> sources=<path,path,...> old=t10_309 version=310
        [cover="L2|L3|L4"] [max_items=20] [out_dir=docs/sub] [review_gate=false] [facts=<file.md> checked facts]

Order: not=parsed here
'''


class ArgSpecTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="langflow_argspec_"))
        (self.tmp / "docs" / "sub").mkdir(parents=True)
        (self.tmp / "docs" / "a.md").write_text("x", encoding="utf-8")
        (self.tmp / ".env").write_text("SECRET=1", encoding="utf-8")
        (self.tmp / ".git").mkdir()
        self.p = SimpleNamespace(root=self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_doc_and_args(self):
        mod = SimpleNamespace(__doc__=DOC, REQUIRED=["area", "name", "request", "sources", "old", "version"],
                              ARGS={"cover": {"default": "L3", "help": "cover level"},
                                    "name": {"example": "Report v3"},
                                    "who": {"choices": lambda p: ["a", "b"]}})
        s = {x["key"]: x for x in argspec.specs(self.p, mod, "report")}
        self.assertEqual((s["area"]["kind"], s["area"]["base"], s["area"]["required"]), ("dir", "docs", True))
        self.assertEqual((s["name"]["kind"], s["name"]["help"], s["name"]["example"]), ("text", "base file name",
                                                                                        "Report v3"))
        self.assertEqual(s["request"]["kind"], "path")
        self.assertEqual(s["sources"]["kind"], "paths")
        self.assertEqual((s["old"]["example"], s["version"]["kind"]), ("t10_309", "number"))
        self.assertEqual((s["cover"]["kind"], s["cover"]["choices"], s["cover"]["default"], s["cover"]["source"]),
                         ("choice", ["L2", "L3", "L4"], "L3", "ARGS"))
        self.assertEqual((s["max_items"]["default"], s["max_items"]["required"]), ("20", False))
        self.assertEqual(s["out_dir"]["kind"], "dir")                     # default is an existing folder
        self.assertEqual(s["review_gate"]["choices"], ["true", "false"])
        self.assertEqual(s["facts"]["help"], "file.md checked facts")
        self.assertEqual(s["who"]["choices"], ["a", "b"])
        self.assertNotIn("not", s)                                        # outside the usage block

    def test_required_without_doc(self):
        s = argspec.specs(self.p, SimpleNamespace(__doc__="", REQUIRED=["topic"]), "x")
        self.assertEqual(s, [{"key": "topic", "required": True, "help": None, "kind": "text", "default": None,
                              "choices": None, "example": None, "base": None, "source": "required"}])

    def test_suggest_paths(self):
        r = argspec.suggest_paths(self.p, "")
        self.assertEqual([e["rel"] for e in r["entries"]], ["docs/"])        # .git and .env hidden
        r = argspec.suggest_paths(self.p, "docs/", kind="path")
        self.assertEqual([e["rel"] for e in r["entries"]], ["docs/sub/", "docs/a.md"])
        r = argspec.suggest_paths(self.p, "s", base="docs", kind="dir")
        self.assertEqual([e["rel"] for e in r["entries"]], ["sub/"])
        r = argspec.suggest_paths(self.p, "docs/x.md, docs/a", kind="path")   # list field: the last item
        self.assertEqual([e["rel"] for e in r["entries"]], ["docs/a.md"])
        for bad in ("../x", "C:/x", "docs/../.."):  # a leading / is read as project-relative
            with self.assertRaises(ValueError):
                argspec.suggest_paths(self.p, bad + "/")
        with self.assertRaises(ValueError):
            argspec.suggest_paths(self.p, "", base="..")


class WebArgsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="langflow_argspec_web_"))
        (self.tmp / ".langflow" / "workflows").mkdir(parents=True)
        (self.tmp / ".langflow" / "config.toml").write_text('[project]\nname = "t"\napprover = "me"\n',
                                                            encoding="utf-8")
        (self.tmp / ".langflow" / "workflows" / "report.py").write_text(
            f'"""{DOC}"""\nREQUIRED = ["area"]\n\ndef steps(args):\n    return []\n', encoding="utf-8")
        (self.tmp / "docs").mkdir()
        self.old = os.getcwd()
        os.chdir(self.tmp)
        projmod.set_current(projmod.load(self.tmp))

    def tearDown(self):
        os.chdir(self.old)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_workflows_and_paths(self):
        api = web.Api()
        api.user = "t"
        wf = next(w for w in api.route("GET", ["workflows"], {}, None, "web") if w["name"] == "report")
        self.assertEqual(wf["args"][0]["key"], "area")
        self.assertIsNone(wf["last_args"])
        r = api.route("GET", ["paths"], {"prefix": ["d"]}, None, "web")
        self.assertEqual([e["rel"] for e in r["entries"]], ["docs/"])
        with self.assertRaises(web.ApiError) as e:
            api.route("GET", ["paths"], {"prefix": ["../x/"]}, None, "web")
        self.assertEqual(e.exception.status, 403)


if __name__ == "__main__":
    unittest.main()
