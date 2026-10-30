# Acceptance matrix v1 — đối chiếu bằng chứng

Cập nhật: 30/10/2026, commit sau `b741ca7`. Đối chiếu design-v1 mục 18 với bằng chứng hiện có. Test được nêu bằng tên trong `npm test` (Windows 11: 133 tests, 131 pass, 0 fail, 2 skip — skip do Windows không cho tạo file symlink khi chưa bật Developer Mode và không gửi được tín hiệu console tới tiến trình con; skip không tính là đạt). "Run thật" là Codex CLI với model thật trên `demo/repo1`.

**Kết luận:** v1 chưa đạt toàn bộ. Mục 1, 3, 6, 8, 9 đạt; mục 2, 4, 5, 7 đạt một phần; mục 10 và mốc M5 (Nimbalyst) chưa đạt. Pilot Calculator chưa chạy.

| # | Yêu cầu | Trạng thái | Bằng chứng | Còn thiếu |
| --- | --- | --- | --- | --- |
| 1 | Flow CRUD/draft/publish/delete, profile overrides, clone ID mới, history sống sau xóa definition, template update không mutate project | Đạt | *drafts, publish, rename, archive, clone and delete preserve immutable versions*; *run history stays readable after its flow definition is deleted, and templates never mutate project flows*; *concurrent publications never overwrite…*; *a stale draft revision cannot overwrite newer work…*; *concurrent processes saving from the same revision: exactly one wins*; *materialization pins profile instructions…* | — |
| 2 | Binding inherit/pin, fallback allowlist, reasoning không hỗ trợ bị chặn, provenance trên UI, không lộ secret trong snapshot | Một phần | *binding precedence, provenance and immutable snapshot are explicit*; *fallback is allowlisted…*; *model selection only uses explicitly allowed…*; *verified thread rejects a server-selected model…* | Chưa kiểm UI hiển thị provenance; chưa có test khẳng định snapshot không chứa secret |
| 3 | Approval hash/version/scope; sửa plan làm mất hiệu lực; worker không tự tạo approval; policy live thu hồi được | Đạt | *approval binds plan, scope, version and live policy…*; *plan feedback creates a new unapproved version…*; *recovery cannot pass an approval node without…*; *write admission requires live approval…*. Run thật: `run changes` tạo plan v2, approve theo hash | — |
| 4 | Fork/join required/optional, concurrency theo run, repair cấp phát nguyên tử, dedup retry | Một phần | *fork schedules independent branches…*; *a branch contributing code cannot be marked optional*; *parallel writers run concurrently…* (đỉnh 2 writer); *repair allocations are idempotent…*; *fake adapter deduplicates requests…*. Run thật: template `parallel` tới commit | Chưa có test hai run cùng lúc vượt cap của một run; writer trước fork, nhiều integration chưa hỗ trợ |
| 5 | Workspace shared/private, integration conflict, attribution dirty, giữ staged/untracked, impact khi sửa ngoài, fallback review thận trọng | Một phần | Private: *detached worktree uses exact commit…*. Integration: *overlapping branch edits go to the integration agent…*. Dirty: *uncommitted changes are copied… without touching the checkout or its staging*; *the commit tree holds only the run changes…*. Run thật: import 3 thay đổi, commit chỉ phần của run | Workspace chung và chạy trên checkout hiện tại chưa làm (preview chặn); conflict với model thật chưa chạy |
| 6 | Required/advisory, bất đồng chờ người dùng, giữ verdict chỉ bằng impact receipt, cô lập session, verifier không tự sửa code | Đạt | *all required reviewers need independently verified results…*; *verified required findings request repair; … disagreement wait*; *a repair outside a passing reviewer's scope keeps that pass through a journaled impact receipt*; *a repair that changes shared build files reruns every required reviewer*; *review must target an upstream latest writer in a different session* | Impact receipt chưa chạy với model thật |
| 7 | Pause/cancel yêu cầu vs xác nhận, timeout mọi trạng thái, worker cũ còn chạy khi recovery, không nhả workspace khi chưa rõ, mất receipt | Một phần | *pause does not release unknown workers…*; *after scheduler crash, owner is reclaimed and active writer scope is stopped…* (chạy thật với Job Object); *terminal writer event without verified worker stop quarantines workspace*; *uncertain dispatch is persisted and never retried*. Run thật: Ctrl+C giữa Implement → paused → resume tới commit | Chưa có test timeout cho từng trạng thái chờ |
| 8 | Journal crash/truncate/corrupt, fencing owner giữa process, memory CAS, lesson chưa duyệt không vào retrieval | Đạt | *journal repairs torn final bytes…*; *journal blocks recovery for complete corrupt lines…*; *separate processes cannot own the same run*; *concurrent hosts cannot overwrite the same expected memory revision*; *lesson proposal stays out of approved memory…* | — |
| 9 | Commit lỗi chờ Git, hook đổi nội dung, crash sau commit trước receipt, không commit file ngoài run, không tự push/PR | Đạt | *local commit failure preserves technical acceptance and retries only after an explicit Git action*; *a partial commit is recognised as applied after a crash although the worktree keeps excluded changes*; *commit creates exactly the reviewed tree…*; commit dùng `commit-tree` nên hook không chạy; *imported uncommitted changes… stay out of the commit*; không có code push/PR | — |
| 10 | UI browser tests (canvas/keyboard/config/approval/recovery), host acceptance thật, docs/JSON hợp lệ | Chưa đạt | *all built-in templates round-trip and compile*; *local editor persists drafts…* (HTTP). Handoff 29/10 có kiểm thử Chromium headless thủ công trên Linux | Chưa có browser test tự động trong repo; chưa có host acceptance Nimbalyst |

## Mốc

| Mốc | Trạng thái |
| --- | --- |
| M0–M2 | Đạt phần lớn; thiếu như các dòng 1, 4, 5 ở trên |
| M3 editor/monitor | Chức năng có; thiếu browser test tự động và kiểm tra keyboard path |
| M4 standalone thật | Codex: Dev (Linux, Windows), song song không conflict, import thay đổi, Research, Ctrl+C/resume (Windows). Chưa có runner khác |
| M5 Nimbalyst | Chưa làm: SDK public 0.7.1 chưa có stop/interrupt có bằng chứng, cwd/sandbox theo session và xác minh model/reasoning thực tế |
| M6 | Chưa đạt; pilot Calculator chưa chạy (cần repo NeoPlayground và người dùng duyệt plan thật) |

## Capability theo nền tảng

| Năng lực | Linux | Windows 11 |
| --- | --- | --- |
| Worker scope + stop proof | user-systemd (đã kiểm chứng) | Job object (đã kiểm chứng, gồm crash supervisor) |
| Sandbox ghi theo thư mục | Codex (đã kiểm chứng) | Codex `unelevated` (đã kiểm chứng; `elevated` bị probe chặn) |
| Flow Dev thật tới commit | Đã kiểm chứng (29/10) | Đã kiểm chứng (29–30/10) |
| Song song / import / research thật | Chưa chạy trên Linux sau các thay đổi này | Đã kiểm chứng |
| Toàn bộ `npm test` sau 29/10 | Chưa chạy lại trên Linux | 131 pass, 2 skip |
