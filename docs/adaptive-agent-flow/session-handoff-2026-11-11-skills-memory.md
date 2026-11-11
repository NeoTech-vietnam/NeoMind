# Bàn giao Skills/Agents và Memory — 11/11/2026

Làm theo [plan đã duyệt](plan-skills-agents-memory-2026-11-11.md). Hai mảng làm song song bằng hai session Claude Opus trong worktree riêng (`feat/skills-agents`, `feat/memory`), session điều phối rebase mảng B lên mảng A, giải xung đột (chuỗi Usage của CLI, gallery, tài liệu) và gắn `StepMemoryField` vào inspector. Chi tiết từng mảng: mục "Skills và Agents — 11/11" và "Memory — 11/11" trong [implementation-status](implementation-status.md).

## Đã có

- **Skills:** màn Skills soạn/xóa `neomind/skills/<id>/SKILL.md` (file phụ, xem đoạn chèn vào prompt, liệt kê nơi dùng, "Ghim lại tất cả"); `.claude/skills` chỉ đọc. Tool `skill_*`, quyền `ai.skillEdit`.
- **Agents** (đổi tên từ Profiles; code/API vẫn là `profile`): 6 mẫu, nút "Lưu" = lưu + publish rồi đề nghị cập nhật flow, xóa an toàn/lưu trữ; tool `profile_archive`, `profile_delete`.
- **Flow Studio:** mỗi bước agent/reviewer/integration có mục Skills ("Theo agent"/"Riêng cho bước này") và **Memory cho bước này** ở phần chính inspector; thẻ bước có chip "N skill"; Run mới liệt kê skill từng bước.
- **Memory:** mặc định `neomind/memory` trong repo; tool `memory_search/get/propose/pending/approve/reject`; đề xuất tự sinh từ yêu cầu sửa plan, rule bị vi phạm, run bị chặn, nút "Ghi nhớ điều này"; memory theo vai trò cho flow mới (`memoryDefaults: "role"`); "Memory đã dùng" mỗi bước với đánh giá Hữu ích/Không liên quan/Sai ảnh hưởng xếp hạng; trang Memory thêm/sửa/hết hạn/thay thế/xóa.

## Kiểm chứng (Windows)

- Mảng A riêng: 281 test, 279 pass, 2 skip. Mảng B riêng: 283 test, 281 pass, 2 skip.
- Bản gộp: xem `implementation-status.md` (mục Memory).
- Ảnh gallery tối/sáng × 1440/900 của cả hai mảng; ảnh inspector sau khi gắn `StepMemoryField` (agent task và reviewer).
- Chưa kiểm trong panel Nimbalyst thật; chưa chạy run thật với memory theo bước.

## Việc còn lại

- Dùng thật trên `leetcode-practice`: tạo vài skill/agent, chạy run, đánh giá memory để có dữ liệu xếp hạng.
- Backlog chung: `nimbalyst-local/tracker/tasks.md`.
