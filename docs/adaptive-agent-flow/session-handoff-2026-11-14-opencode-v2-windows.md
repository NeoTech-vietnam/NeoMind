# OpenCode V2 trên Windows — 14/11/2026

OpenCode 2.2.7 trên Windows được cài qua npm `@opencode/cli`. Runner V2 nay chấp nhận Windows khi không có `%ProgramData%\opencode`; các bước kiểm tra nguồn cấu hình, policy deny MCP/plugin, phiên bản, session, quyền và dừng process vẫn giữ nguyên. Thứ tự tìm binary ưu tiên gói npm V2 trước `~/.local/bin`, nơi máy này còn một binary V1.

Probe `OpenCodeV2RunnerFactory.models()` mở server thật trong Windows Job và trả model. Run `run-78e92851-48bd-486f-8b83-b8c380cd2e1e` của flow `fast` trên repo thử `demo/opencode-v2-flow-user` hoàn tất plan, duyệt tự động, implement và finish bằng `glm-5.3-flash-free`; README trong worktree được thêm đúng một dòng. Handoff chưa áp vào checkout (`applied=false`). Hai job `neomind-run-c2629caf-9748-4211-9a85-6dc2a387a0e2` và `neomind-run-866d0e46-d599-4f85-be2b-6e5c4755baa4` đều trả `absent` sau run.

Lượt đầu trong sandbox tạo repo thử `demo/opencode-v2-flow` và thất bại ở plan sau lỗi kết nối tới endpoint model; bản chạy thành công dùng tài khoản Windows thật và dữ liệu đăng nhập OpenCode hiện có. Repo thử và state ở `demo/`, không nằm trong thay đổi theo dõi của NeoMind. Chưa kiểm chứng extension, hoặc flow có review/check/commit trên Windows. OpenCode permissions vẫn không phải sandbox hệ điều hành.

Kiểm chứng mã: `npm run build` đạt, 14/14 test `opencode-v2-*.test.js` đạt, `git diff --check` đạt. Suite `npm test` đầy đủ báo lỗi ở test Claude và CLI flow library trong sandbox, chạy lâu ở các test Git khác, nên được dừng trước tổng kết; chưa thể coi suite đầy đủ là đạt.
