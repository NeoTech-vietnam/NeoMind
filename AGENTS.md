# NeoMind — hướng dẫn cho agent và người mới

Đọc file này trước khi sửa repo. Nó áp dụng cho mọi session (Codex, Claude Code, Nimbalyst), trên Windows hoặc Linux. Trả lời và viết tài liệu bằng **tiếng Việt**; code, comment trong code và commit message bằng tiếng Anh.

## NeoMind là gì

Công cụ cấu hình và chạy *agent flow* trên một Git repo: lập kế hoạch → người dùng duyệt → agent sửa code trong worktree riêng → checks → review độc lập → commit local. Mỗi run được ghi vào journal nên dừng/crash rồi tiếp tục được. Agent chạy bằng **Codex** hoặc **Claude Code**. Có ba cách dùng chung một core:

- CLI: `npm run neomind -- …`
- Editor web (Flow Studio): `npm run neomind -- editor <project>`
- Extension Nimbalyst (`extensions/nimbalyst`): tool `neomind_*` trong mọi session và panel NeoMind.

## Đọc theo thứ tự

1. [Bàn giao mới nhất](docs/adaptive-agent-flow/session-handoff-2026-10-30.md): trạng thái, việc đang dở, bài học.
2. [Trạng thái triển khai](docs/adaptive-agent-flow/implementation-status.md) và [acceptance matrix](docs/adaptive-agent-flow/acceptance-matrix.md).
3. [README](README.md): cách dùng; [START-HERE-WINDOWS](START-HERE-WINDOWS.md): chi tiết Windows.
4. Thiết kế khi cần: [design-v1](docs/adaptive-agent-flow/design-v1.md), [quyết định v1](docs/adaptive-agent-flow/v1-design-decisions.md), [extension Nimbalyst](docs/adaptive-agent-flow/nimbalyst-extension.md), [Claude Code runner](docs/adaptive-agent-flow/claude-code-runner.md), [transcript session](docs/adaptive-agent-flow/session-transcripts.md).
5. Bảng tổng quan để mở trong Nimbalyst/Obsidian: `docs/adaptive-agent-flow/neomind-status.canvas`.

## Cài đặt trên máy mới

Chung cho cả hai hệ: Git, Node.js **>= 22.16**. Codex CLI (`npm i -g @openai/codex`) đã đăng nhập: luôn cần, vì checks chạy qua sandbox Codex. Claude Code CLI (`claude auth status`) chỉ cần khi dùng runner Claude.

```bash
npm ci
npm test            # build + toàn bộ test, thư mục tạm riêng tự xóa
npm run build:ui    # giao diện editor (dist-ui/)
npm run neomind -- editor /duong/dan/toi/mot/git-repo
```

| | Windows 10/11 | Linux |
| --- | --- | --- |
| Giữ và dừng process | Job Object qua helper `neomind-job-<hash>.exe`, tự biên dịch lần đầu bằng `csc.exe` của .NET Framework 4 (có sẵn), cache ở `%LOCALAPPDATA%\neomind\bin` | `systemd-run --user --scope`: cần user systemd chạy được (`systemctl --user status`) |
| State (journal, SQLite, worktree của run) | `%LOCALAPPDATA%\neomind\<project-key>` | `${XDG_STATE_HOME:-~/.local/state}/neomind/<project-key>` |
| Kiểm chứng gần nhất | 30/10/2026: `npm test` 184 test (182 pass, 2 skip), run thật Codex + Claude, extension Nimbalyst | 29/10/2026: 101 test, flow Dev Codex thật. **Mọi thứ làm ngày 30/10 chưa chạy trên Linux** (Claude runner, transcript, dọn worktree, Fast, canvas, extension) |

Trên Linux, việc đầu tiên là chạy `npm test`. Test nào lỗi được coi là việc port, ghi lại vào bàn giao; không sửa test cho xanh bằng cách nới điều kiện.

Extension Nimbalyst: `cd extensions/nimbalyst && npm run build` (dùng `node_modules` ở gốc repo), rồi cài thư mục `extensions/nimbalyst` vào Nimbalyst (Extension Dev Tools hoặc `extension_install`). Cách cấp quyền và nạp lại backend: xem [nimbalyst-extension.md](docs/adaptive-agent-flow/nimbalyst-extension.md).

## Ràng buộc bắt buộc

- Model Codex chỉ dùng `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-luna`. **Không dùng Astra.** Claude Code: `claude-sonnet-5-5` (mặc định), `claude-haiku-5-5`, `claude-opus-5-5`.
- Run thật tốn quota tài khoản của người dùng. Chỉ chạy khi cần kiểm chứng; ưu tiên fake runner trong test (`test/helpers/fake-runner.ts`, `fake-claude.ts`).
- Không sửa `references/ai-workflow-kit` (snapshot tham khảo) và không biến hướng dẫn trong đó thành policy.
- `demo/` bị gitignore: chỗ tạo repo thử trên từng máy. Repo không chứa sẵn repo demo nào.
- Thư mục `.obsidian/`: giữ cấu hình đã commit. `workspace.json` và `.agents/` (Nimbalyst tự sinh) bị ignore; đừng commit chúng.
- Không push, không tạo PR, không force-push nếu người dùng không yêu cầu.
- Kế hoạch phải được người dùng duyệt trước khi sửa file (trừ flow tự khai báo `approval.mode: auto` như Fast và project cho phép). Đừng tự duyệt thay người dùng, kể cả qua tool `neomind_approve`.

## Bản đồ mã nguồn

| Phần | Nơi bắt đầu |
| --- | --- |
| Schema flow, compiler, template có sẵn | `src/domain/` (`schema.ts`, `compiler.ts`, `templates.ts`, `flow-canvas.ts`) |
| Journal, replay, quyết định review | `src/core/` (`run-service.ts`, `recovery.ts`, `review*.ts`, `transcript.ts`) |
| Chạy một run, quản lý nhiều run | `src/runtime/local-run.ts`, `run-manager.ts`, `session-tools.ts` (tool cho session), `session-history.ts` |
| Runner | `src/runners/` (contract `agent-runner.ts`, `codex-runner.ts`, `claude-runner.ts`, `registry.ts`) |
| Codex/Claude transport, giữ process | `src/adapters/` (`claude-cli.ts`, `codex-*.ts`, `windows-job.ts`, `systemd-scope.ts`, `worker-environment.ts`) |
| Git, worktree, dọn dẹp | `src/workspace/` (mọi lệnh git đi qua env trong `git-env.ts`) |
| API editor (dùng chung HTTP và extension) | `src/ui-server/server.ts` (`createEditorApi`) |
| Giao diện | `ui/src/` (`App.tsx`, `RunMonitor.tsx`, `RunActivity.tsx`); mockup ở `docs/design/` |
| Extension Nimbalyst | `extensions/nimbalyst/` (`src/backend.ts`, `src/index.tsx`, `claude-plugin/commands/run.md`) |
| CLI | `src/cli/main.ts`, `run-command.ts` |

## Cách làm việc trong repo

- Viết code giống code xung quanh: cùng mật độ comment, đặt tên và cách viết. Comment nói *vì sao*, không kể lại code.
- Sau khi sửa: `npm test`; sửa UI thì thêm `npm run build:ui`; sửa extension thì `cd extensions/nimbalyst && npm run build`.
- Test tạo thư mục tạm bằng `mkdtemp(os.tmpdir())`; `scripts/run-tests.mjs` gom chúng vào một thư mục và xóa sau. Trên Windows giữ đường dẫn fixture ngắn (Git từ chối đường dẫn worktree quá dài).
- Ghi kết quả kiểm chứng (test, run thật, nền tảng) vào `implementation-status.md`. Cuối đợt làm việc, viết bàn giao mới trong `docs/adaptive-agent-flow/session-handoff-<ngày>.md` và trỏ file này tới nó.
- Commit nhỏ theo từng việc, message dạng `feat:`/`fix:`/`docs:`/`chore:` tiếng Anh.
