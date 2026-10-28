# L-BASIC-02 — How the learning map works

Area: Basics · Kind: module · Study first: L-BASIC-01
Sources: `map.json`; the kit README
Checked against: `main` @ `initial` (starter lesson). Written: starter.

Code paths are counted from the repo root named in the "Checked against" line. A lesson is shared content for every
learner; one person's own notes go in `people/<name>/<ID>.md`.

This is a starter lesson that ships with the kit. Replace it with lessons about your own project.

## 1. Main idea

The learning map is a list of things worth understanding (`map.json`), a lesson for each (`lessons/<ID>.md`) and one
record per person (`people/<name>.json`). A generated page shows the map, the person's levels and what to study next.
Levels change only when the learner confirms them in chat.

## 2. The picture

| File | Holds | Who changes it |
| --- | --- | --- |
| `map.json` | the items, shared | the team |
| `lessons/<ID>.md` | the lesson for one item, shared | the team |
| `people/<name>.json` | one person's levels and evidence | the AI, after the learner confirms |

## 3. Points to remember

- **An item names the items to study first (`prereq`)** · the page suggests an item only when these are understood · see `map.json`.
- **Markers in lessons are configurable** · the exercise heading, the tier names and the hint names come from `competency.markers` · `kit.json:32`.
- **The page is generated, never edited by hand** · rebuild it after any change to the map or a record.

## 4. Easy to get wrong

| People often think | In fact |
| --- | --- |
| Reading a lesson raises my level | Only evidence and your own confirmation do |
| Changing the marker text in one lesson is enough | The checker uses the markers in `kit.json`; all lessons must match them (`kit.json:32`) |

## 5. Prediction questions (ask at the start of a session, before reading the code)

1. An item has two items to study first. One is only "aware". Does the page suggest the item today?
   <details><summary>Answer</summary>No. Both must reach "understand" first.</details>
2. You want a different heading for exercises in your lessons. Where do you set it?
   <details><summary>Answer</summary>`competency.markers.lesson.exercise_heading`, `kit.json:32`.</details>
3. A lesson refers to a file in a second code folder. Which section lists that folder?
   <details><summary>Answer</summary>`repos`, `kit.json:19`.</details>

## 6. Exercises

Answer as `file:key` or a short explanation. Hints open step by step: direction, specific, solution.
For an exercise that edits code, work on a practice copy, not on the working branch.

### Exercise 1 — Understand: read the order of study

Open `map.json` and name the item that has to be studied before this one.

<details><summary>Hint: direction</summary>Look at the item's `prereq` list.</details>
<details><summary>Hint: specific</summary>The list holds item ids.</details>
<details><summary>Solution</summary>`L-BASIC-01`.</details>

### Exercise 2 — Apply: add an item

Predict which three places need a change to add a new item with a lesson, then check by running the lesson checker.

<details><summary>Hint: direction</summary>One shared list, one shared folder, and one generated page.</details>
<details><summary>Hint: specific</summary>The item goes in `map.json`, the lesson in `lessons/<ID>.md` from the template, and the page is rebuilt.</details>
<details><summary>Solution</summary>Add the item to `map.json`, write `lessons/<ID>.md` from `_TEMPLATE.md`, run the lesson checker, then rebuild the page.</details>

### Exercise 3 — Apply advanced: a lesson that fails the checker

A lesson has two exercises and the checker fails it. Give two possible causes and say how you tell them apart.

<details><summary>Hint: direction</summary>The checker prints one line per problem.</details>
<details><summary>Hint: specific</summary>It wants all three tiers, each with all three hint lines.</details>
<details><summary>Solution</summary>Either the third tier is missing ("no exercise with tier ...") or a hint line is missing inside an exercise ("exercise N: no ..."). The message text tells them apart.</details>

## 7. Further reading

- The kit README, section on the learning map.
