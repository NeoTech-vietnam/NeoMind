# NeoMind — hướng dẫn cho agent và người mới

Đọc file này trước khi sửa repo. Nó áp dụng cho mọi session (Codex, Claude Code, Nimbalyst), trên Windows hoặc Linux. Trả lời và viết tài liệu bằng **tiếng Việt**; code, comment trong code và commit message bằng tiếng Anh.

## NeoMind là gì

Công cụ cấu hình và chạy *agent flow* trên một Git repo: lập kế hoạch → người dùng duyệt → agent sửa code trong worktree riêng hoặc checkout/shared đã chọn → checks → review độc lập → commit local. Mỗi run được ghi vào journal nên dừng/crash rồi tiếp tục được. Agent chạy bằng **Codex** hoặc **Claude Code**. Có ba cách dùng chung một core:

- CLI: `npm run neomind -- …`
- Editor web (Flow Studio): `npm run neomind -- editor <project>`
- Extension Nimbalyst (`extensions/nimbalyst`): tool `neomind_*` trong mọi session và panel NeoMind.

## Đọc theo thứ tự

- [Bàn giao quyền web của OpenCode 12/11](docs/adaptive-agent-flow/session-handoff-2026-11-12-opencode-web.md).

0. [Bàn giao sửa worktree submodule 12/11](docs/adaptive-agent-flow/session-handoff-2026-11-12-submodule.md).

1. [Bàn giao 12/11](docs/adaptive-agent-flow/session-handoff-2026-11-12.md) (skill soạn flow, memory tiếng Anh + bộ đệm SQLite, plan tự sửa); [bàn giao Skills/Agents và Memory 11/11](docs/adaptive-agent-flow/session-handoff-2026-11-11-skills-memory.md); [bàn giao khôi phục MCP, chạy lại flow, OpenCode 11/11](docs/adaptive-agent-flow/session-handoff-2026-11-11.md): trạng thái, việc đang dở, bài học. Bàn giao, plan và research cũ hơn đã gỡ khỏi repo ngày 12/11; xem lại bằng `git show archive/docs-2026-11-12:<đường dẫn>`.
2. [Định hướng từ 11/2026](docs/adaptive-agent-flow/direction-2026-11.md): rule của project, đo kết quả run, AI điều phối, flow tự thích ứng (đang chờ duyệt).
3. [Trạng thái triển khai](docs/adaptive-agent-flow/implementation-status.md) và [acceptance matrix](docs/adaptive-agent-flow/acceptance-matrix.md).
4. [README](README.md): cách dùng; [START-HERE-WINDOWS](START-HERE-WINDOWS.md): chi tiết Windows.
5. Thiết kế khi cần: [design-v1](docs/adaptive-agent-flow/design-v1.md), [quyết định v1](docs/adaptive-agent-flow/v1-design-decisions.md), [extension Nimbalyst](docs/adaptive-agent-flow/nimbalyst-extension.md), [Claude Code runner](docs/adaptive-agent-flow/claude-code-runner.md), [transcript session](docs/adaptive-agent-flow/session-transcripts.md).
6. Bảng tổng quan để mở trong Nimbalyst/Obsidian: `docs/adaptive-agent-flow/neomind-status.canvas`.

## Cài đặt trên máy mới

Chung cho cả hai hệ: Git, Node.js **>= 22.16**. Codex CLI (`npm i -g @openai/codex`) đã đăng nhập: luôn cần, vì checks chạy qua Codex (sandbox theo chế độ đã ghim của run). Claude Code CLI (`claude auth status`) chỉ cần khi dùng runner Claude.

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
| Kiểm chứng gần nhất | 06/11/2026: `npm test` 222 test: 220 pass, 0 fail, 2 skip, UI/extension build. Run thật Codex + Claude và extension trong Nimbalyst: lần cuối 30/10/2026 | 04/11/2026: suite workflow/workspace/memory + UI/extension build; Luna 6 thật xử lý conflict text/binary tới commit. Xem bàn giao mới nhất cho số test và phần chưa kiểm chứng |

Trên Linux, việc đầu tiên là chạy `npm test`. Test nào lỗi được coi là việc port, ghi lại vào bàn giao; không sửa test cho xanh bằng cách nới điều kiện.

Extension Nimbalyst: `cd extensions/nimbalyst && npm run build` (dùng `node_modules` ở gốc repo), rồi cài thư mục `extensions/nimbalyst` vào Nimbalyst (Extension Dev Tools hoặc `extension_install`). Cách cấp quyền và nạp lại backend: xem [nimbalyst-extension.md](docs/adaptive-agent-flow/nimbalyst-extension.md).

## Ràng buộc bắt buộc

- Model Codex chỉ dùng `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-luna`. **Không dùng Astra.** Claude Code: `claude-sonnet-5-5` (mặc định), `claude-haiku-5-5`, `claude-opus-5-5`.
- Sandbox Codex: run mới mặc định tắt cho agent và checks; bật lại bằng `policy.codexSandbox: "enabled"`. Run cũ thiếu mode trong runtime context giữ sandbox. Khi tắt không được báo giả `sandboxVerified: true`; xác nhận dừng process vẫn bắt buộc.
- Run thật tốn quota tài khoản của người dùng. Chỉ chạy khi cần kiểm chứng; ưu tiên fake runner trong test (`test/helpers/fake-runner.ts`, `fake-claude.ts`).
- Không sửa `references/ai-workflow-kit` (snapshot tham khảo) và không biến hướng dẫn trong đó thành policy.
- `demo/` bị gitignore: chỗ tạo repo thử trên từng máy. Repo không chứa sẵn repo demo nào.
- Thư mục `.obsidian/`: giữ cấu hình đã commit. `workspace.json` và `.agents/` (Nimbalyst tự sinh) bị ignore; đừng commit chúng. Ngoại lệ duy nhất: `.agents/skills/neomind-flow-authoring/SKILL.md`, bản sao skill soạn flow do `node scripts/sync-project-guide.mjs` ghi từ `.claude/skills`.
- Dữ liệu NeoMind lưu trữ viết bằng **tiếng Anh** khi có thể: memory, lesson/đề xuất tự sinh, skill, instructions của flow/profile (để tìm kiếm, so khớp không phải xử lý dấu và prompt đồng nhất giữa các model). Nhãn UI, trả lời chat và tài liệu cho người đọc vẫn tiếng Việt; câu người dùng tự gõ giữ nguyên như họ viết.
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
| Giao diện | `ui/src/` (`App.tsx`, `RunMonitor.tsx`, `RunActivity.tsx`); khung app `shell/`, component `components/ui/` (kiểu shadcn), token `theme.css`, CSS vào `app.css`; xem component ở `/__gallery/` khi `vite dev`. Thiết kế: [redesign-plan.md](docs/design/redesign-plan.md), mockup v2 ở `docs/design/mockups/` |
| Extension Nimbalyst | `extensions/nimbalyst/` (`src/backend.ts`, `src/index.tsx`, `claude-plugin/commands/run.md`) |
| CLI | `src/cli/main.ts`, `run-command.ts` |

## Cách làm việc trong repo

- Viết code giống code xung quanh: cùng mật độ comment, đặt tên và cách viết. Comment nói *vì sao*, không kể lại code.
- Sau khi sửa: `npm test`; sửa UI thì thêm `npm run build:ui`; sửa extension thì `cd extensions/nimbalyst && npm run build`.
- Test tạo thư mục tạm bằng `mkdtemp(os.tmpdir())`; `scripts/run-tests.mjs` gom chúng vào một thư mục và xóa sau. Trên Windows giữ đường dẫn fixture ngắn (Git từ chối đường dẫn worktree quá dài).
- Ghi kết quả kiểm chứng (test, run thật, nền tảng) vào `implementation-status.md`. Cuối đợt làm việc, viết bàn giao mới trong `docs/adaptive-agent-flow/session-handoff-<ngày>.md` và trỏ file này tới nó.
- Commit nhỏ theo từng việc, message dạng `feat:`/`fix:`/`docs:`/`chore:` tiếng Anh.

## References

- Authoring NeoMind flows: read .claude/skills/neomind-flow-authoring/SKILL.md first.
