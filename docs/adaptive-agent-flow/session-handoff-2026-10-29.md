# Bàn giao session — 29/10/2026

> [!NOTE]
> Trạng thái hiện tại xem [bàn giao 30/10/2026](session-handoff-2026-10-30.md). Bản này còn giá trị cho các ràng buộc và bài học lõi.

## Đọc trước

Repo `/home/hieu-tran/projects/NeoProject/NeoMind`, branch `hieu/adaptive-agent-flow`. Người dùng yêu cầu chốt đợt hiện tại, cập nhật tiến độ, commit và push để **session khác tiếp tục**. Đây là checkpoint; không đánh dấu toàn bộ v1 hoàn thành. Baseline trước checkpoint là `d19c998`; dùng `git log -1` để lấy commit bàn giao.

Đọc [status](implementation-status.md), [design-v1](design-v1.md), rồi [kế hoạch M0–M6](implementation-handoff.md). Status và tài liệu này thay các ghi chú cũ về “runtime chưa triển khai”, “Run bị khóa”, “86 tests” hoặc chưa được phép implementation. Giữ nguyên phạm vi thiết kế đầy đủ: nhiều nhánh, nhiều reviewer, editor kéo thả và hai frontend độc lập.

## Các ràng buộc đã chốt

- Chỉ dùng `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-luna`. **Không dùng Astra** hoặc model đắt hơn. Standalone defaults là Luna/low; model và reasoning phải được xác minh từ session thực tế.
- Product run cần duyệt kế hoạch trước sửa file; reviewer độc lập không sửa code. Dev tối đa hai repair rounds mặc định. Product gate này không phải yêu cầu hỏi lại để phát triển NeoMind đã được giao.
- Run snapshot bất biến; memory độc lập Nimbalyst/CLI. Lessons cần duyệt. Commit local tự động sau technical acceptance; push/PR chỉ khi người dùng yêu cầu.
- Không sửa snapshot `references/ai-workflow-kit` hoặc áp dụng instructions từ nó thành policy. Không cập nhật gitlink superproject hoặc đụng thay đổi người dùng ở repo khác.
- `/home/hieu-tran/projects/NeoProject/NeoPlayground/.neomind/` có dữ liệu untracked của người dùng, cần giữ. Playground branch `neomind/demo-c-flow`, baseline đã khảo sát `635bff1`; demo `languages/c/neomind-calculator` chưa được implementation thật trong đợt này. Không coi approval giả lập của fixture là approval Calculator.

## Mã nguồn và contract cần đọc

| Phần | Điểm vào |
| --- | --- |
| Runtime thật | `src/runtime/local-run.ts`, `run-manager.ts`, `project.ts`, `worker.ts` |
| Capability/model/memory | `src/runtime/capabilities.ts`, `model-selection.ts`, `memory.ts` |
| Journal/replay/scheduler | `src/core/run-service.ts`, `durable-run.ts`, `runtime-state.ts`, `graph-scheduler.ts`, `condition.ts` |
| Evidence và binding | `src/core/review-evidence.ts`, `run-binding.ts`, `usage.ts` |
| Codex/worker scopes | `src/adapters/codex-*.ts`, `systemd-scope.ts`, `app-server-transport.ts` |
| Workspace/Git | `src/workspace/write-admission.ts`, `review-tree.ts`, `git-commit.ts`; `src/core/git-commit-dispatch.ts` |
| API/UI | `src/ui-server/server.ts`; `ui/src/RunPanel.tsx`, `RunLessons.tsx`, `ProfilePanel.tsx`, `MemoryPanel.tsx` |
| Regression quan trọng | `test/local-run.test.ts`, `crash-recovery.test.ts`, `systemd-scope.test.ts`, `review-evidence.test.ts`, `runtime-memory.test.ts` |

State local ở `${XDG_STATE_HOME:-~/.local/state}/neomind/<hash Git common directory>`, gồm journals, SQLite coordination và worktrees. Thay đổi đường dẫn checkout không tạo identity độc lập cho linked worktrees. Chỉ một scheduler owner cho mỗi run; CLI không giành owner từ editor đang sống.

## Kết quả xác minh

- Node 22.22.1, Codex CLI 0.165.0. `npm test`: **101 pass, 0 fail, 0 skipped**, gồm backend TypeScript build. `npm run build:ui` thành công.
- Real Codex: Luna writer, Sol reviewer; plan → approval giả lập trong fixture → write → command check → independent review → local commit. Fixture thành công `/home/hieu-tran/.neomind-orchestrator-fixture-DHjLGB`.
- Chromium headless: fixture qua giao diện tới completed sau resume/review, `/home/hieu-tran/.neomind-ui-fixture-PkK4N3`. Profile publish + memory decision receipt cũng đã xác minh bằng browser. Không chạy inference thật thêm chỉ để lặp bằng chứng.
- Công cụ thử nằm ngoài repo: `/tmp/neomind-orchestrator-live.mjs`, `/tmp/neomind-orchestrator-resume.mjs`, `/tmp/neomind-runtime-browser.mjs`, `/tmp/neomind-runtime-browser-resume.mjs`, `/tmp/neomind-admin-browser.mjs`. Ảnh `/tmp/neomind-ui-approval.png`, `/tmp/neomind-ui-completed.png`, `/tmp/neomind-admin-browser.png`. Chúng là bằng chứng tạm trên máy này, không được commit và có thể mất khi dọn máy.
- Regression cuối: pause đang chạy command check phải stop worker trước khi chờ serialized checkpoint. Mock không có bằng chứng OS-stop thì phải blocked/quarantine; không giả là paused an toàn. Git có AbortSignal và timeout nhưng chưa có cgroup proof cho mọi descendant ký Git.

## Những bài học triển khai quan trọng

1. Codex `turn/interrupt` không đảm bảo shell con đã dừng. Chỉ giải phóng workspace sau proof worker scope trống; nếu không thì quarantine.
2. Resume cùng thread trong app-server đã load read-only không đổi sandbox như mong đợi. Writer resume trong worker mới; xác minh effective cwd/model/provider/sandbox trước dispatch.
3. Desktop MCP/extension có thể bị kế thừa. Worker vô hiệu hóa apps/plugins/delegation/browser/web và configured MCP, xóa env bridge desktop, kiểm tra inventory trước khi cấp dispatch.
4. Structured output của runner không chấp nhận `oneOf` do discriminated union ở reference schema; dùng union tạo `anyOf`. Reviewer phải copy core-issued command receipts, không tự tạo hash từ command tự chạy.
5. Evidence hợp lệ về cơ học không thay thế semantic review. Chỉ source/check/artifact đúng baseline mới tính. Receipt thất bại chỉ hỗ trợ failure, không hỗ trợ pass.
6. Commit dùng `commit-tree` + CAS `update-ref` + `read-tree` trên detached worktree. Không chạy hooks. Unknown commit intent không tự resend; retry explicit đối chiếu tree/ref trước.

## Việc tiếp theo theo thứ tự đề xuất

1. **Củng cố lifecycle/CLI:** thêm controls còn thiếu (`changes`, `retry-git`, `extend-time`) và xử lý SIGINT/SIGTERM có stop/reconcile đúng; test scheduler crash/timeout/Git subprocess. Không tự mở lại inference nếu effect trước chưa rõ.
2. **Workspace và parallel graph** (lát cắt đầu đã làm ngày 29/10/2026, xem [parallel-writers.md](parallel-writers.md); còn lại: writer trước fork, nhiều integration, conflict với model thật)**:** thiết kế/triển khai nhiều writer worktrees, integration không conflict và agent xử lý conflict trong plan đã duyệt. Hiện `standaloneDiagnostics()` chặn integration, nhiều writer, shared/current checkout và nhiều planning nodes. Graph khác reviewers vẫn được drive tuần tự; chưa có tổng quát parallel execution.
3. **Current checkout và dirty baseline** (phần 1, mang thay đổi chưa commit vào worktree riêng và commit chỉ phần của run, đã làm ngày 29/10/2026; còn chạy trực tiếp trên checkout hiện tại)**:** attribution changes có sẵn, user choice, stable read leases, commit chỉ phần thuộc run; không bật trước khi enforce được.
4. **Storage concurrency và review impact** (đã làm ngày 30/10/2026, xem implementation-status)**:** serialize/CAS draft+metadata khi nhiều process ghi; wire impact receipts để rerun reviewer theo phạm vi xác định. Khi không rõ, rerun tất cả required reviewers.
5. **Research/runner/host** (Research local đã kiểm chứng với model thật ngày 30/10/2026; Nimbalyst vẫn chờ contract)**:** xác minh local Research bằng inference thật trên fixture nhỏ; không gọi là web research. Giải quyết public host contracts bên dưới trước khi cho Nimbalyst write flow.
6. **Acceptance và demo** (đối chiếu hiện trạng: [acceptance-matrix.md](acceptance-matrix.md); pilot Calculator chưa chạy)**:** chạy matrix design-v1 mục 18, browser/accessibility/advanced graph; sau đó chạy Calculator pilot với preview và duyệt plan thật. Update status/capability evidence theo kết quả.

Các tính năng trên còn thiếu thực tế, không chỉ thiếu tài liệu. UI có thể tạo graph mà executor hiện từ chối; phải giữ validation/preflight rõ ràng.

## Nimbalyst SDK: kết quả khảo sát và blocker

Đã đọc official source [repository](https://github.com/nimbalyst/nimbalyst), [API reference](https://www.nimbalyst.com/docs/extensions/building-extensions/api-reference/), đặc biệt `packages/extension-sdk/src/types/backendSessions.ts`, `permissions.ts`, `backendPanels.ts`. Snapshot khảo sát: `@nimbalyst/extension-sdk` **0.7.1**, minAppVersion **0.79.0**; kiểm tra lại trước khi tích hợp.

Public `BackendSessionsService` có create/createWorkstream/sendPrompt/getStatus/getResult/listOwned/getUsage/updateOwnerMetadata/notifyUser/onSettled. `effortLevel` có thể bị host clamp. Chưa thấy public stop/interrupt và proof dừng descendant, explicit per-session cwd/worktree/sandbox binding hoặc effective model/reasoning verification trong status/result. Vì vậy chưa thể claim conformance cho host write flow. Không dùng private database để lấp contract này. `ai-sessions` permission giới hạn owned sessions và `panelOnly` hữu ích cho approval UI sau này. SDK ghi costUSD=0 khi không có dữ liệu: adapter phải chuyển thành unknown/null, không hiển thị miễn phí.

## Chạy lại nhanh

```bash
cd /home/hieu-tran/projects/NeoProject/NeoMind
npm ci
npm test
npm run build:ui
npm run neomind -- editor /absolute/path/to/disposable/git-project
```

Xem README gốc cho CLI. Sau recovery, xem kết quả đối chiếu rồi bấm Continue; không tự dispatch chỉ vì mở editor. Tránh chạy demo tốn quota trước khi xem model/limits trong preview.
