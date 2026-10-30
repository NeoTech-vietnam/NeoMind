# NeoMind Flow Studio · Thiết kế UI

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

## Design system

Giao diện dùng nền tối theo tông Claude Code: nền than ấm `#1f1e1d`/`#262624`, chữ trắng ngà `#f2efe8`, màu nhấn clay `#d97757` (nút chính `#c15f3c`). Đánh dấu ĐỀ XUẤT dùng xanh teal để không lẫn với màu nhấn. Trang này gồm màu, chữ, nhãn trạng thái, nút, ô nhập, callout và quy ước. Khối CSS `NEOMIND SHARED STYLES` trong file này được chép nguyên vào mọi mockup khác.

[Design system](mockups/00-design-system.mockup.html "width=1100 height=900")

## Runs

### 1. Run mới

Đã có: bảng "Agent cho từng bước" (runner gạt Codex/Claude Code, model, mức suy luận), cấu hình tự cập nhật, giới hạn theo phút, cảnh báo thay đổi chưa commit, lý do khi nút Bắt đầu bị khóa.
Đề xuất: chọn flow bằng thẻ có chuỗi bước; thiết lập nhanh ("Claude viết · Codex review", "Toàn Claude", "Toàn Codex"); ước tính token và thời gian.

[Run mới](mockups/01-run-start.mockup.html "width=1100 height=1450")

### 2. Chờ duyệt kế hoạch

Đã có: thẻ kế hoạch nổi bật (mục tiêu, cách làm, tiêu chí, phạm vi, checks), ô góp ý, nút "Duyệt và thực hiện".
Đề xuất: callout nói rõ "chưa file nào bị sửa"; danh sách file dự kiến sửa (cần thêm vào schema của plan); chuyển phiên bản kế hoạch và xem khác biệt; góp ý nhanh bằng chip.

[Chờ duyệt kế hoạch](mockups/02-run-approval.mockup.html "width=1100 height=1530")

### 3. Đang chạy

Đã có: badge nhấp nháy, bước đang chạy được tô sáng, nút Tạm dừng và Hủy run.
Đề xuất: **Hoạt động trực tiếp** cho từng agent đang chạy (ví dụ flow song song: Claude và Codex cạnh nhau) — đọc file, tin nhắn, sửa file kèm diff, chạy lệnh với output chạy dần, tóm tắt suy luận, lọc theo loại, tự cuộn; thời gian và token từng bước; thanh ngân sách thời gian. Nguồn: transcript NeoMind tự ghi trong lúc chạy (xem [session-transcripts.md](../adaptive-agent-flow/session-transcripts.md)).

[Run đang chạy](mockups/03-run-running.mockup.html "width=1100 height=1500")

### 4. Cần xử lý (bị chặn)

Đã có: lý do thô, nút Tiếp tục, các tiêu chí của reviewer và finding, lượt review cũ làm mờ.
Đề xuất: khung "Vì sao run dừng?" bằng lời thường; 4 lựa chọn xử lý (chạy lại review kèm diff, đổi reviewer sang Codex, tự xem diff và duyệt, hủy run); diff đang được review.

[Run bị chặn](mockups/04-run-blocked.mockup.html "width=1100 height=2700")

### 5. Hoàn tất

Đã có: commit hash, file đã đổi, lệnh `git cherry-pick` có nút chép, kết quả checks và review.
Đề xuất: xem diff ngay trong trang; nút "Áp dụng vào branch main" (NeoMind tự cherry-pick, gặp conflict thì hủy an toàn); bảng chi phí theo từng bước; thẻ lesson dễ đọc hơn.

[Run hoàn tất](mockups/05-run-completed.mockup.html "width=1100 height=2520")

### 6. Xem session

Mở từ "Xem session" trên một bước agent: ngăn bên với dòng thời gian từng lượt (lượt bị dừng gắn nhãn riêng), prompt thu gọn, đọc/sửa/lỗi công cụ, suy nghĩ thu gọn, output có cấu trúc, token; chuyển giữa bản NeoMind ghi và lịch sử gốc của Claude Code/Codex (cho run cũ); chỉ xem, không tiếp tục session. Có biến thể cho session reviewer Codex (lệnh + output, verdict).

[Xem session](mockups/09-session-viewer.mockup.html "width=1100 height=2850")

## Flow studio

Đã có: cột icon thêm bước, canvas rộng, inspector đưa runner/model lên đầu (kỹ thuật nằm trong "Nâng cao"), menu Quản lý, chip runner trên thẻ.
Đề xuất: chip "Mặc định → Codex · GPT-6 Luna" cho thấy runner thật khi bước dùng mặc định; ngăn "Vấn đề" liệt kê lỗi kiểm tra và nhảy tới bước; nút "Thử flow" chạy đồ thị với kết quả giả lập.

[Flow studio](mockups/06-flow-studio.mockup.html "width=1100 height=1700")

## Agent profiles và Project memory

Hai trang này mới chỉ đổi cỡ chữ và màu, bố cục vẫn là form đơn giản với JSON; mockup là đề xuất làm lại.

- **Agent profiles:** danh sách chia "Có sẵn" và "Của project"; chip phiên bản (đang dùng bởi flow nào); quyền dạng công tắc có giải thích; skills dạng bảng thay cho JSON, cảnh báo file đổi sau khi ghim hash; "Được dùng ở" các bước nào.
- **Project memory:** hàng đợi "Lessons chờ duyệt" gom từ mọi run; lọc theo loại và phạm vi; bảng bản ghi; panel chi tiết (nguồn, tags, revision, run đang ghim).

[Agent profiles](mockups/07-profiles.mockup.html "width=1100 height=1400")

[Project memory](mockups/08-memory.mockup.html "width=1100 height=1260")

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
