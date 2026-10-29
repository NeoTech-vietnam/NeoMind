# NeoMind v1 — trạng thái implementation

Cập nhật: **29/10/2026**. Branch: `hieu/adaptive-agent-flow`. Baseline trước đợt này: `d19c998`. **V1 chưa hoàn tất.** Đọc [bàn giao hiện tại](session-handoff-2026-10-29.md) để tiếp tục; [design-v1](design-v1.md) là phạm vi mục tiêu.

## Đã hoàn thành trong đợt hiện tại

- Codex app-server transport và dispatch thật cho plan, write, check, review; orchestrator nối flow mặc định tới commit local trong detached worktree. Cấu hình/model/reasoning/profile/skill và memory được ghim theo run; preview ràng buộc snapshot và source HEAD.
- Durable journal, scheduler owner/fencing, workspace leases và quarantine; recovery đối chiếu worker/session/code rồi chờ người dùng Continue. Pause/cancel ngừng giao việc, yêu cầu ngắt worker và giữ artifacts/code. Regression đã kiểm tra pause khi check đang giữ hàng đợi service.
- Worker/check dùng Linux user-systemd scopes và xác minh dừng trước khi giải phóng workspace; turn interrupted đơn lẻ không được coi là bằng chứng dừng shell con. External tools/delegation bị vô hiệu hóa và inventory được kiểm tra trước dispatch.
- Approval có plan hash, đổi kế hoạch tạo version mới; bounded repair giữ session thực hiện và từng reviewer. Nhiều reviewer độc lập chạy đồng thời theo cap; required/advisory verdict và evidence được tổng hợp. Source citations, check receipts và artifact references được đối chiếu với baseline; một lần retry validation trước khi chờ nếu evidence không hợp lệ.
- Checks, graph conditions và repair counters có trạng thái bền vững. Active-time budget bỏ thời gian toàn run chờ người dùng; gia hạn có journal. Fallback chỉ trong allowlist. Token usage cộng theo session; thiếu dữ liệu hiển thị unknown/partial, chi phí chưa đo được.
- Commit theo reviewed tree trong detached worktree; lỗi Git giữ technical acceptance và cho explicit retry khi baseline/intent đã đối chiếu. Git commands có timeout và AbortSignal; chưa chứng minh dừng toàn bộ cây tiến trình ký Git. Commit-tree không chạy hooks.
- Flow Studio: canvas/flow library, profile CRUD/draft/publish, binding/fallback và condition editors, run preview/monitor/approval/plan changes/pause/resume/cancel/retry Git/gia hạn. API localhost có origin/token checks. CLI có preview/start/list/show/approve/resume/pause/cancel cơ bản.
- Memory root theo Git common directory, Markdown CAS và audit receipts cho context/quyết định; shared memory được ghim theo run. Lessons sau repair chỉ là proposals; promotion cần duyệt đúng hash và revision. Memory UI đã thử bằng trình duyệt.
- Local Research tạo artifacts chỉ đọc và review chúng; đã test bằng transport deterministic. Chưa kiểm chứng inference thật cho Research hoặc nguồn web/connector.

## Kiểm chứng

- `npm test`: **101/101 pass**, 0 fail, 0 skip; gồm TypeScript build, integration fixtures, crash recovery, leases, evidence, repair, parallel reviewers, memory, lifecycle và Git.
- `npm run build:ui`: thành công; xem bàn giao cho bước xác minh cuối trước commit.
- Inference thật với **Luna 6** thực hiện và **Sol 6.1** review: fixture hoàn thành plan → duyệt giả lập → write → checks → review → commit. Không dùng Astra. Terra 6.1 có trong catalog, chưa claim đã inference trong đợt này.
- Headless Chromium: full fixture chạy qua UI tới commit sau recovery/review; profile được publish và quyết định memory có receipt. Đây là disposable fixture với approval giả lập, không phải người dùng duyệt task Calculator thật.
- Đã kiểm tra scope recovery sau scheduler crash. Node SQLite trên Node 22 vẫn experimental; chưa xác minh nền tảng khác Linux/user-systemd.

## Mốc còn lại

| Mốc | Đã có | Còn thiếu |
| --- | --- | --- |
| M0 foundation | Schemas/compiler/libraries/snapshots | Đồng bộ nhiều writer cho draft/metadata; rà soát contracts toàn bộ |
| M1 core | Default orchestration, reviewer pool, repairs, lifecycle/recovery | Thực thi nhánh writer song song và integration; impact mapping chi tiết |
| M2 workspace/memory/CLI | Isolated worktree, reviewed commit, memory UI/audit, CLI cơ bản | Current checkout/dirty attribution/shared workspace/read leases; CLI control parity và graceful signals |
| M3 editor/monitor | Flow/profile/memory/run UI, browser verification | Cấu hình graph đầy đủ và accessibility/acceptance rộng hơn |
| M4 standalone | Codex Linux default flow E2E thật | Research live, graph branches tổng quát, runner/platform khác |
| M5 Nimbalyst | Đã khảo sát public SDK 0.7.1 | Chưa adapter; thiếu public stop proof, workspace/sandbox và effective binding contracts |
| M6 acceptance | 101 tests + fixture/browser evidence | Chưa chạy toàn bộ matrix design-v1 mục 18 và pilot Calculator thật |

Không thay scope thiết kế đã chọn bằng phạm vi executor hiện tại. Các trường hợp chưa hỗ trợ được chặn tại preview/preflight; không mô tả chúng là đã chạy được.
