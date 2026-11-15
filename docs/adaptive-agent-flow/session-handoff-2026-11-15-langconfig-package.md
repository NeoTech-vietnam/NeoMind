# Bàn giao nhánh LangConfig và gói tái lập — 15/11/2026

## Phạm vi đã duyệt

Người dùng duyệt nhánh `research/langconfig-opencode` từ `6306c8b`, lưu tài liệu và prototype/harness có thể tái lập, commit theo nhóm và push lên `origin`; không PR hoặc force-push. Ba session Terra 6.1 `xhigh` chia việc: setup/test, ý tưởng tích hợp, đóng gói code thử nghiệm. Parent review và xử lý Git. Không thay runtime NeoMind, không vendor upstream hoặc đưa environment/DB/credentials vào repo.

Điểm vào: [hồ sơ LangConfig](../langconfig/README.md), [setup/test](../langconfig/setup-and-tests.md), [ý tưởng](../langconfig/integration-rationale.md), [prototype](../../experiments/langconfig-opencode/README.md), [report lịch sử](research-langconfig-vs-neomind-2026-11-14.md).

## Kiểm chứng

- Lượt `npm test` đầu dùng `/tmp` gặp `Disk quota exceeded`: 369 test, 253 đạt, 104 lỗi, 12 skip. Đây là kết quả thất bại thật, có lỗi Git/worktree và SQLite sau khi hết quota; không nới điều kiện hoặc sửa test.
- Chạy lại cùng suite bằng `TMPDIR=/home/hieu-tran/.local/share/langconfig-eval-20261114/packaging-test-tmp npm test`: **369 test, 357 đạt, 0 lỗi, 12 skip**, Linux. Không sửa code/test; log `neomind-packaging-20261115-tests-labtmp.log` trong lab. Cần đặt `TMPDIR` ngoài `/tmp` khi quota tmpfs không đủ.
- Kết quả prototype trước đóng gói: 17 test đạt, 1 warning; graph gọi implementation `TOOL_NODE` thật qua HTTP tới OpenCode 2.2.7 và upstream giả. Không phải full backend/canvas UI hoặc model thật.
- Parent đã dùng **gói trong repo** tạo clone staging mới từ SHA ghim, replay **17 test adapter đạt, 1 warning**; thêm **4 test lifecycle harness đạt**. Environment Python cũ có sẵn, `pip check` báo `No broken requirements found`; chưa xác minh cài dependency từ môi trường trống.
- Parent chạy lại wire sau sửa code: `Fixture graph passed; 1 fake upstream requests`. `e2e.log` chứa JSON `completed`/`needs_changes` và finding cố định; session deny mọi tool. Server OpenCode thật, upstream giả loopback; không inference model thật. Artifacts parent ở `package-parent-stage-20261115` và `package-parent-wire-20261115` dưới lab cũ, không commit log thô.
- Review code đã bỏ password server riêng khỏi argv, dùng environment; xử lý SIGTERM và cố dừng từng process độc lập kể cả một cleanup lỗi. Test lifecycle mới kiểm nhánh xử lý bằng mock, không phải bằng chứng OS stop proof cho live.
- Review tài liệu đã sửa chuỗi tải/checksum phải dừng khi lỗi, lab mới không ghi đè, kiểm `SHOW data_directory` trước tạo DB/extension và đặt working directory backend tường minh. Các block Bash được kiểm `bash -n` (chỉ cú pháp, không phải cài mới); link nội bộ được kiểm trước commit.

## Tiếp tục guard, LocalRun và model free

Nhánh ban đầu đã push lên `origin/research/langconfig-opencode`: `c54924f` lưu prototype và `f21c6cf` lưu tài liệu. Sau đó đã kiểm cold install trong venv Python 3.12.16 mới, không system site-packages và cache pip riêng trống: 887 giây, `pip check` đạt; 17 test adapter, 4 test lifecycle và wire 1 request giả đạt. Manifest không đổi; 191 dependency ở freeze cục bộ, transitive chưa lock. Evidence `install-check-20261115/` dưới lab cũ.

Harness guard mới nằm trong `experiments/langconfig-opencode/live/`, không thay production runner. Fake acceptance chạy OpenCode thật trong namespace chỉ loopback: một retry 429 tạo 2 POST/2 reservation, veto còn 1 POST; kiểm title/compaction, generate deny, model/variant, quota/DB lỗi, interrupt, missing receipt và plugin. WebSocket bị ép rơi về HTTP, chưa trực tiếp test hook deny WS. SQLite quota có test nhiều process; không coi permissions là OS sandbox.

`test_local_run.mjs` đã chạy **LocalRun read-only hoàn chỉnh** bằng `RunnerRegistry`/factory thử nghiệm: `run-3c1b24ca-06e7-422d-8851-85f9e46eb5c8` completed, 1 attempt, 1 fake POST/1 reservation, journal có intent/receipt/output theo thứ tự. Unit inactive/cgroup rỗng được kiểm sau run; journal chưa có event stop-verified riêng. Output `Synthetic fake review` có finding giả định sẵn, không chứng minh chất lượng model thật. Script tạo baseline tổng hợp mới được bổ sung để không cần repo fixture cũ.

Parent đã replay sau sửa review: **7 unit quota/path/anchor đạt**, test Node path và scoped cancellation đạt; fake acceptance còn cho retry 429 đúng 2 POST/2 reservation. Trên repo synthetic do script tạo mới, LocalRun `run-9a6913e4-08be-4c7b-8c78-b72570fad3e0` completed với 1 attempt, 1 fake POST/1 reservation, 0 live request; journal đúng thứ tự và scope dừng xác nhận. Artifacts ở `parent-live-replay-20261115/` dưới lab cũ. Các lệnh unit/fake/runner/LocalRun không dùng DB budget live.

Review đã sửa ID workflow mới dùng UUID và consume slot atomically, từ chối attempt trùng; đối chiếu owner anchor trước dùng DB live; runtime data bắt buộc ở ngoài checkout; SIGINT/SIGTERM đi qua cleanup scope. Anchor chỉ giảm dùng nhầm state, không chống người vận hành cố ý sửa DB/code. Unit tests không được coi là chứng minh stop proof thực: bằng chứng scope/cgroup ở lượt LocalRun được kiểm riêng.

**Blocker live:** lượt LC đầu tiên đúng `opencode/deepseek-v4.1-flash-free#high` nhận `Free usage limit reached`. Một workflow đã thử, 0 workflow live hoàn thành; guard giữ **1 reservation là cận trên 1 physical request**, không phải đối chứng POST ở dịch vụ. Retry veto, không fallback; scope `neomind-run-aaad8eae-67e8-4cc0-a0a2-a7729909be41.scope` dừng xác nhận (parent đọc lại `ActiveState=inactive`, `ControlGroup=`). Không có review thật. Lỗi không xác định riêng trạng thái auth hoặc bảo đảm đăng nhập sẽ giải quyết quota.

**State phải giữ:** `live-guard-20261115/live-budget.sqlite` dưới lab gốc có 1 workflow/1 reservation; parent chỉ đọc DB ở mode `ro` rồi tạo `live-budget.anchor.json` riêng mode 0600, ghim path/device/inode và mốc đã dùng. Không reset/copy DB hoặc tự tạo budget mới. Giữ cả `LIVE_PAUSED` trong code/state cho tới khi chủ lượt chạy giải quyết giới hạn free qua OpenCode chính thức và chủ động cho phép tiếp tục; public environment opt-in không phải bằng chứng một approval mới.

## Tiếp theo

Người dùng yêu cầu làm tới khi tích hợp/test ổn với NeoMind và model free. Trần giữ nguyên: tối đa 4 workflow/40 physical inference requests, đã dùng mốc trên; không fallback trả phí. Đến lần push ban đầu chưa gọi model thật, nhưng lượt tiếp theo đã gặp blocker quota. Khi giới hạn free được xử lý, vẫn cần review LC/model thật thành công và LocalRun live hoàn chỉnh; không coi factory/LocalRun fake là production integration, không gỡ khóa overlay fake hoặc thay policy runner hiện hành để chạy tiếp.

Lab giai đoạn trước ở `/home/hieu-tran/.local/share/langconfig-eval-20261114/`; artifacts ở đó không được bảo đảm giữ lâu dài. Những thí nghiệm chưa đóng gói portable vẫn được phân biệt với test có thể tái lập từ nhánh này.
