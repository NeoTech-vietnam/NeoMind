"""Build the learning-map page (catchup.html) from the shared map and one person's record.

    python .aikit/competency/build_catchup.py                  # person = people.default of kit.json
    python .aikit/competency/build_catchup.py --person NAME
    python .aikit/competency/build_catchup.py --out FILE       # default: <competency>/catchup.html
    python .aikit/competency/build_catchup.py --today          # print today's suggestions only

Inputs (<competency>/): map.json (items to learn, shared) and people/<person>.json (that person's levels and
evidence). Output: one self-contained page (filters, progress, today's suggestions). The page text comes from
strings/<ui_lang>.json. The page is read-only: levels change only through people/<person>.json, which the AI updates
after the person confirms a level in chat.

Learning path: map.json `stages` (area names in order; default: the order of `areas`) and optional `pinned_first`
(item id prefixes that always go to the first stage). Standard library only.
"""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import compkit  # noqa: E402
import ids  # noqa: E402

N_TODAY = 3
OPEN_QUESTION = "open-question"


def level_of(records: dict, item_id: str) -> int:
    rec = records.get(item_id) or {}
    return ids.level_index(rec.get("level", ids.LEVELS[0]))


def due_review(records: dict, item_id: str, today: dt.date) -> bool:
    day = (records.get(item_id) or {}).get("review_after")
    return bool(day) and dt.date.fromisoformat(day) <= today


def today_picks(items: list, records: dict, today: dt.date) -> list:
    """Due reviews first, then items below "understand" whose prerequisites are understood, in journey order."""
    due = [it["id"] for it in items if due_review(records, it["id"], today)]
    ready = [it for it in items
             if level_of(records, it["id"]) < ids.UNDERSTOOD
             and all(level_of(records, p) >= ids.UNDERSTOOD for p in it.get("prereq", []))]
    picks = due + [it["id"] for it in ready if it["id"] not in due]
    return picks[:N_TODAY]


def journey(items: list, stages: list, pinned_first: list) -> list:
    """Stages in learning order. An item never sits in an earlier stage than its prerequisites; inside a stage the
    main path is a topological order (map order breaks ties); open questions hang as branches after their
    last prerequisite."""
    by_id = {it["id"]: it for it in items}
    pos = {it["id"]: k for k, it in enumerate(items)}
    pins = tuple(pinned_first)
    st = {it["id"]: 0 if pins and it["id"].startswith(pins) else
          (stages.index(it["area"]) if it["area"] in stages else len(stages) - 1) for it in items}
    changed = True
    while changed:
        changed = False
        for it in items:
            s = max([st[it["id"]]] + [st[p] for p in it.get("prereq", [])])
            if s != st[it["id"]]:
                st[it["id"]], changed = s, True
    out = []
    for k, name in enumerate(stages):
        item_ids = [i for i in st if st[i] == k]
        main = [i for i in item_ids if by_id[i]["kind"] != OPEN_QUESTION]
        branch = [i for i in item_ids if by_id[i]["kind"] == OPEN_QUESTION]
        order, done = [], set()
        while len(order) < len(main):
            ready = [i for i in main if i not in done and
                     all(p in done or p not in main for p in by_id[i].get("prereq", []))]
            nxt = min(ready or [i for i in main if i not in done],
                      key=lambda i: pos[i])
            order.append(nxt)
            done.add(nxt)
        seq = [{"id": i, "branch": False} for i in order]
        for b in sorted(branch, key=lambda i: pos[i]):
            anchors = [n for n, e in enumerate(seq) if e["id"] in by_id[b].get("prereq", [])]
            seq.insert(anchors[-1] + 1 if anchors else len(seq), {"id": b, "branch": True})
        if seq:
            out.append({"name": name, "items": seq})
    return out


def path_items(items: list, stages: list, pinned_first: list) -> list:
    """Main-path items in journey order (branches left out)."""
    by_id = {it["id"]: it for it in items}
    return [by_id[e["id"]] for st in journey(items, stages, pinned_first) for e in st["items"] if not e["branch"]]


def with_lesson(ctx, it: dict, person: str) -> dict:
    """Link the lesson file and the person's notes when they exist; the lesson's exercise headings
    (markers.lesson.exercise_heading) replace the map's seed exercises on the card."""
    S = ctx.strings
    prefix = ctx.markers["lesson"]["exercise_heading"].partition("{n}")[0]
    links = []
    lesson = ctx.comp / "lessons" / f"{it['id']}.md"
    if lesson.exists():
        links.append({"label": S["lesson_link"], "path": f"lessons/{it['id']}.md"})
        heads = [ln.lstrip("#").strip() for ln in lesson.read_text(encoding="utf-8").splitlines()
                 if ln.startswith(prefix)]
        if heads:
            it["exercises"] = heads
    if (ctx.comp / "people" / person / f"{it['id']}.md").exists():
        links.append({"label": S["notes_link"], "path": f"people/{person}/{it['id']}.md"})
    it["sources"] = links + it.get("sources", [])
    return it


def load_map(ctx) -> dict:
    """map.json with kinds and item kinds in English ids (a legacy id is converted and counted)."""
    m = compkit.read_json(ctx.comp / "map.json")
    m["kinds"] = {ids.normalize("kind", k): v for k, v in m.get("kinds", {}).items()}
    m["items"] = [dict(it, kind=ids.normalize("kind", it["kind"])) if "kind" in it else it for it in m["items"]]
    return m


def load_records(ctx, person: str) -> dict:
    pf = ctx.comp / "people" / f"{person}.json"
    p = compkit.read_json(pf) if pf.exists() else {"person": person, "records": {}}
    p["records"] = {k: ids.normalize_record(v) for k, v in p.get("records", {}).items()}
    return p


def learning_path(m: dict) -> tuple:
    stages = m.get("stages") or m["areas"]
    return list(stages), list(m.get("pinned_first", []))


def build(ctx, person: str, out: Path) -> Path:
    S = ctx.strings
    m = load_map(ctx)
    p = load_records(ctx, person)
    records = p["records"]
    stages, pins = learning_path(m)
    today = dt.date.today()
    item_ids = {it["id"] for it in m["items"]}
    for it in m["items"]:
        for q in it.get("prereq", []):
            if q not in item_ids:
                sys.exit(f"{it['id']}: unknown prerequisite {q}")
    data = {
        "project": m.get("project", ""),
        "person": p.get("person", person),
        "kinds": m["kinds"],
        "areas": m["areas"],
        "roots": m.get("roots", {}),
        "levels": S["levels"],
        "items": [with_lesson(ctx, dict(it, level=level_of(records, it["id"]), record=records.get(it["id"], {}),
                                        due=due_review(records, it["id"], today)), person)
                  for it in m["items"]],
        "today": today_picks(path_items(m["items"], stages, pins), records, today),
        "built": today.isoformat(),
        "journey": journey(m["items"], stages, pins),
    }
    page_strings = dict(S, level_ids=ids.LEVELS, kb_cmd=ctx.kb_command)
    page = PAGE.replace("__LANG__", html.escape(ctx.lang))
    page = re.sub(r"__S_([a-z_]+?)__", lambda mo: html.escape(S[mo.group(1)], quote=False), page)
    page = (page.replace("__TITLE__", html.escape(S["page_title"].format(person=data["person"])))
            .replace("__STRINGS__", script_json(page_strings))
            .replace("__DATA__", script_json(data)))
    out.write_text(page, encoding="utf-8")
    return out


def script_json(obj) -> str:
    """JSON safe inside a <script> element."""
    return json.dumps(obj, ensure_ascii=False).replace("</", "<\\/")


PAGE = r"""<!doctype html>
<html lang="__LANG__"><head><meta charset="utf-8"><title>__TITLE__</title>
<style>
/* dark palette: warm charcoal, cream text, clay accent */
:root{--bg:#191a1b;--panel:#222325;--panel2:#2b2c2f;--line:#3a3c40;--text:#c2c0b6;--soft:#9c9a92;--head:#faf9f5;
 --l0:#7a7870;--l1:#d97757;--l2:#d4a85c;--l3:#8fae7e;--l4:#6fa8a0;
 font:14.5px/1.6 system-ui,Segoe UI,Arial;color-scheme:dark}
body{margin:0;background:var(--bg);color:var(--text)}
a{color:#e0a183}
header{padding:14px 22px;background:var(--panel);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:2}
h1{font-size:17px;font-weight:600;margin:0 0 8px;color:var(--head)}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
select,input{padding:4px 6px;border:1px solid var(--line);border-radius:6px;font:inherit;background:var(--bg);color:var(--text)}
main{padding:18px 22px;display:grid;grid-template-columns:320px 1fr;gap:20px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:14px}
.panel h2{font-size:14px;font-weight:600;margin:0 0 8px;color:var(--head)}
.prog{margin:7px 0}.prog .t{display:flex;justify-content:space-between;font-size:12.5px;color:var(--soft)}
.track{height:7px;background:var(--bg);border-radius:4px;overflow:hidden;display:flex}
.track span{display:block;height:100%}
.legend span{display:inline-flex;align-items:center;gap:5px;margin-right:12px;font-size:12.5px}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:14px;align-content:start}
.card{background:var(--panel);border-radius:10px;border:1px solid var(--line);border-left:6px solid var(--c);padding:10px 14px;cursor:pointer}
.card:hover{background:var(--panel2)}
.card.p1{box-shadow:0 0 0 1px rgba(217,119,87,.45) inset}
.card h3{font-size:14px;font-weight:600;margin:4px 0;color:var(--head)}
.meta{font-size:12px;color:var(--soft);display:flex;gap:8px;flex-wrap:wrap}
.tag{background:var(--bg);color:var(--soft);border-radius:10px;padding:0 8px}
.lv{color:#191a1b;font-weight:600;border-radius:10px;padding:0 8px;background:var(--c)}
.det{display:none;margin-top:8px;font-size:13.5px}.card.open .det{display:block}
.det ul{margin:4px 0 6px 18px;padding:0}
button{font:inherit;font-size:12.5px;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:6px;padding:1px 9px;cursor:pointer}
button:hover{background:var(--line)}
.today li{margin-bottom:6px}.due{color:#e08a6a;font-weight:600}
.lock{color:#c9a978;font-size:12px;opacity:.85}
[hidden]{display:none!important}
.tabs{display:flex;gap:6px;margin:0 0 10px}
.tab{border:1px solid var(--line);background:var(--panel2);color:var(--soft);border-radius:16px;padding:2px 14px;cursor:pointer;font-size:13px}
.tab.on{background:#d97757;border-color:#d97757;color:#191a1b;font-weight:600}
#jv{max-width:860px}
.stage{position:relative;padding:0 0 6px 0}
.stage h2{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:600;color:var(--head);margin:6px 0 8px}
.stage h2 .num{width:26px;height:26px;border-radius:50%;background:var(--panel2);border:1px solid var(--line);display:inline-flex;align-items:center;justify-content:center;font-size:12.5px}
.stage h2 .sp{font-size:12px;font-weight:400;color:var(--soft)}
.path{margin-left:12px;border-left:2px solid var(--line);padding:2px 0 14px 0}
.node{position:relative;display:flex;align-items:center;gap:10px;margin:0 0 6px 0;padding:5px 10px 5px 22px;border-radius:8px;cursor:pointer}
.node:hover{background:var(--panel)}
.node::before{content:"";position:absolute;left:-8px;top:50%;width:14px;height:14px;margin-top:-7px;border-radius:50%;background:var(--c);border:2px solid var(--bg)}
.node .nid{font-size:12px;color:var(--soft);min-width:66px}
.node .nt{color:var(--text)}
.node.p1 .nt{color:var(--head);font-weight:600}
.node.branch{margin-left:40px;padding-left:18px;border-left:2px dashed var(--line);border-radius:0 8px 8px 0}
.node.branch::before{left:-9px;width:10px;height:10px;margin-top:-5px;border-radius:2px}
.node.branch .nt{color:var(--soft);font-style:italic}
.node.here{background:rgba(217,119,87,.12);box-shadow:0 0 0 1px rgba(217,119,87,.5) inset}
.here-tag{font-size:11.5px;color:#191a1b;background:#d97757;border-radius:10px;padding:0 8px;margin-left:auto;white-space:nowrap}
.drawer{position:fixed;top:0;right:0;width:440px;max-width:92vw;height:100%;background:var(--panel);border-left:1px solid var(--line);box-shadow:-8px 0 24px rgba(0,0,0,.35);padding:18px;overflow:auto;transform:translateX(105%);transition:transform .18s;z-index:5}
.drawer.on{transform:none}
.drawer .card{border:0;padding:0;cursor:default;background:none}
.drawer .det{display:block}
.drawer .x{float:right}
</style></head><body>
<header><h1 id="h"></h1><div class="tabs"><span class="tab on" data-v="jv">__S_tab_journey__</span><span class="tab" data-v="cards">__S_tab_cards__</span></div><div class="bar" id="bar" hidden>
<select id="fl"><option value="">__S_filter_all_levels__</option></select>
<select id="fa"><option value="">__S_filter_all_areas__</option></select>
<select id="fk"><option value="">__S_filter_all_kinds__</option></select>
<select id="fp"><option value="">__S_filter_all_priorities__</option><option>1</option><option>2</option><option>3</option></select>
<label><input type="checkbox" id="fu"> __S_filter_below_understand__</label>
<label><input type="checkbox" id="fo"> __S_filter_onboarding__</label>
<input id="fq" placeholder="__S_search_placeholder__" size="18"><span id="count" class="meta"></span></div></header>
<main><aside>
<div class="panel today"><h2>__S_today_title__</h2><ol id="today"></ol></div>
<div class="panel"><h2>__S_progress_title__</h2><div id="prog"></div></div>
<div class="panel legend"><h2>__S_legend_title__</h2><div id="legend"></div>
<p class="meta">__S_legend_note__</p></div>
</aside><div><section id="jv"></section><section class="cards" id="cards" hidden></section></div></main>
<div class="drawer" id="drawer"></div>
<script>
const D=__DATA__, S=__STRINGS__, C=["var(--l0)","var(--l1)","var(--l2)","var(--l3)","var(--l4)"], byId={};
const fmt=(t,o)=>t.replace(/\{(\w+)\}/g,(m,k)=>k in o?o[k]:m);
D.items.forEach(i=>byId[i.id]=i);
document.getElementById("h").textContent=fmt(S.heading,{project:D.project,person:D.person,built:D.built});
const opt=(id,vals,lab)=>vals.forEach((v,k)=>{const o=document.createElement("option");o.value=v;o.textContent=lab?lab[k]:v;document.getElementById(id).append(o)});
opt("fl",D.levels.map((_,k)=>k),D.levels); opt("fa",D.areas); opt("fk",Object.keys(D.kinds),Object.values(D.kinds));
document.getElementById("legend").innerHTML=D.levels.map((n,k)=>`<span><i class="dot" style="background:${C[k]}"></i>${n}</span>`).join("");
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const cmdBtn=(text,label)=>`<button data-c="${esc(text)}" onclick="cp(event,this.dataset.c)">${esc(label)}</button>`;
function src(s){if(s.kb)return S.kb_cmd?`${esc(s.label)} ${cmdBtn(S.kb_cmd.split("{id}").join(s.kb),S.copy_kb)}`:esc(s.label);
 const href=(D.roots[s.root]||"")+(s.path||""); return href?`<a href="${encodeURI(href)}" target="_blank">${esc(s.label)}</a>`:esc(s.label)}
function cp(e,t){e.stopPropagation();navigator.clipboard.writeText(t);e.target.textContent=S.copied}
function card(i){const r=i.record||{},ev=(r.evidence||[]).map(x=>`<li>${esc(x.date)} · ${esc(x.exercise)} · ${esc(x.support||"")} → ${esc(D.levels[Math.max(0,S.level_ids.indexOf(x.level))]||"")}</li>`).join("");
 const pre=(i.prereq||[]).map(p=>`<li>${p} · ${esc(byId[p].title)} <span class="lv" style="--c:${C[byId[p].level]}">${D.levels[byId[p].level]}</span></li>`).join("");
 const locked=(i.prereq||[]).some(p=>byId[p].level<2);
 return `<div class="card ${i.priority==1?"p1":""}" style="--c:${C[i.level]}" onclick="this.classList.toggle('open')">
 <div class="meta"><b>${i.id}</b><span class="lv">${D.levels[i.level]}</span><span class="tag">${esc(i.area)}</span><span class="tag">${esc(D.kinds[i.kind]||i.kind)}</span><span class="tag">P${i.priority}</span>${(i.tags||[]).includes("onboarding")?`<span class="tag">${esc(S.onboarding_tag)}</span>`:""}${i.due?`<span class="due">${esc(S.due)}</span>`:""}</div>
 <h3>${esc(i.title)}</h3>${locked?`<div class="lock">${esc(S.lock)}</div>`:""}
 <div class="det"><p>${esc(i.summary)}</p>${pre?`<b>${esc(S.prereq_heading)}</b><ul>${pre}</ul>`:""}
 <b>${esc(S.sources_heading)}</b><ul>${(i.sources||[]).map(s=>`<li>${src(s)}</li>`).join("")}</ul>
 <b>${esc(S.exercises_heading)}</b><ul>${(i.exercises||[]).length?i.exercises.map(x=>`<li>${esc(x)}</li>`).join(""):`<li>${esc(S.exercises_empty)}</li>`}</ul>
 ${ev?`<b>${esc(S.evidence_heading)}</b><ul>${ev}</ul>`:""}${r.gaps?`<b>${esc(S.gaps_heading)}</b><p>${esc(r.gaps)}</p>`:""}
 ${cmdBtn(fmt(S.catchup_command,{id:i.id}),S.copy_command)}</div></div>`}
function render(){const v=id=>document.getElementById(id).value,ch=id=>document.getElementById(id).checked,q=v("fq").toLowerCase();
 const L=D.items.filter(i=>(v("fl")===""||i.level==v("fl"))&&(!v("fa")||i.area==v("fa"))&&(!v("fk")||i.kind==v("fk"))&&(!v("fp")||i.priority==v("fp"))
  &&(!ch("fu")||i.level<2)&&(!ch("fo")||(i.tags||[]).includes("onboarding"))&&(!q||(i.id+i.title+i.summary).toLowerCase().includes(q)))
  .sort((a,b)=>D.areas.indexOf(a.area)-D.areas.indexOf(b.area));
 document.getElementById("cards").innerHTML=L.map(card).join(""); document.getElementById("count").textContent=fmt(S.count,{n:L.length,total:D.items.length})}
["fl","fa","fk","fp","fu","fo","fq"].forEach(id=>document.getElementById(id).addEventListener("input",render));
document.getElementById("today").innerHTML=D.today.length?D.today.map(id=>`<li><b>${id}</b> ${esc(byId[id].title)} ${byId[id].due?`<span class="due">${esc(S.review_again)}</span>`:""} ${cmdBtn(fmt(S.catchup_command,{id:id}),S.copy)}</li>`).join(""):`<li>${esc(S.no_suggestions)}</li>`;
const groups=[[S.all,D.items],...D.areas.map(a=>[a,D.items.filter(i=>i.area==a)]).filter(g=>g[1].length)];
document.getElementById("prog").innerHTML=groups.map(([n,its])=>{const ok=its.filter(i=>i.level>=2).length;
 const seg=[0,1,2,3,4].map(k=>its.filter(i=>i.level==k).length).map((c,k)=>c?`<span style="width:${100*c/its.length}%;background:${C[k]}"></span>`:"").join("");
 return `<div class="prog"><div class="t"><span>${esc(n)}</span><span>${ok}/${its.length}</span></div><div class="track">${seg}</div></div>`}).join("");
render();
const ok=i=>(i.prereq||[]).every(p=>byId[p].level>=2);
let hereId=null;
for(const st of D.journey){for(const e of st.items){const i=byId[e.id];if(!e.branch&&i.level<2&&ok(i)){hereId=i.id;break}}if(hereId)break}
document.getElementById("jv").innerHTML=D.journey.map((st,k)=>{const its=st.items.map(e=>byId[e.id]);const got=its.filter(i=>i.level>=2).length;
 return `<div class="stage"><h2><span class="num">${k+1}</span>${esc(st.name)}<span class="sp">${esc(fmt(S.stage_progress,{got:got,total:its.length}))}</span></h2><div class="path">`+
 st.items.map(e=>{const i=byId[e.id];return `<div class="node ${e.branch?"branch":""} ${i.priority==1?"p1":""} ${i.id==hereId?"here":""}" style="--c:${C[i.level]}" onclick="openD('${i.id}')">
  <span class="nid">${i.id}</span><span class="nt">${esc(i.title)}</span>${i.id==hereId?`<span class="here-tag">${esc(S.here)}</span>`:""}</div>`}).join("")+`</div></div>`}).join("");
function openD(id){const dr=document.getElementById("drawer");dr.innerHTML=`<button class="x" onclick="document.getElementById('drawer').classList.remove('on')">${esc(S.close)}</button>`+card(byId[id]);dr.classList.add("on")}
document.querySelectorAll(".tab").forEach(t=>t.onclick=()=>{document.querySelectorAll(".tab").forEach(x=>x.classList.toggle("on",x==t));
 const v=t.dataset.v;document.getElementById("jv").hidden=v!="jv";document.getElementById("cards").hidden=v!="cards";document.getElementById("bar").hidden=v!="cards"});
</script></body></html>
"""


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--person", default=None, help="default: people.default of kit.json")
    ap.add_argument("--out", default=None, help="output file (default: <competency>/catchup.html)")
    ap.add_argument("--today", action="store_true", help="print today's suggestions and exit, no page build")
    a = ap.parse_args(argv)
    try:
        ctx = compkit.load_context()
    except compkit.ConfigError as exc:
        return compkit.die(str(exc))
    person = a.person or ctx.person
    try:
        if a.today:
            m = load_map(ctx)
            records = load_records(ctx, person)["records"]
            by_id = {it["id"]: it for it in m["items"]}
            stages, pins = learning_path(m)
            for i in today_picks(path_items(m["items"], stages, pins), records, dt.date.today()):
                print(f"{i}  {by_id[i]['title']}")
            return 0
        print(build(ctx, person, Path(a.out) if a.out else ctx.comp / "catchup.html"))
        return 0
    finally:
        ids.flush_warning()


if __name__ == "__main__":
    sys.exit(main())
