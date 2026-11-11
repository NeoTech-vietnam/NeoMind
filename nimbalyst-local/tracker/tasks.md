# Backlog NeoMind

Cập nhật 11/11/2026. Mục cũ ghi nhận 07/11; mục mới thêm 11/11 sau đợt khôi phục MCP/OpenCode và thử OpenCode thật trên `leetcode-practice`.

## Chưa làm

- Kiểm tra model và mức suy luận khả dụng của runner trước khi cho chọn/chạy flow #task[id:tsk_01M6TE6H2RRTWJK611YDMSHRMB status:to-do priority:medium created:2026-11-07]

  Đọc danh sách model thực tế từ runner/CLI đang dùng, đối chiếu allowlist của NeoMind và hiển thị đúng trên UI. Chỉ cho chọn mức suy luận runtime hỗ trợ; model đã ghim nhưng không khả dụng phải có lý do rõ ràng. Không tự đổi model hoặc bỏ kiểm tra quyền/fallback. Bối cảnh: UI cho chọn Sol 6.1/Terra 6.1 nhưng Codex CLI 0.155.1 trên máy không trả hai model này, trong khi Luna 6 có sẵn.

  Tình trạng 11/11: OpenCode đã lấy model thật từ provider đang kết nối (`/api/runners/opencode`); Codex và Claude vẫn dùng allowlist tĩnh `/api/runners`.

- Điều tra các ca test process/reviewer không ổn định trên Windows #task[id:tsk_01M6THTA65JPX4WTD4TWPEW3CB status:to-do priority:low created:2026-11-07]

  Suite fail nhưng chạy riêng pass; chưa xác định nguyên nhân, không nới assertion/timeout. Lưu để debug khi có thời gian: [bằng chứng và cách tái hiện](../../docs/adaptive-agent-flow/known-test-failures-2026-11-07.md).

  Thêm 11/11: lượt suite đầy đủ có `after scheduler crash…` (worker giả không khởi động kịp) và `parallel writers run concurrently…` (đỉnh writer 1 thay vì 2) lỗi; chạy riêng đạt 2/2.

- OpenCode: chặn ghi ra ngoài worktree trước khi dùng cho bước sửa code #task[id:tsk_01M74TQVRB7MD5JJJP0ZZ6Q7T2 status:to-do priority:high created:2026-11-11]

  Probe 08/11 (OpenCode 1.18.25): quyền `edit` chỉ cho `allowed/*` nhưng ghi được file ngoài repo qua junction. Runner hiện cho bước sửa chạy chỉ với bằng chứng dừng process (`sandboxVerified: false`), theo quyết định người dùng 11/11. Cần cơ chế bảo vệ (từ chối junction/symlink, kiểm baseline ngoài worktree) hoặc probe lại với 1.19.5. Bản 1.19.5 chưa qua probe đối kháng.

- "Xem session gốc" không đọc lại được bước plan/review chạy bằng OpenCode #task[id:tsk_01M74TQVRB4GBNTP7ES8EFT5YB status:to-do priority:low created:2026-11-11]

  OpenCode 1.19.5 trả HTTP 400 (`Expected OutputFormatJsonSchema`) khi liệt kê tin nhắn của session có yêu cầu json_schema. Hoạt động NeoMind ghi trong lúc chạy vẫn xem được. Có thể đọc qua `/api/session/:id/message` hoặc chờ bản OpenCode sửa lỗi.

- Kiểm MCP standalone với Claude Code và Codex CLI thật #task[id:tsk_01M74TQVRBKH6VWN0K21AEV3EF status:to-do priority:medium created:2026-11-11]

  `neomind mcp <project>` đã khôi phục và đạt test stdio; chưa đăng ký với một session Claude/Codex thật (README có lệnh). Chưa kiểm trên Linux.

- Giao diện cho chương trình nhiều giai đoạn #task[id:tsk_01M74TQVRBJQYFTTAM03Z1FJHQ status:to-do priority:medium created:2026-11-11]

  Tạo chương trình từ UI (hiện chỉ tool/CLI/API) và nút "Đánh dấu đã giao" cho giai đoạn (hiện chỉ `program_deliver`). Xem bàn giao nâng cấp 06/11.

- Màn thống kê run riêng #task[id:tsk_01M74TQVRBV2P9YK6FFNN92AS4 status:to-do priority:low created:2026-11-11]

  Số liệu `run stats` đã có ở CLI/tool/API; UI mới chỉ dùng cho ước tính ở Run mới.

- Cập nhật lệnh `/neomind:run` cho chương trình và thống kê #task[id:tsk_01M74TQVRBB8EJP67MY9NKG32M status:to-do priority:low created:2026-11-11]

  `extensions/nimbalyst/claude-plugin/commands/run.md` chưa hướng dẫn dùng `program_*` và `stats`.

- Chạy lại `npm test` đầy đủ sau các sửa OpenCode và xóa run #task[id:tsk_01M74TQVRB2TYXEZ31A170W7C7 status:to-do priority:medium created:2026-11-11]

  Sau commit `df1249d` và `8e636fc` mới chạy test liên quan (OpenCode, xóa/chạy lại run, editor API); lượt đầy đủ gần nhất (274 test) có 1 ca OpenCode lỗi đã sửa sau đó.

- Quyết định còn mở #task[id:tsk_01M74TQVRBYX41ZTED66BS7SVY status:to-do priority:low created:2026-11-11]

  (1) Có tắt việc Codex tự đọc `AGENTS.md` để hai runner chỉ nhận `rules.md` không. (2) `assess` có tự đổi sang flow giao kết quả tốt hơn khi đủ thống kê, hay chỉ gợi ý như hiện tại.

## Đã làm

- Cho phép xóa workflow do người dùng tạo ngay trên giao diện #task[id:tsk_01M6TE6H2RXGZSN65JHYFVKBCZ status:done priority:medium created:2026-11-07]

  Đã có từ trước: Flow Studio › menu "…" › "Xóa vĩnh viễn…", phải gõ đúng tên flow để xác nhận; chỉ áp dụng cho flow trong thư viện project, template có sẵn không xóa được. Run đã chạy giữ snapshot flow riêng nên vẫn đọc được sau khi xóa.

- Khôi phục MCP standalone, chạy lại run và runner OpenCode từ bản build 08/11 #task[id:tsk_01M74TQVRBGYVVNT7XVYYWQWJY status:done priority:high created:2026-11-11]

  Source mất do zip bị cắt ở 30 MiB; dựng lại từ JS biên dịch, đối chiếu output khớp bản gốc. Commit `10826c0`, `727087c`, `81ff331`, `65799ed`.

- Chọn OpenCode và provider ở Run mới và Flow Studio #task[id:tsk_01M74TQVRBFRBVG353KG7ZW5TE status:done priority:medium created:2026-11-11]

  Commit `1aa8f3b`; nhận OpenCode 1.19.5 (`dc78632`); tìm được OpenCode khi Windows đặt tên biến là `Path` (`085ea3d`); cột Runner đủ rộng cho 3 nút (`596ed4a`). Giữ nguyên toàn bộ model của OpenCode theo quyết định người dùng.

- Sửa OpenCode lặp ở bước plan/review và hiển thị hoạt động #task[id:tsk_01M74TQVRBBPXHFJ37Z2CZMD6H status:done priority:high created:2026-11-11]

  Cho phép tool `StructuredOutput`, giới hạn 60 lượt model mỗi bước, hiển thị đọc/tìm/sửa/lệnh/kết quả từ luồng sự kiện `/event`. Commit `5fd01d6`, `df1249d`. Run thật `run-450e4827` trên `leetcode-practice` (plan GPT-6.1 Sol, implement GPT-6 Luna) hoàn tất sau 147 giây.

- Xóa run đã xong và chạy lại run cũ từ danh sách #task[id:tsk_01M74TQVRB2STAFF06B3JBS2AB status:done priority:medium created:2026-11-11]

  Menu "…" trên từng run: "Chạy lại" (run đã xong/hủy/tạm dừng/bị chặn) và "Xóa run" (run đã xong/hủy, xóa journal, transcript, worktree, ref snapshot); "Xóa mọi run đã xong" ở nhóm Gần đây; "Xóa run" trong màn chi tiết. Commit `8e636fc`.
