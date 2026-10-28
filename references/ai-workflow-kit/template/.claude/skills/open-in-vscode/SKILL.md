---
name: open-in-vscode
description: Open files at exact lines in VS Code from the terminal or from a link, instead of describing where to look. Use when the owner asks to open a file, to see the place in the code, or to read the code themselves; when a lesson, review or report points at `file:line` and the person should read it; and when building a page or message that links to code. Covers the `code -r -g` command, the `vscode://file/...` link, and what to check on a new machine.
---

# Open files in VS Code

When you point at `file:line`, open it for the owner (or give a link) instead of only quoting the line. Read-only:
opening a file never edits, saves or runs anything.

```text
file:line to show ──> code installed? ──> command or link ──> say what you opened ──> owner confirms
                      (check once)       (absolute path)     (you cannot see the screen)
```

## Check once on a new machine

- `code --version` works in the shell. If not, the `code` command is not on PATH. Install it from VS Code (command
  palette: "Shell Command: Install 'code' command in PATH") or add the VS Code `bin` folder to PATH.
- For links: the operating system must hand the `vscode://` scheme to VS Code. The VS Code installer registers it.
  On Windows, `HKCR\vscode\shell\open\command` holds the handler. Test one link by hand before you rely on links.
- Write down in `.claude/memory/MEMORY.md` what you found (path of `code`, whether links work). Do not guess it again.

## Command: `code -r -g <path>:<line>`

```powershell
$r = "C:\work\project"
code -r -g "$r\src\main.c:310" `
       -g "$r\src\util.c:194"
```

- `-r` reuses the open VS Code window. Without it a new window opens. `-g file:line[:col]` jumps to the line.
- Repeat `-g` for several files.
- Use absolute paths, so the command works from any directory.
- In PowerShell the line-continuation mark is a backtick, and nothing may follow it on the line (no trailing space).
- Several lines of the same file: VS Code keeps one tab per file, so only the last `-g` line stays. For the other
  lines give the person the line numbers to jump to (Ctrl+G), or use one link per line (below).
- Side by side comparison of two files: `code --diff a.c b.c`.
- An exit code of 0 only says the command ran. You cannot see the screen. Say what you opened and ask the owner to
  confirm (right tab, right line) before you call it done.

## Link: `vscode://file/<path>:<line>`

```text
vscode://file/C:/work/project/src/main.c:310
```

- Write the path with forward slashes, drive letter first on Windows, then `:<line>` (and `:<col>` if wanted).
- A click on such a link, or `Start-Process "<link>"` on Windows, opens the file at that line. The first click may ask
  for confirmation. Only open links you generated yourself.
- Links work in HTML pages and in a browser that passes the scheme on. Do not count on them in plain chat text. Give the
  `code ...` command there.

## When to use it

- A lesson or walkthrough says "look at `file:line`": give the command or the link, with one line on what to look for.
- A review finding or bug report names a line: offer to open it.
- Build the list from places you opened and checked at the current `HEAD`. Never list a line you did not open.

## Not tested

If you use `code --diff`, `code --add`, `-n`, or a link in another browser, say that you did not test it on this machine.
