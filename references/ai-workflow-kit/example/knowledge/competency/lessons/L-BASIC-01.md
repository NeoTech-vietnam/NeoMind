# L-BASIC-01 — Where the project settings live

Area: Basics · Kind: foundation · Study first: none
Sources: kit.json; the kit README
Checked against: `main` @ `initial` (starter lesson). Written: starter.

Code paths are counted from the repo root named in the "Checked against" line. A lesson is shared content for every
learner; one person's own notes go in `people/<name>/<ID>.md`.

This is a starter lesson that ships with the kit. Replace it with lessons about your own project and delete this
file and its item in `map.json` when you no longer need it.

## 1. Main idea

All project-specific settings of the workflow tools live in one file, `kit.json`, in the project root. The tools read
it, merge it over built-in defaults and resolve every folder under `paths` from the project root. Knowing where a
setting lives tells you where to change it without touching the engine code.

## 2. The picture

| Section of `kit.json` | What it decides |
| --- | --- |
| `people` | who the tools assume when no name is given |
| `paths` | where the knowledge base, the learning map, the memory and the cache folders are |
| `repos` | the code folders that lesson references are checked against |

## 3. Points to remember

- **`people.default` is the person the tools use when you give no name** · it keeps commands short · `kit.json:9`.
- **Every folder in `paths` is relative to the project root** · an absolute path is refused · `kit.json:12`.
- **`repos` lists code folders, each with a name and a path from the project root** · lesson references such as
  `path:line` are resolved against them · `kit.json:19`.

## 4. Easy to get wrong

| People often think | In fact |
| --- | --- |
| The engine folder holds the settings | The engine is replaced on upgrade; settings live only in `kit.json` (`kit.json:12`) |
| A `path` in `repos` may be anywhere | Paths are written relative to the project root (`kit.json:19`) |

## 5. Prediction questions (ask at the start of a session, before reading the code)

1. You run a tool without a person name. Whose record does it read?
   <details><summary>Answer</summary>The one in `people.default`, `kit.json:9`.</details>
2. You move the learning-map folder. Which single line do you change?
   <details><summary>Answer</summary>`paths.competency`, `kit.json:12`.</details>
3. You add a second code folder that lessons refer to. Where do you declare it?
   <details><summary>Answer</summary>Add an entry to `repos`, `kit.json:19`.</details>

## 6. Exercises

Answer as `file:key` or a short explanation. Hints open step by step: direction, specific, solution.
For an exercise that edits code, work on a practice copy, not on the working branch.

### Exercise 1 — Understand: find the cache folder

Find which setting says where scratch files go.

<details><summary>Hint: direction</summary>Look in the `paths` block.</details>
<details><summary>Hint: specific</summary>The block has five entries; one is named after what it holds.</details>
<details><summary>Solution</summary>`paths.cache`, `kit.json:12`.</details>

### Exercise 2 — Apply: rename the learning-map folder

Predict what you must change, and check it by running the learning-map builder afterwards.

<details><summary>Hint: direction</summary>Two things: the setting and the folder on disk.</details>
<details><summary>Hint: specific</summary>Edit `paths.competency` in `kit.json` and move the folder to the new name.</details>
<details><summary>Solution</summary>Change `paths.competency` (`kit.json:12`), move the folder, then run the builder; it reads the new folder.</details>

### Exercise 3 — Apply advanced: two repos with the same file name

Two code folders both contain a file named `main.c`. A lesson refers to that file by its bare name and a line number.
What goes wrong, and how do you fix it?

<details><summary>Hint: direction</summary>A bare file name is looked up among the indexed repos.</details>
<details><summary>Hint: specific</summary>Two hits make the name ambiguous. Either write the path from a repo root or keep one repo out of the index.</details>
<details><summary>Solution</summary>The check reports the reference as ambiguous. Write the reference with its folder (`src/main.c` and the line), or set `"index": false` on the repo in `repos` (`kit.json:19`) that should not take part in bare-name lookups.</details>

## 7. Further reading

- The kit README, section on `kit.json`.
