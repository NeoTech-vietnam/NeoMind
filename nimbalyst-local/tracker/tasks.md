# Backlog NeoMind

Các mục dưới đây được ghi nhận ngày 07/11/2026 để làm sau, chưa triển khai.

- Kiểm tra model và mức suy luận khả dụng của runner trước khi cho chọn/chạy flow #task[id:tsk_01M6TE6H2RRTWJK611YDMSHRMB status:to-do priority:medium created:2026-11-07]

  Đọc danh sách model thực tế từ runner/CLI đang dùng, đối chiếu allowlist của NeoMind và hiển thị đúng trên UI. Chỉ cho chọn mức suy luận runtime hỗ trợ; model đã ghim nhưng không khả dụng phải có lý do rõ ràng. Không tự đổi model hoặc bỏ kiểm tra quyền/fallback. Bối cảnh: UI cho chọn Sol 6.1/Terra 6.1 nhưng Codex CLI 0.155.1 trên máy không trả hai model này, trong khi Luna 6 có sẵn.

- Cho phép xóa workflow do người dùng tạo ngay trên giao diện #task[id:tsk_01M6TE6H2RXGZSN65JHYFVKBCZ status:to-do priority:medium created:2026-11-07]

  Thêm thao tác xóa trong danh sách/chi tiết workflow, có xác nhận và cập nhật danh sách sau khi xóa. Chỉ áp dụng cho workflow của project do người dùng tạo; không xóa template có sẵn. Lịch sử và kết quả các run đã chạy vẫn đọc được sau khi workflow bị xóa.

- Điều tra hai ca test process/reviewer không ổn định trên Windows #task[id:tsk_01M6THTA65JPX4WTD4TWPEW3CB status:to-do priority:low created:2026-11-07]

  Suite fail nhưng chạy riêng pass; chưa xác định nguyên nhân, không nới assertion/timeout. Lưu để debug khi có thời gian: [bằng chứng và cách tái hiện](../../docs/adaptive-agent-flow/known-test-failures-2026-11-07.md).
