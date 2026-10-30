# Bàn giao session — 30/10/2026

Branch `hieu/adaptive-agent-flow`, repo NeoTech-vietnam/NeoMind. Toàn bộ việc ngày 30/10 được gộp vào commit `573cb55` (nằm sau `dd68170` của 29/10). Bàn giao này thay [bàn giao 29/10](session-handoff-2026-10-29.md) về trạng thái hiện tại. Bản 29/10 vẫn đúng về các ràng buộc và bài học lõi (journal, worker scope, evidence, commit). Đọc [AGENTS.md](../../AGENTS.md) trước nếu chưa đọc.

## Đã làm trong ngày

| Phần | Kết quả | Tài liệu |
| --- | --- | --- |
| Thay đổi chưa commit làm input của run; commit chỉ chứa phần của run | Xong, có test | implementation-status |
| Khóa thư viện flow/profile giữa nhiều process; chỉ review lại phần bị ảnh hưởng | Xong, có test | implementation-status |
| Research không trả lời đúng câu hỏi thì bị đánh trượt và được sửa | Xong, đã chạy thật | implementation-status |
| Acceptance matrix đối chiếu bằng chứng | 5/10 đạt, 4 một phần, 1 chưa | acceptance-matrix |
| Claude Code runner (registry không phụ thuộc runner, chọn runner/model theo từng bước) | Chạy thật trên Windows | claude-code-runner |
| UI Runs/inspector, theme tối, design system + mockup bấm được | Xong | docs/design |
| Flow ⇄ JSON Canvas (Nimbalyst, Obsidian); dữ liệu project trong `neomind/` | Xong | README |
| Flow Fast: plan nhanh, tự duyệt, người dùng áp dụng thay đổi | Xong, đã chạy thật | README |
| Transcript agent: hoạt động trực tiếp và xem lại từng session | Xong, đã chạy thật | session-transcripts |
| Dọn worktree của run khi kết quả đã an toàn; `run clean` | Xong | README |
| Extension Nimbalyst: tool `neomind_*` cho mọi lệnh CLI, panel là editor đầy đủ | Chạy thật trong Nimbalyst | nimbalyst-extension |

## Kiểm chứng

- **Windows 11** (Node 24.18, Codex CLI 0.166, Claude Code 2.1.312): `npm test` 184 test, 182 pass, 0 fail, 2 skip (cần quyền symlink: bật Developer Mode). Đã chạy thật Dev, Fast và Research với Codex và Claude, crash rồi resume, UI chụp bằng Edge headless.
- **Trong Nimbalyst** (Electron 43.7, Node 24.21): backend chạy được git, Codex, Claude, Job Object và `node:sqlite`. Session Claude và session Codex đều thấy tool. Run Research start từ session: chạy hết các bước, rồi bị chặn đúng thiết kế vì reviewer trích dẫn không khớp nguyên văn.
- **Linux: chưa chạy lại kể từ 29/10.** Phần mới có thể vướng trên Linux:
  - Claude runner: process scope dùng `systemd-run --user --scope`; probe khả năng Claude chưa chạy trên Linux.
  - Extension Nimbalyst trên Linux: chưa thử.
  - Đường dẫn và lệnh riêng Windows (PATHEXT, `node.exe`) đều có nhánh Linux, nhưng chưa được kiểm.

## Việc đang dở và nên làm tiếp

1. **Linux:** `npm test`, rồi một flow Dev và một flow Fast thật (Codex, sau đó Claude). Ghi kết quả vào implementation-status.
2. **Extension:** báo về session khi run cần duyệt hoặc đã xong (ghép qua `session-runs.jsonl`). Thử Fast/Dev từ session trên một repo demo, kể cả đóng/mở workspace giữa chừng.
3. **Worker Codex nạp cấu hình cá nhân** (`~/.codex/AGENTS.md`, skills) vào lượt chạy, thấy được trong transcript. Cần tách cấu hình Codex riêng cho NeoMind mà vẫn dùng chung đăng nhập.
4. **Writer Claude không có shell** nên không tự chạy check. Cho chạy lệnh check có giới hạn, hoặc dặn rõ trong prompt.
5. Dọn `refs/neomind/<run>/*` cũ theo tuổi; đặt giới hạn tổng cho transcript; đặt tên thread Codex.
6. Lấp acceptance còn thiếu (#2, #4, #5, #7, #10), pilot Calculator. Xem thẻ "Còn lại" trên `neomind-status.canvas`.

## Bài học khi chạy thật (30/10)

- **Windows MAX_PATH.** Worktree của run nằm dưới `%LOCALAPPDATA%\neomind\<hash 64 ký tự>\workspaces\run-<uuid>`, dài hơn checkout. Repo có file nằm sâu thì `git worktree add` lỗi "Filename too long". Mọi lệnh git của NeoMind dùng `core.longpaths=true` qua biến môi trường (`src/workspace/git-env.ts`); đừng gọi git trực tiếp mà bỏ qua nó. Fixture trong test cũng phải có đường dẫn ngắn.
- **Trong Electron, `process.execPath` là app** (`Nimbalyst.exe`). Codex cài qua npm phải chạy bằng `node.exe` tìm trên PATH (`resolveWindowsCodex`).
- **Nimbalyst:**
  - `extension_reload` chỉ nạp lại panel. Backend module chỉ chạy bản mới khi mở lại workspace.
  - Hộp thoại xin quyền chạy native code chỉ hiện khi backend khởi động lúc mở workspace.
  - Cách an toàn: giữ một cửa sổ khác đang mở, đóng riêng cửa sổ workspace rồi mở lại. Thoát hẳn app có thể làm Nimbalyst tự thoát khi khởi động.
- **Panel extension:**
  - Môi trường panel không có `require`. Thư viện CommonJS gọi `require('react')` làm extension không nạp được, biểu tượng biến mất. Thay bằng bản ESM (`extensions/nimbalyst/src/shims`).
  - Electron không có `window.prompt`: dùng `askText` trong `ui/src/dialog.tsx`.
  - CSS của editor phải đặt trong shadow root.
- **Bằng chứng review phải khớp nguyên văn.** Model rẻ hay chép sai đường dẫn dài hoặc bỏ ký tự (`!`). Đã dặn agent Research trích nguồn bằng đường dẫn tương đối. Đừng nới bước kiểm tra để run qua.
- **Editor chạy nền:** dừng lệnh bao ngoài (`npm run …`) không dừng process `node` con. Tìm process theo cổng rồi dừng nó.
- **Công cụ commit của Nimbalyst** (`developer_git_commit_proposal`) commit file theo nội dung trên đĩa. Muốn ngừng theo dõi một file thì chạy `git rm --cached` trước, và đừng đưa file đó vào danh sách.

## Ràng buộc và quy ước

Xem [AGENTS.md](../../AGENTS.md): danh sách model được dùng, quota, không sửa `references/ai-workflow-kit`, `demo/` là chỗ thử trên từng máy, không push nếu chưa được yêu cầu, người dùng duyệt kế hoạch.
