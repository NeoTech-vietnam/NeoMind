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

## Tiếp theo

Sau khi lưu nhánh, người dùng yêu cầu tiếp tục hoàn thiện nghiên cứu/test với `opencode/deepseek-v4.1-flash-free#high`. Trần giữ nguyên: tối đa 4 workflow/40 physical inference requests cho bài đánh giá, không fallback trả phí. Đến lúc đóng gói chưa gọi model thật. Cần kiểm guard atomic/durable gắn trước dispatch, variant/auxiliary/retry/title/compaction, effective isolation/auth và cancellation/stop proof; không gỡ khóa fake chỉ vì wire test thành công.

Lab giai đoạn trước ở `/home/hieu-tran/.local/share/langconfig-eval-20261114/`; artifacts ở đó không được bảo đảm giữ lâu dài. Những thí nghiệm chưa đóng gói portable vẫn được phân biệt với test có thể tái lập từ nhánh này.
