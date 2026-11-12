# Bàn giao — 12/11/2026

Một session điều phối giao việc cho các session Claude Opus con trong worktree riêng, review, rebase, gộp vào `hieu/adaptive-agent-flow`, chạy `npm test` đầy đủ trên bản gộp và cài lại extension. Chi tiết từng mục nằm trong [implementation-status](implementation-status.md) (các mục ngày 12/11).

## Đã có

- **Skill soạn flow đi theo project:** `neomind init <project> [--force]` (CLI, API, tool `project_init`) và tự cài lần đầu tạo `neomind/`. Skill cài vào cả `.claude/skills/` (Claude Code) và `.agents/skills/` (chuẩn [Agent Skills](https://agentskills.io), Codex và OpenCode quét); `AGENTS.md` được thêm dòng tham chiếu; tool soạn flow/agent/skill nhắc đọc skill. Màn Skills đọc thêm nguồn `.agents/skills` (chỉ đọc). Bản đóng gói sinh bằng `node scripts/sync-project-guide.mjs`; sửa skill xong phải chạy lại.
- **`flow_validate` bắt lỗi runtime:** preflight binding/runner/model/profile/skill và các luật soạn flow (lỗi chặn publish, cảnh báo không chặn), gồm cảnh báo `plan_check_placeholder` và `plan_scope_outside_write_scope`.
- **Bước plan biết luật và tự sửa:** prompt plan nêu `writeScopes` của writer, luật scope và luật check argv; schema plan có `pattern` (Codex, Claude); `planProblem` bắt scope ngoài `writeScopes` trước khi duyệt; plan sai được gửi lại bước plan tối đa 2 lần trước khi chờ người.
- **Nhân bản run và lưu model làm mặc định của flow** (`flow_pin_bindings`, "Lưu thành flow mới…" cho template).
- **Memory:** body lesson ngắn và `memory compact`; dữ liệu lưu trữ viết tiếng Anh (luật trong `AGENTS.md`); đánh giá memory ghi `neomind/memory/feedback/*.jsonl` (vào Git); bộ đệm dựng lại được `neomind/memory/.cache/index.sqlite` (FTS5, tự ignore); `neomind doctor paths <project>` in mọi thứ nằm ở đâu.
- **Dọn tài liệu:** research/thiết kế trước v1, plan đã làm xong, bàn giao 29/10–08/11, ảnh và mockup UI trước redesign đã gỡ khỏi repo. Lấy lại bằng `git show archive/docs-2026-11-12:<đường dẫn>`.

## Kiểm chứng (Windows)

- `npm test` đầy đủ trên `43419b8`: 347 test, 344 pass, 1 fail (scope Claude, chập chờn đã biết; chạy riêng `claude-cli.test.js` đạt 10/10), 2 skip. `tsc` UI, `build:ui`, build extension đạt; extension đã cài lại.
- Chưa chạy run thật cho: plan tự sửa, nhân bản run, bộ đệm memory, skill trong `.agents/skills` với Codex/OpenCode thật.

## Việc còn lại

- Chạy thật `lc-new-problem` trên `leetcode-practice` để xác nhận plan tự sửa.
- Đã bàn, chưa làm: bảng điểm flow (radar 7 trục: thành công, chất lượng, chi phí cho mỗi kết quả được chấp nhận, tốc độ, tự chủ, ổn định, tuân thủ; tham khảo CLEAR, pass^k, chỉ số DORA cho agent); flow lồng nhau (`subflow`, `map`) và chương trình tự chạy; journal có snapshot cho run dài.
- Backlog chung: `nimbalyst-local/tracker/tasks.md`.
