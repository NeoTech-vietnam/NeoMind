# Report thảo luận: NeoMind Adaptive Agent Flow + Nimbalyst

Ngày ghi nhận: 28/10/2026. Nhánh: `hieu/adaptive-agent-flow`.

Trạng thái: research và thảo luận thiết kế. Tài liệu ghi lại lựa chọn của người dùng cùng các đề xuất cần thảo luận; chưa phải đặc tả triển khai đã chốt.

## Bối cảnh và phạm vi report

Người dùng muốn phát triển hướng riêng để có thể thử nghiệm quy trình phù hợp phong cách làm việc của mình, song song với hướng controlled workflow của Thạch. Nhánh được chọn là `hieu/adaptive-agent-flow`, bắt đầu tại `0cc5f56`; đây là baseline tài liệu, không chứa implementation controlled workflow đã khảo sát ở nhánh của Thạch.

Trong trao đổi trước, controlled workflow được nhận xét là có nhiều vai, chế độ và bước quản lý. Mục tiêu của hướng mới là tìm mức quy trình vừa đủ để giảm bỏ sót và kiểm tra kết quả, đồng thời kiểm soát chi phí và độ phức tạp sử dụng. Đây là động lực thiết kế, chưa phải kết luận benchmark về hệ thống của Thạch.

Report này lưu nội dung thảo luận sản phẩm, đặc biệt bốn định hướng người dùng nêu về Nimbalyst, phiên bản đầu, ranh giới NeoMind và memory/feedback. Đây là bản tổng hợp, không phải transcript nguyên văn.

Nghiên cứu trước về workflow tùy biến, project memory và các repo tham khảo được lưu ở [report ngày 26/10/2026](https://github.com/NeoTech-vietnam/NeoMind/blob/543ef16/docs/research/adaptive-project-workflows-2026.md). Các nguồn trong report trước là khảo sát tài liệu/source tại thời điểm đó, chưa được chạy thử hay kiểm tra lại trong lần tổng hợp này.

## 1. Nhu cầu và lý do

Người dùng hiện dùng Nimbalyst để quản lý session của nhiều provider độc lập, task, liên kết task–session và Kanban. Theo trải nghiệm người dùng, một session có thể yêu cầu tạo session trên công cụ/provider khác; Dev Extension cho phép xây giao diện bổ sung. Đây là nhu cầu tích hợp đã xác nhận, chưa phải kết quả kiểm chứng API Nimbalyst trong phase này.

NeoMind cần tận dụng các khả năng đó để cung cấp quy trình làm việc đủ rõ và có bước kiểm tra kết quả. Giả thuyết cần đo là workflow phù hợp sẽ giảm bỏ sót và nâng chất lượng; workflow quá lớn làm tăng chi phí token và có thể tăng thời gian điều phối. Workflow không mặc nhiên tốt hơn agent đơn lẻ.

Adaptive flow hướng đến lựa chọn mức quy trình vừa đủ cho task, dựa trên yêu cầu chất lượng, độ quan trọng, thời gian và chi phí. Phase đầu chỉ cần một flow mặc định để xác lập trải nghiệm và kiểm chứng giả thuyết.

## 2. Các lựa chọn đã được người dùng nêu

| Nội dung | Định hướng |
| --- | --- |
| Cách phát triển | Research và thiết kế trước, cùng thảo luận để làm rõ nhu cầu rồi mới triển khai |
| Công cụ làm việc | Tận dụng Nimbalyst để phối hợp với NeoMind |
| Vai trò Nimbalyst | Quản lý/hiển thị session và task; visualize và điều khiển workflow qua tích hợp |
| Vai trò NeoMind | Chứa và cung cấp quy tắc workflow, agents, skills, hooks và các thành phần cần thiết |
| Phiên bản đầu | Một workflow mặc định, có visualization trên Nimbalyst ngay từ đầu |
| Memory ban đầu | Dùng Markdown, tổ chức để truy xuất theo nhu cầu |
| Memory về sau | Hướng đến SQLite làm trung tâm truy xuất nhanh hơn; cần thiết kế migration |
| Đánh giá workflow | Người dùng đánh giá; lưu ý kiến và feedback qua các lần chạy |

Các hướng đã trao đổi trước, tiếp tục nghiên cứu: agents/skills/workflows theo project; workflow thiết kế bằng file hoặc kéo thả; level 1–5; benchmark; chọn flow theo task/ngân sách và cải thiện dựa trên dữ liệu. Chưa đưa toàn bộ các khả năng này vào yêu cầu phiên bản đầu.

Level cao hơn dự kiến có nhiều bước kiểm soát hoặc ngân sách lớn hơn; không mặc nhiên có chất lượng cao hơn. Agents/skills dùng chung có thể được chuyên môn hóa theo project. Cơ chế cải thiện nên tạo phiên bản ứng viên, giữ lịch sử và đánh giá trước khi áp dụng; cách tự động hóa phần này còn mở.

## 3. Phân chia trách nhiệm đề xuất

| Lớp | Trách nhiệm đề xuất | Điểm cần xác minh |
| --- | --- | --- |
| Nimbalyst | Tạo/quản lý session, kết nối công cụ/provider, task board và giao diện extension | API tạo session, truyền input, đọc kết quả, lifecycle events, quyền và liên kết task |
| NeoMind | Định nghĩa flow, vai agent, skills, điều kiện chuyển bước, bàn giao context, memory và feedback | Thành phần nào là instructions, thành phần nào cần code thực thi/kiểm tra |
| Tích hợp | Ánh xạ workflow run/node sang task/session; đồng bộ lệnh điều khiển và trạng thái | Cơ chế extension/MCP/CLI phù hợp, lưu trạng thái và xử lý gián đoạn |

Ranh giới này là đề xuất, chưa chọn công nghệ hay xác nhận có sẵn adapter. Cần quyết định ai chịu trách nhiệm tạo session kế tiếp và kiểm tra điều kiện hoàn tất bước. Nếu chỉ hướng dẫn agent bằng skill thì không được coi đó là điều kiện đã được cưỡng chế bởi runtime.

Nimbalyst tiếp tục sở hữu lịch sử session gốc. NeoMind dự kiến giữ các liên kết cần thiết để nối run, node, task, session, artifacts và feedback. Không cần sao chép toàn bộ transcript vào project memory để đạt mục tiêu liên tục context.

## 4. Phạm vi phiên bản đầu cần cùng chốt

Yêu cầu đã có: một flow mặc định và visualization/điều khiển qua Nimbalyst. Luồng cụ thể vẫn cần chọn từ một công việc thực tế của người dùng.

Một ứng viên để thảo luận cho task lập trình:

```text
Làm rõ yêu cầu -> Lập kế hoạch -> Thực hiện -> Kiểm tra -> Người dùng đánh giá
```

Đây là các bước logic, không đồng nghĩa mỗi bước tạo một agent/session riêng. Có thể cùng session cho các bước liên quan; cần thảo luận bước nào thực sự hưởng lợi từ session độc lập và phần context phải bàn giao.

Visualization đề xuất hiển thị flow đang chạy, bước hiện tại, task/session liên quan, kết quả và trạng thái chờ can thiệp. Giao diện chỉnh graph bằng kéo thả chưa được người dùng yêu cầu là điều kiện bắt buộc của phiên bản đầu.

Tiêu chí nghiệm thu đề xuất:

- Một yêu cầu thực tế đi qua flow mặc định và có đầu ra kiểm tra được.
- Người dùng nhìn được bước đang chạy cùng task/session tương ứng trong Nimbalyst.
- Kết quả kiểm tra và nhận xét người dùng được lưu, có thể tìm lại theo lần chạy.
- Khi một bước thất bại, trạng thái hiển thị đúng và người dùng biết hành động tiếp theo.
- Đánh giá mức chi phí/thời gian bằng dữ liệu có thể quan sát; ghi rõ trường nào chưa đo được.

## 5. Memory Markdown và feedback

Đề xuất chia thông tin thành project context, quyết định, lessons và run summaries. Mỗi mục có ID, nguồn, phạm vi, ngày cập nhật; thông tin phụ thuộc code có thể tham chiếu commit/file. Agents đọc mục lục và phần liên quan, không mặc định nạp toàn bộ memory.

Feedback cần tách khỏi sự thật kỹ thuật: nhận xét người dùng là đánh giá có giá trị nhưng không thay thế test results. Nên liên kết mỗi feedback với run ID, flow version và đầu ra được đánh giá.

Các trường feedback đề xuất:

- Người dùng có hài lòng/đạt mục tiêu hay không, cùng nhận xét tự do.
- Bước hữu ích, bước dư thừa và bước bị thiếu.
- Chỗ người dùng phải sửa hoặc can thiệp.
- Cảm nhận về thời gian và chi phí, tách khỏi telemetry đo được.
- Đề xuất thay đổi và tình trạng xử lý đề xuất.

Định dạng đánh giá và thang điểm chưa chốt. Giữ nhận xét gốc; bản tổng hợp do agent tạo phải tham chiếu về nguồn. Lưu feedback chưa đồng nghĩa tự sửa flow sau mỗi lần chạy.

SQLite về sau cần giữ IDs/provenance và import/export được dữ liệu Markdown. Cần quyết định dữ liệu nào trở thành nguồn chuẩn trong DB, dữ liệu nào vẫn thuộc Git/files; không duy trì hai bản có quyền cập nhật ngang nhau mà thiếu quy tắc đồng bộ.

## 6. Câu hỏi nghiên cứu và thảo luận tiếp

1. Task thực tế đầu tiên dùng để thiết kế flow mặc định là gì? Đầu ra nào khiến người dùng coi là hoàn thành?
2. Bước kiểm tra do session/model độc lập thực hiện hay cùng session? Cần kiểm chứng bằng công cụ nào?
3. Người dùng muốn chọn provider/model ở đâu; flow có model mặc định hay dùng lựa chọn từ Nimbalyst?
4. Điều khiển phiên bản đầu cần những thao tác nào: bắt đầu, xác nhận kế hoạch, dừng, tiếp tục, chạy lại bước?
5. Nimbalyst hỗ trợ chính xác API/event nào cho Dev Extension, session và task? Cần một thử nghiệm tích hợp nhỏ để xác nhận.
6. Ai sở hữu trạng thái chuyển bước, và làm sao tránh tạo trùng session khi gián đoạn hoặc gửi lệnh lại?

Chưa thực hiện triển khai, migration memory hay benchmark trong tài liệu này. Việc tiếp theo là chọn một task đại diện, mô tả hành trình người dùng, rồi khảo sát API Nimbalyst phục vụ đúng hành trình đó trước khi chốt kiến trúc.
