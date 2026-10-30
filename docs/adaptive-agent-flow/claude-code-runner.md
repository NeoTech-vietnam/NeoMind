# Claude Code runner — kế hoạch triển khai

Ngày: 30/10/2026. Mục tiêu: một flow (Dev, Fast, Research, song song) có thể dùng Claude Code làm runner cho từng binding (planner, writer, reviewer), với cùng bảo đảm như Codex: cấu hình được xác minh, quyền ghi bị giới hạn bởi runtime, không delegation, có stop proof, có journal để phục hồi.

## Kết quả spike (Windows 11, Claude Code 2.1.312, đăng nhập claude.ai, model haiku)

| Câu hỏi | Kết quả |
| --- | --- |
| Transport | `claude.exe -p … --output-format stream-json --verbose`; mỗi lượt là một process, kết thúc khi xong lượt. `claude.exe` native tại `~/.local/bin`, chạy được trong Job Object helper hiện có. |
| Phiên | `--session-id <uuid>` cho lượt đầu, `--resume <uuid>` cho lượt sau; ngữ cảnh giữ nguyên. |
| Xác minh cấu hình | Sự kiện `system/init` có `session_id`, `model` (ví dụ `claude-haiku-5-5`), `tools`, `mcp_servers`, `permissionMode`, `cwd`. |
| Output có cấu trúc | `--json-schema '<schema>'` → `result.structured_output` (thêm tool `StructuredOutput`). |
| Usage | `result.usage` (input/output/cache tokens) và `total_cost_usd` (với subscription chỉ là ước tính). |
| Ghi bằng Write/Edit | `--permission-mode dontAsk` + `permissions.allow: ["Write(allowed/**)", "Edit(allowed/**)"]`: ghi trong scope được, ngoài scope bị từ chối (cả với `acceptEdits`). |
| Shell | Trên Windows công cụ shell là `PowerShell` (`Bash` không xuất hiện). `dontAsk` từ chối mọi lệnh chưa được allowlist. Chặn ghi ngoài của chế độ `sandbox` chỉ là phân tích lệnh, không phải sandbox OS. |
| Delegation / MCP | `--tools` không có `Task` thì không gọi được sub-agent (danh sách `agents` vẫn hiện nhưng không có công cụ gọi). `--strict-mcp-config` → `mcp_servers: []`. |
| Cấu hình người dùng | `--setting-sources ""` bỏ qua settings/CLAUDE.md của user và project; mọi quyền đến từ `--settings` do NeoMind tạo. |

## Quyết định thiết kế

1. **Một process mỗi lượt, trong worker scope riêng.** Tên Job Object/systemd unit được cấp và journal **trước** khi process chạy; recovery dừng theo tên đó (vắng mặt = đã dừng).
2. **Quyền theo vai trò, chỉ bằng công cụ:**
   - Planner/research/reviewer: `--tools Read,Glob,Grep`, `dontAsk`.
   - Writer: `--tools Read,Glob,Grep,Write,Edit`, `dontAsk`, `allow` = `Write(<scope>/**)`, `Edit(<scope>/**)` cho từng writable root; **không có shell**.
   - Luôn có: `--setting-sources ""`, `--strict-mcp-config`, `--disable-slash-commands`, `deny: WebFetch, WebSearch, Task`.
   Đây là enforcement của runtime Claude Code (không phải sandbox OS); capability probe phải chứng minh trên máy hiện tại trước khi cho ghi.
3. **Xác minh mỗi lượt** từ `init`: model, cwd, permissionMode, tools đúng tập yêu cầu (không `Task`, không shell cho writer), `mcp_servers` rỗng. Sai lệch → hủy lượt, không chấp nhận kết quả.
4. **Check vẫn chạy qua Codex `command/exec`** (sandbox OS đã kiểm chứng). Flow dùng Claude Code cần Codex có mặt để chạy check; preview báo rõ nếu thiếu. Executor check độc lập runner là việc sau.
5. **Model allowlist cho Claude:** `claude-sonnet-5-5` (mặc định), `claude-haiku-5-5`, `claude-opus-5-5`. Không có model discovery; model thực tế lấy từ `init` và phải khớp binding.
6. **Mức suy luận:** binding `reasoning` map sang `--effort` (low/medium/high).

## Interface chung (đã commit trước khi chia việc)

`src/runners/agent-runner.ts` định nghĩa `AgentRunner`/`AgentRunnerFactory`/`RunnerScope`. Codex được bọc sau interface này; Claude Code là implementation thứ hai. Các phần dưới đây code theo interface, không sửa nó mà không báo coordinator.

## Chia việc (mỗi phần một session, một worktree/branch)

| Phần | Branch | Sở hữu file | Bàn giao |
| --- | --- | --- | --- |
| **A · Process scope + Claude transport** | `neomind/claude-a-transport` | `src/adapters/worker-scope.ts`, `windows-job.ts`, `systemd-scope.ts` (thêm `startProcessScope`), mới: `src/adapters/claude-cli.ts`, `src/adapters/claude-stream.ts`, `test/claude-cli.test.ts`, `test/helpers/fake-claude.ts` | Chạy một lượt Claude trong process scope; parse stream-json thành `TurnResult` (messages, structured output, usage, session id); xác minh `init`; test với fake claude |
| **B · Quyền, probe, model** | `neomind/claude-b-policy` | mới: `src/adapters/claude-policy.ts`, `src/runtime/claude-capabilities.ts`, `test/claude-policy.test.ts` | Dựng args/settings theo vai trò và writable roots; capability probe (ghi trong/ngoài, không Task/MCP, stop proof); allowlist model; test (probe thật đánh dấu skip khi không có `claude`) |
| **C · Tích hợp runtime** | `neomind/claude-c-runtime` | `src/runtime/local-run.ts`, `worker.ts`, `run-manager.ts`, `model-selection.ts`, `src/core/codex-*-dispatch.ts`, `src/adapters/codex-readonly.ts`, `codex-workspace-write.ts`, mới: `src/runners/codex-runner.ts`, `src/runners/registry.ts` | Dispatch dùng `AgentRunner`; Codex bọc thành `CodexRunner` không đổi hành vi; chọn runner theo binding; preflight báo thiếu Codex cho check; test bằng `FakeRunner` |
| **D · UI + tài liệu** | `neomind/claude-d-ui` | `ui/src/**`, `src/ui-server/server.ts` (endpoint danh sách model theo runner), `README.md`, `START-HERE-WINDOWS.md` | Chọn runner + model theo runner trong preview/profile binding; hiển thị runner thực tế trong monitor; hướng dẫn dùng Claude Code |

Thứ tự gộp: A → B → C → D. Coordinator (session này) gộp, nối `ClaudeRunner` (A+B) vào registry (C), chạy toàn bộ test và E2E thật:
1. Dev: Claude Code (Sonnet) viết + Codex (Luna) review.
2. Dev: toàn Claude Code (writer Sonnet, reviewer Haiku), check qua Codex.
3. Ctrl+C giữa lượt Claude → resume.

## Kết quả tích hợp (30/10/2026)

Đã gộp A (`fcc6af7`), B (`ea47cc5`), C (`8067951`), D (`6ea517c`). Coordinator viết `src/runners/claude-runner.ts` và đăng ký `ClaudeRunnerFactory` trong `defaultRunnerRegistry` (`2431669`):

- Mỗi dispatch là một `claude -p` trong một process scope. Identity được cấp và journal trước khi chạy. Scope được coi là "active" từ lúc cấp đến khi bị stop hoặc process kết thúc, vì trước lượt chưa có process nào.
- Policy theo vai trò lấy từ B. Model, effort và settings do transport của A truyền. A kiểm tra `init` trước khi chấp nhận lượt.
- Một runner chỉ chạy một lượt. Lượt thứ hai trên cùng runner bị từ chối.
- Phiên được tiếp tục bằng `--resume` chỉ khi Claude đã lưu nó (`<config>/projects/<cwd>/<id>.jsonl`). Nếu lượt đầu chưa chạy hoặc phiên thuộc cwd khác, phiên mới được bắt đầu bằng `--session-id` với cùng id, nên session group giữ được một id.

Lỗi do E2E thật phát hiện, đã sửa kèm test:

1. **Claude từ chối JSON Schema của zod.** Claude CLI thoát trước `init` khi `--json-schema` có `"$schema": draft 2020-12`. Transport bỏ khóa `$schema` trước khi truyền. Fake claude giờ cũng từ chối như Claude thật. Khi Claude thoát trước `init`, lỗi kèm dòng `Error:` đầu tiên của stderr, phần còn lại của stderr vẫn không được ghi.
2. **Reviewer không có shell không xem được diff.** Haiku trả `inconclusive` cho tiêu chí "không đổi code cũ" vì không chạy được `git diff`. Core giờ tự tính diff từ điểm bắt đầu của run tới tree đang review, bằng index riêng, và đưa vào prompt review cho mọi runner. Diff lớn hơn 60k ký tự thì không đưa vào và prompt ghi rõ điều đó.
3. **Reviewer gắn finding vào tiêu chí đang pass.** Core từ chối đúng, nhưng phản hồi retry không nói lý do. Prompt giờ nêu rõ quy tắc: finding chỉ gắn với tiêu chí fail và phải có trong `findingIds`. `structureProblems` đưa lỗi cấu trúc vào phản hồi retry, gồm finding gắn sai, `findingIds` lệch và tiêu chí `blocked`.

E2E thật trên Windows (`demo/claude-e2e1`, `demo/claude-e2e2`):

| E2E | Binding | Kết quả |
| --- | --- | --- |
| 1 · Claude viết, Codex review | plan/implement: Claude Sonnet; reviewer: Codex Luna | Lần đầu bị chặn vì lỗi 1. Sau khi sửa, `resume` thì plan chạy lại trong **cùng session id**, vì lượt đầu chưa lưu phiên. Implement, `npm test` (Codex) và review đều pass. Commit `e4c0a6c` (`subtract`), ~70k tokens |
| 2 · Toàn Claude | plan/implement: Sonnet; reviewer: Haiku/low | Bị chặn hai lần, do lỗi 2 rồi lỗi 3. Sau khi sửa, `resume` thì review pass. Commit `5a8183d` (`multiply`) |
| 3 · Crash giữa lượt viết | như E2E 1 | Kill cứng CLI 3 giây sau khi lượt viết của Claude được bind, không có shutdown gọn. Job báo `absent`, không còn process Claude. `resume`: attempt cũ thành `stopped`, có `continuation_baseline`, node chạy lại và tiếp tục **cùng phiên Claude** bằng `--resume`. Check pass, review pass, commit `fe61fce` (`divide`), ~101k tokens |

Ctrl+C gọn (SIGINT) chưa được thử với Claude từ môi trường này. Bash không gửi được Ctrl+C vào process Windows, nên đã thử trường hợp khó hơn là kill cứng. Process scope trên Linux (systemd) đã có code và test nhưng chưa chạy trên máy Linux.

## Tiêu chí xong

- `npm test` không fail trên Windows; test mới cho A, B, C.
- Capability probe Claude đạt trên máy này; ghi ngoài scope bị chặn; không có `Task`/MCP.
- Ba E2E ở trên tới commit (hoặc dừng đúng chỗ với lý do rõ), ghi vào `implementation-status.md`.
- Không đổi hành vi Codex: toàn bộ test Codex hiện có vẫn pass.
