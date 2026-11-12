# Bàn giao sửa worktree submodule — 12/11/2026

`primaryWorktree` xử lý trường hợp Git liệt kê thư mục Git chung thay vì checkout của submodule: giải quyết `core.worktree` tương đối theo thư mục Git chung và xác minh cả worktree lẫn repository. Repository thông thường tiếp tục dùng worktree đầu tiên trong danh sách Git.

Kiểm thử trên Linux: `npm test` 348 test, 336 đạt, 0 lỗi, 12 skip. Test mới tạo submodule thật và linked worktree, kiểm tra memory chung, chặn isolated write/commit ở checkout chính và cho phép tại linked worktree. Đã kiểm tra đường dẫn thực tế của NeoKnowledge và NeoMind; build extension Nimbalyst đạt. Chưa chạy run thật, kiểm thử Windows, hoặc xác nhận backend extension trong Nimbalyst đang chạy.
