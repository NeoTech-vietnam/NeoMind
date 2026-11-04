# Bàn giao — 03/11/2026

Baseline `c99f18b`, branch `hieu/adaptive-agent-flow`. Người dùng yêu cầu thực hiện toàn bộ [plan workflow, memory và Flow Studio](next-plan-workflow-memory-studio.md); **chưa hoàn tất**, cần tiếp tục các mục còn mở trong bảng tiến độ của plan, đặc biệt P4. Những thay đổi đợt này hiện nằm trong working tree; kiểm tra `git status` và giữ nguyên trước khi làm tiếp.

Đã triển khai: policy Fast opt-in tại compile cho run mới, đọc lại snapshot cũ; cleanup kiểm tra branch ref/baseline, giữ ignored files nếu chưa được phép bỏ; graph run từ snapshot và node detail, history filters, cảnh báo mất đồng bộ; UI palette, shortcuts, so sánh draft/version; memory preview và metadata snapshot, queue/duyệt/từ chối lesson với receipt. Các thay đổi trong `RunGraph`, `FlowVersions` và plan là file mới chưa được theo dõi.

Kiểm chứng Linux: `npm test` 190 test, 179 pass, 11 skip, 0 fail; `npm run build:ui` và build extension Nimbalyst thành công. Test browser UI mới, Windows và inference thật chưa chạy; browser automation từng bị từ chối quyền trong phiên này, không vượt qua hạn chế. UI bundle có cảnh báo kích thước >500 kB; extension backend build có cảnh báo `dist-ui` runtime URL.

Ưu tiên tiếp: hoàn thiện browser acceptance và accessibility, node insertion/multi-copy và diff đầy đủ; chọn memory tự động theo path và sửa proposal có version; graph song song tổng quát, nhiều integration, current/shared workspace và Nimbalyst notifications. Không bỏ các chặn preflight khi chưa có enforcement. Cleanup vẫn có race với writer ngoài NeoMind giữa lần kiểm tra cuối và Git remove; nội dung ignored đã được xác nhận bỏ được hash theo byte khi ghi intent và kiểm tra lại khi recovery. Không claim P0 race đã giải quyết triệt để. Xem bảng trong plan để tiếp tục mà không làm lại phần đã có.

Bổ sung: có UI/API cấu hình chọn memory (scope, tags, lexical match, số record, bytes), lưu policy trong snapshot và kiểm tra revision toàn bộ project. Preview đọc cùng policy; thay đổi áp dụng cho run mới.
