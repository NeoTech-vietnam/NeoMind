# NeoMind — chuyển sang Windows

Branch: `hieu/adaptive-agent-flow`. Đọc [AGENTS.md](AGENTS.md) trước; trạng thái mới nhất ở [bàn giao 30/10/2026](docs/adaptive-agent-flow/session-handoff-2026-10-30.md).

Thư mục `NeoMind` chứa source và **Git repository độc lập**, không phụ thuộc submodule hoặc đường dẫn máy Linux cũ. Giữ cả thư mục `.git` (ẩn) khi copy. Remote origin dùng HTTPS; đăng nhập GitHub của bạn khi cần fetch/push. Không kèm credentials, node_modules, build outputs hoặc trạng thái runtime local.

## Tiếp tục phát triển

1. Giải nén ZIP vào một thư mục riêng, mở folder `NeoMind` bằng IDE/Codex.
2. Cài Git và Node.js >=22.16 (đã kiểm chứng với Node 22.22.1 trên Linux, 24.18.0 trên Windows).
3. Trong terminal của project:

```powershell
git status
git log -1 --oneline
npm ci
npm run build
npm run build:ui
```

Đọc `docs/adaptive-agent-flow/session-handoff-2026-10-30.md` và `implementation-status.md` trước khi sửa. Những đường dẫn `/home/hieu-tran/...` hoặc `W:projects...` trong tài liệu là bằng chứng của máy cũ; dùng checkout mới của bạn.

`npm test` trên Windows 11 (30/10/2026, Node 24.18.0, Codex CLI 0.166.0): **184 test, 182 pass, 0 fail, 2 skip**. Test skip cần quyền tạo file symlink; bật Developer Mode để chạy đủ. `npm run build:ui` thành công.

## Chạy flow thật trên Windows (native)

Cần Git, Node.js >=22.16 và Codex CLI đã đăng nhập (`npm i -g @openai/codex`). Không cần WSL.

```powershell
npm ci
npm test
npm run build:ui
npm run neomind -- editor C:\path\to\your\git-project
```

Mở URL localhost mà server in ra. Chỉ dùng `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-luna`; không dùng Astra. Chạy inference sử dụng quota tài khoản.

### Dùng Claude Code làm runner

> Đã xác minh bằng CLI trên Windows (30/10/2026) với ba flow Dev chạy tới commit: Claude viết + Codex review, toàn Claude, và crash giữa lượt viết của Claude rồi resume. Chọn runner trên UI mới được kiểm bằng build, chưa chạy thử trên trình duyệt; Linux chưa chạy. Chi tiết: [claude-code-runner.md](docs/adaptive-agent-flow/claude-code-runner.md).

Không dùng UI thì đặt runner mặc định theo vai trò trong `neomind/project.json` (project cũ: `.neomind/project.json`; commit file này để checkout sạch):

```json
"roleDefaults": {
  "implementer": { "runner": "claude-code", "provider": "anthropic", "model": "claude-sonnet-5-5", "reasoning": "medium" },
  "verifier": { "runner": "codex", "provider": "openai", "model": "gpt-6-luna", "reasoning": "medium" }
}
```

Khi tạo run đầu tiên có binding Claude, NeoMind chạy capability probe bằng Haiku (vài lượt ngắn) để chứng minh giới hạn ghi trên máy; kết quả được giữ tới khi process NeoMind (CLI hoặc editor) thoát.

**Cần có**
- Claude Code CLI đã cài (`claude --version`) và đã đăng nhập: `claude auth status` báo logged in.
- Codex CLI vẫn cần: checks luôn chạy qua sandbox của Codex, kể cả khi mọi binding dùng Claude Code. Preview báo lỗi nếu thiếu Codex.

**Chọn runner và model**
- Khi chạy: trong *Xem cấu hình thực tế*, mỗi binding có ô *Runner* (Codex hoặc Claude Code). Đổi runner sẽ đặt model về mặc định của runner đó; bấm *Cập nhật cấu hình* trước khi bắt đầu.
- Trong flow editor: ô *Runner* của binding có *Kế thừa*, *Codex*, *Claude Code*. Khi provider/model đang ghim, đổi runner sẽ chuyển chúng sang giá trị của runner mới.
- Model cho phép: Codex `gpt-6-luna` (mặc định), `gpt-6.1-terra`, `gpt-6.1-sol`; Claude Code `claude-sonnet-5-5` (mặc định), `claude-haiku-5-5`, `claude-opus-5-5`. Mức suy luận: `low`, `medium`, `high`.
- Theo dõi run hiển thị runner và model thực tế của từng bước.

**Giới hạn được áp dụng**
- Writer chỉ có Read/Glob/Grep/Write/Edit; Write/Edit chỉ được phép trong các thư mục ghi đã duyệt. Writer **không có shell**.
- Planner, research và reviewer chỉ đọc.
- Không có sub-agent (Task), MCP, web; settings và CLAUDE.md của user/project bị bỏ qua.
- Model, công cụ và quyền thực tế được đối chiếu ở mỗi lượt; sai lệch thì lượt bị hủy.

Đây là giới hạn do Claude Code tự áp dụng, **không phải sandbox của hệ điều hành** như sandbox Codex. Process vẫn chạy trong worker scope (job object/systemd) để dừng được chắc chắn.

### Cơ chế thay cho systemd

- **Worker scope = Windows job object.** NeoMind chạy helper `neomind-job-<hash>.exe`. Helper tạo job `Global\neomind-run-<uuid>` với kill-on-close, tự vào job, rồi mới khởi động Codex app-server. Mọi tiến trình con và cháu đều thuộc job và không thể thoát ra. Stop chỉ được xác nhận khi job báo còn 0 tiến trình. Nếu NeoMind hoặc helper bị kill, Windows tự kết thúc toàn bộ job.
- **Helper được biên dịch lúc chạy** bằng `csc.exe` của .NET Framework 4, có sẵn trên Windows 10/11, và cache ở `%LOCALAPPDATA%\neomind\bin`. Repo không chứa file binary.
- **Capability probe** kiểm tra sandbox: ghi trong thư mục được phép phải thành công, ghi ra ngoài phải bị chặn. Probe còn chạy một lệnh sandbox kéo dài, dừng job, rồi xác nhận lệnh đó đã chết. Nếu Codex chạy lệnh ngoài job (ví dụ `[windows] sandbox = "elevated"` dùng tài khoản sandbox riêng), probe thất bại và runtime bị chặn. Đã kiểm chứng với `sandbox = "unelevated"`.
- **Định danh scheduler** dùng PID + creation time của tiến trình + `BootId` trong registry thay cho `/proc`.
- State nằm ở `%LOCALAPPDATA%\neomind\<project-key>`.

### Lưu ý khi viết checks

Checks chạy dạng argv, không qua shell. Tên lệnh không có đuôi (`npm`) được tìm qua PATHEXT thành `npm.cmd`. Tham số cho file `.cmd`/`.bat` không được chứa `% ! ^ & | < > "`. Không dùng builtin POSIX như `test -f`; planner được nhắc điều này khi chạy trên Windows.

Git `core.autocrlf=true` làm worktree có CRLF. Review evidence so khớp theo dòng, không phân biệt CRLF/LF.

### Giới hạn còn lại trên Windows

- Flow Dev đầy đủ (plan → duyệt → write → `npm test` → review → commit) đã chạy thật trên Windows, kể cả Ctrl+C giữa chừng rồi resume. Chi tiết trong `docs/adaptive-agent-flow/implementation-status.md`. Commit nằm trên detached worktree của run, xem bằng `git worktree list` và merge/cherry-pick thủ công.
- Job object không chặn được tiến trình do dịch vụ hệ thống tạo thay cho worker (WMI, Task Scheduler, COM out-of-proc). Đây là cùng loại giới hạn với systemd. Sandbox của Codex là lớp chặn chính.
- Git subprocess (commit) vẫn dùng timeout/AbortSignal như trên Linux, chưa đặt trong job.

WSL2 + systemd vẫn dùng được như trước nếu muốn giữ đường chạy Linux.

## Trạng thái và phạm vi

Đã xác minh default Codex flow trên Linux: plan → duyệt → write → checks → independent review → local commit. Trên Windows đã xác minh cùng flow bằng CLI, kể cả Ctrl+C rồi resume; chưa chạy flow qua UI editor trên Windows. V1 đầy đủ chưa xong: nhiều writer/tích hợp nhánh, current/shared checkout, Nimbalyst adapter và acceptance matrix còn việc. Kế hoạch tiếp theo được ghi trong handoff.

Không kèm runtime state/memory của project khác, fixture tạm hoặc dữ liệu NeoPlayground. Muốn tiếp tục một run cũ cần chuyển state riêng; ZIP này dùng để tiếp tục **phát triển NeoMind**.
