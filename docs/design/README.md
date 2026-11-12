# NeoMind Flow Studio · Thiết kế UI

> [!NOTE]
> **Thiết kế lại v2 (đã chốt 05/11/2026):** xem [redesign-plan.md](redesign-plan.md) và các mockup `10`–`20` có hậu tố `-v2`. Mockup `00`–`09` và design system tông clay bên dưới là v1, giữ lại làm lịch sử; bảng quyết định cuối trang vẫn áp dụng cho các phần cần backend.

Tài liệu này là chỗ thảo luận và sửa thiết kế UI. Mỗi màn có một mockup `.mockup.html` trong [mockups/](mockups/); mở trong Nimbalyst để xem, vẽ ghi chú trực tiếp lên mockup, hoặc sửa HTML. Phần chưa có trong code được đánh dấu **ĐỀ XUẤT** (viền cam nét đứt).

Quy trình đề xuất:

1. Thảo luận trên mockup (vẽ ghi chú, comment, hoặc ghi vào mục *Câu hỏi mở* dưới mỗi màn).
2. Chốt: chuyển đề xuất thành *Đã chốt* ở bảng cuối trang.
3. Code theo mockup đã chốt; sau khi code xong, mockup được cập nhật để khớp với UI thật.

### Bấm thử mockup

Mockup là prototype bấm được (khối `NEOMIND PROTOTYPE SCRIPT` cuối mỗi file):

- **Trong cùng màn:** tab, chip, thẻ chọn flow, thiết lập nhanh, nút gạt runner, tab diff, bộ lọc và công tắc quyền đổi trạng thái khi bấm; nút "Sao chép" báo đã chép; ô nhập gõ được.
- **Chuyển màn:** "＋ Run mới" → Run mới → "Bắt đầu" → Chờ duyệt → "Duyệt và thực hiện" → Đang chạy; bấm một run trong Lịch sử theo trạng thái của nó (Cần xử lý, Hoàn tất…); sidebar sang Flow studio, Profiles, Memory; nút "☰ Màn" góc dưới phải để nhảy tới bất kỳ màn nào.
- **Ở đâu:** mở file `.mockup.html` trong trình duyệt (Edge/Chrome) thì chuyển màn thật. Trong Nimbalyst, bật chế độ *Interactive* trên thanh công cụ của mockup; mọi tương tác trong màn hoạt động, còn khi bấm nút chuyển màn thì hiện thông báo tên file cần mở (Nimbalyst hiển thị từng file riêng).
- Nút chưa gắn hành động hiện thông báo "mockup chưa gắn hành động".

Code hiện tại: `ui/src/` (React). Ảnh chụp UI thật được tạo bằng Edge headless khi kiểm tra.

## Design system v2 — hiện hành

Token sáng/tối nằm trong `ui/src/theme.css`; component dùng chung trong `ui/src/components/ui/`, CSS màn trong `flow-studio.css` và `profiles-memory.css`. Tailwind preflight chạy trong layer `base`, React Flow trong layer `xyflow`; portal nhận container trong lớp theme. Chạy vite dev và mở `/__gallery/` để xem component, hoặc `runs.html`, `flow.html`, `profiles.html`, `memory.html` trong `/__gallery/` để xem màn với dữ liệu giả. Màu chỉ dùng cho trạng thái; clay dành cho logo.

[Design system v2](mockups/11-design-system-v2.mockup.html "width=1100 height=900")

## Thiết kế v1 — lịch sử

Mockup v1 (`00`–`09`) và phần mô tả từng màn đã gỡ khỏi repo ngày 12/11/2026 vì UI hiện hành theo v2; xem lại bằng `git show archive/docs-2026-11-12:docs/design/README.md`. Bảng quyết định bên dưới vẫn giữ.

## Tổng hợp đề xuất

Các câu hỏi cần chốt trước khi code đề xuất. Ghi quyết định vào cột cuối.

| # | Màn | Câu hỏi | Gợi ý | Quyết định |
| --- | --- | --- | --- | --- |
| 1 | Bị chặn | Khi reviewer không kết luận được, NeoMind có tự chạy lại review kèm diff trước khi dừng không? | Có (đã đưa diff vào prompt; thêm 1 lượt tự động) | |
| 2 | Bị chặn | Cho phép người dùng "tự duyệt" thay reviewer bắt buộc? | Cho phép, ghi rõ vào lịch sử; flow có thể tắt | |
| 3 | Hoàn tất | "Áp dụng vào branch": chỉ cherry-pick, hay thêm tạo branch mới / merge? Checkout bẩn thì khóa nút hay stash? | Cherry-pick + tạo branch mới; checkout bẩn thì khóa kèm lý do | |
| 4 | Hoàn tất / Bị chặn | Diff đặt ở một thẻ "Thay đổi" dùng chung từ sau Implement, thay vì nằm trong Kết quả? | Một thẻ dùng chung | |
| 5 | Đang chạy | Luồng hoạt động hiện mức chi tiết nào (chỉ thao tác file/check, hay cả tin nhắn agent)? Giữ lại sau khi xong? | Chỉ thao tác; sau khi xong gộp vào Logs | |
| 6 | Đang chạy / Hoàn tất | Thời gian và token từng bước: hiện trên stepper luôn, hay chỉ trong bảng chi phí lúc xong? | Bảng chi phí; stepper chỉ thời gian | |
| 7 | Chờ duyệt | Bước "Approve plan" nên tô amber (cần bạn) thay vì xanh "Sẵn sàng"? | Amber | |
| 8 | Chờ duyệt | "File dự kiến sửa" trong plan: giới hạn mềm (cảnh báo) hay cứng? | Mềm | |
| 9 | Run mới | Thẻ flow thay hẳn ô chọn, hay chỉ khi ít flow (≤ 6)? Thiết lập nhanh có thu gọn bảng không? | Thẻ khi ≤ 6; chỉnh tay tự chuyển sang "Tùy chỉnh" | |
| 10 | Run mới | Ước tính token/thời gian chỉ hiện khi có ít nhất 3 run cùng flow + runner? | Có | |
| 11 | Flow studio | Ngăn "Vấn đề" mở ở cuối canvas hay thành tab trong inspector? Cảnh báo có chặn "Lưu phiên bản"? | Cuối canvas; chỉ lỗi mới chặn | |
| 12 | Flow studio | "Thử flow" là mô phỏng phía UI (chọn pass/needs_changes ở mỗi nhánh) hay chạy thật với runner giả? | Mô phỏng phía UI | |
| 13 | Profiles | Lưu phiên bản profile mới: đề nghị chuyển các flow đang dùng bản cũ sang luôn? | Đề nghị, không tự chuyển | |
| 15 | Đang chạy | Từ 3 agent song song trở lên: lưới, tab, hay chỉ mở luồng của bước đang chọn? | Lưới 2 cột, bước thứ 3 trở đi thu một dòng | |
| 16 | Đang chạy / Xem session | Giới hạn lưu: số dòng khi đọc file, output lệnh, kích thước diff; có lưu phần suy nghĩ của Claude không? | 200 dòng output, 60 dòng mỗi lần đọc; suy nghĩ chỉ lưu bản tóm tắt | |
| 17 | Xem session | Bản NeoMind ghi và lịch sử gốc lệch nhau (lượt bị cắt, Claude đã dọn session): hiện chỗ thiếu hay tự chuyển nguồn? | Hiện rõ chỗ thiếu, cho chuyển nguồn bằng tay | |
| 18 | Đang chạy | Khi bước xong: luồng giữ nguyên, thu thành tóm tắt, hay chuyển vào Xem session? | Thu thành tóm tắt (file đã sửa, lệnh, token) + link Xem session | |
| 14 | Memory | "Bỏ qua" lesson có cần ghi lại để lesson không đề xuất lại? "Sửa rồi duyệt" có cần không? | Có ghi; sửa rồi duyệt tạo bản đề xuất mới | |

Đề xuất nào cần đổi backend:
- **Luồng hoạt động và thời gian/token từng bước:** cần sự kiện tool từ runner và usage theo attempt qua API.
- **File dự kiến sửa:** cần thêm trường vào schema của plan.
- **Diff, áp dụng vào branch:** cần endpoint diff của commit và cherry-pick an toàn.
- **Bỏ qua lesson:** cần receipt từ chối.
- **Ước tính:** cần tổng hợp usage của các run cũ.
- **Hoạt động trực tiếp, Xem session:** cần ghi transcript chuẩn hóa từ adapter Claude/Codex, API đọc transcript (và lịch sử gốc cho run cũ).
