# Report thảo luận: NeoMind Adaptive Agent Flow + Nimbalyst

**Định hướng cập nhật:** [Thiết kế tổng hợp v1](design-v1.md) là bản đọc/triển khai chính theo yêu cầu mới: Codex tự hoàn thiện thiết kế và giao chat GPT-6.1 Terra bắt đầu implementation. Report này giữ bối cảnh nghiên cứu và quyết định lịch sử; giới hạn “chỉ research” bên dưới không thay thế yêu cầu implementation mới.

**Cập nhật thiết kế:** [12 quyết định v1 của người dùng](v1-design-decisions.md) chốt thêm flow, approval, verification, workspace, Git và memory. Áp dụng các quyết định mới đó khi phần report bên dưới còn ghi những điểm tương ứng là đề xuất/chưa chốt.

Ngày ghi nhận: 28/10/2026. Nhánh: `hieu/adaptive-agent-flow`.

Trạng thái: đã thống nhất định hướng kiến trúc trong thảo luận ngày 28/10/2026; đang research và thiết kế chi tiết. Chưa triển khai runtime hay xác nhận tích hợp end-to-end. Chi tiết ranh giới và contract đề xuất nằm trong [thiết kế kiến trúc](architecture.md).

## Bối cảnh và phạm vi report

Người dùng muốn phát triển hướng riêng để có thể thử nghiệm quy trình phù hợp phong cách làm việc của mình, song song với hướng controlled workflow của Thạch. Nhánh được chọn là `hieu/adaptive-agent-flow`, bắt đầu tại `0cc5f56`; đây là baseline tài liệu, không chứa implementation controlled workflow đã khảo sát ở nhánh của Thạch.

Trong trao đổi trước, controlled workflow được nhận xét là có nhiều vai, chế độ và bước quản lý. Mục tiêu của hướng mới là tìm mức quy trình vừa đủ để giảm bỏ sót và kiểm tra kết quả, đồng thời kiểm soát chi phí và độ phức tạp sử dụng. Đây là động lực thiết kế, chưa phải kết luận benchmark về hệ thống của Thạch.

Report này lưu nội dung thảo luận sản phẩm, gồm định hướng ban đầu và các quyết định tiếp theo về hai môi trường chạy độc lập, SDK/runtime adapters và delegation. Đây là bản tổng hợp, không phải transcript nguyên văn.

Nghiên cứu trước về workflow tùy biến, project memory và các repo tham khảo được lưu ở [report ngày 26/10/2026](../research/adaptive-project-workflows-2026.md), được sao chép từ commit `543ef16` để session local đọc được toàn bộ. Nội dung nghiên cứu được giữ, chỉ bổ sung chú thích lịch sử và đổi các links tới source không có trên nhánh này sang commit gốc. Report này và [thiết kế hiện tại](architecture.md) cập nhật các lựa chọn mới hơn. Các nguồn trong report cũ chưa được chạy thử hay kiểm tra lại trong lần tổng hợp này.

## 1. Nhu cầu và lý do

Người dùng hiện dùng Nimbalyst để quản lý session của nhiều provider độc lập, task, liên kết task–session và Kanban. Theo trải nghiệm người dùng, một session có thể yêu cầu tạo session trên công cụ/provider khác; Dev Extension cho phép xây giao diện bổ sung. Đây là nhu cầu tích hợp đã xác nhận, chưa phải kết quả kiểm chứng API Nimbalyst trong phase này.

NeoMind cần tận dụng các khả năng đó để cung cấp quy trình làm việc đủ rõ và có bước kiểm tra kết quả. Giả thuyết cần đo là workflow phù hợp sẽ giảm bỏ sót và nâng chất lượng; workflow quá lớn làm tăng chi phí token và có thể tăng thời gian điều phối. Workflow không mặc nhiên tốt hơn agent đơn lẻ.

Adaptive flow hướng đến lựa chọn mức quy trình vừa đủ cho task, dựa trên yêu cầu chất lượng, độ quan trọng, thời gian và chi phí. Phase đầu chỉ cần một flow mặc định để xác lập trải nghiệm và kiểm chứng giả thuyết.

## 2. Các lựa chọn đã được người dùng nêu

| Nội dung | Định hướng |
| --- | --- |
| Cách phát triển | Research và thiết kế trước, cùng thảo luận để làm rõ nhu cầu rồi mới triển khai |
| Công cụ làm việc | Tận dụng Nimbalyst; đồng thời hỗ trợ cách chạy standalone ngoài Nimbalyst |
| Hai môi trường | Nimbalyst và standalone có session, run history và vòng đời độc lập; dùng chung định nghĩa flow và logic NeoMind |
| Vai trò Nimbalyst | Host cho sessions bên trong Nimbalyst; extension visualize/điều khiển flow trong môi trường đó |
| Vai trò NeoMind | Định nghĩa flow, agents, skills, hooks; core điều phối, kiểm tra điều kiện chuyển bước và lưu trạng thái |
| Trải nghiệm chạy | Bấm Run/lệnh tương đương rồi theo dõi; chỉ can thiệp khi cần thông tin, quyết định hoặc xử lý blocker |
| Runner standalone | Ưu tiên integration với agent runtime có sẵn qua Codex SDK/App Server, Claude Agent SDK và OpenCode SDK/server; transport cuối cùng cần thử nghiệm |
| Chi phí/xác thực trước mắt | Ưu tiên đăng nhập tài khoản/subscription hiện có; không mặc định yêu cầu mua API key. Đường auth và quyền lợi subscription phải được kiểm chứng riêng cho mỗi runner |
| Antigravity | Tạm hoãn tích hợp theo quyết định người dùng ngày 28/10/2026; giữ report nghiên cứu để tham khảo, không tiếp tục cài/test adapter trong phase hiện tại |
| Delegation | Mặc định cấm session tự tạo subagent hoặc session con; flow core sở hữu quyết định chia việc |
| Phiên bản đầu | Một workflow mặc định, có visualization trên Nimbalyst ngay từ đầu |
| Nhóm công việc đầu tiên | Phát triển tính năng / sửa lỗi code, theo lựa chọn người dùng ngày 28/10/2026 |
| Memory ban đầu | Dùng Markdown, tổ chức để truy xuất theo nhu cầu |
| Memory về sau | Hướng đến SQLite làm trung tâm truy xuất nhanh hơn; cần thiết kế migration |
| Đánh giá workflow | Người dùng đánh giá; lưu ý kiến và feedback qua các lần chạy |

Các hướng đã trao đổi trước, tiếp tục nghiên cứu: agents/skills/workflows theo project; workflow thiết kế bằng file hoặc kéo thả; level 1–5; benchmark; chọn flow theo task/ngân sách và cải thiện dựa trên dữ liệu. Chưa đưa toàn bộ các khả năng này vào yêu cầu phiên bản đầu.

Level cao hơn dự kiến có nhiều bước kiểm soát hoặc ngân sách lớn hơn; không mặc nhiên có chất lượng cao hơn. Agents/skills dùng chung có thể được chuyên môn hóa theo project. Cơ chế cải thiện nên tạo phiên bản ứng viên, giữ lịch sử và đánh giá trước khi áp dụng; cách tự động hóa phần này còn mở.

## 3. Phân chia trách nhiệm đã thống nhất

| Lớp | Trách nhiệm | Điểm cần xác minh |
| --- | --- | --- |
| Nimbalyst host adapter | Gọi session API của host, ánh xạ run/node sang session/task, cung cấp events và kết quả | Đã đọc SDK/source, chưa chạy thử trên Nimbalyst thực tế; task API cần khảo sát riêng |
| Standalone host adapters | Điều khiển Codex, Claude Code, OpenCode bằng interface phù hợp | Auth, model discovery, output, cancel/resume và delegation cần conformance riêng |
| NeoMind core | Định nghĩa flow, chuyển bước, bàn giao context, lưu trạng thái, đánh giá đầu ra và feedback | Chi tiết flow mặc định và schema còn cần chốt |
| Monitor/controls | Hiển thị tiến độ và gửi yêu cầu điều khiển tới core | Panel không tự làm scheduler hoặc giữ trạng thái run duy nhất |

Core quyết định bước/session kế tiếp và kiểm tra điều kiện hoàn tất. Skills hướng dẫn công việc chuyên môn, không thay thế điều kiện được core kiểm tra. Host adapter thực hiện tạo session theo quyết định đó; worker mặc định không tự delegation.

Nimbalyst tiếp tục sở hữu lịch sử session gốc bên trong host; standalone dùng lịch sử của runtime tương ứng. NeoMind lưu liên kết run/node/task/session, artifacts, kết quả và feedback. Không mặc định đồng bộ/import session hoặc chuyển một run đang chạy giữa hai môi trường. Memory project có thể dùng chung các file Markdown với quy tắc ghi và freshness rõ ràng.

## 4. Phạm vi phiên bản đầu cần cùng chốt

Yêu cầu đã có: một flow mặc định phục vụ **phát triển tính năng / sửa lỗi code**, chạy được trong hai môi trường độc lập, visualization/điều khiển qua Nimbalyst cho run bên trong host và output trạng thái cho standalone. Người dùng đã chọn nhóm công việc; task cụ thể dùng làm pilot chưa được chọn.

Một ứng viên để thảo luận cho task lập trình:

```text
Làm rõ yêu cầu -> Lập kế hoạch -> Thực hiện -> Kiểm tra -> Người dùng đánh giá
```

Đây là ví dụ chưa chốt, không phải flow bắt buộc. Các bước logic được ánh xạ sang session độc lập khi cần; tái sử dụng session chỉ trong cùng môi trường và khi bindings phù hợp. Default flow cần chỉ rõ bước nào dùng session mới, bước nào có thể tiếp tục session hiện có. Không yêu cầu người dùng bấm chuyển từng bước bình thường.

Visualization đề xuất hiển thị flow đang chạy, bước hiện tại, task/session liên quan, kết quả và trạng thái chờ can thiệp. Giao diện chỉnh graph bằng kéo thả chưa được người dùng yêu cầu là điều kiện bắt buộc của phiên bản đầu.

Tiêu chí nghiệm thu đề xuất:

- Một yêu cầu thực tế đi qua flow mặc định và có đầu ra kiểm tra được.
- Cùng định nghĩa flow có thể chạy riêng trong Nimbalyst và standalone, không cần nhìn thấy session của nhau.
- Người dùng nhìn được bước đang chạy cùng task/session tương ứng trong Nimbalyst.
- Đóng panel không được tự hủy run; vòng đời backend host cần kiểm chứng riêng. Standalone không cần VS Code hay Nimbalyst mở.
- Delegation được chặn ở mức runtime/tool khi có khả năng; giới hạn chỉ bằng instructions phải được hiển thị rõ và chưa được coi là đạt yêu cầu cưỡng chế.
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

1. Trong nhóm phát triển tính năng / sửa lỗi code đã chọn, task thực tế nào dùng làm pilot? Đầu ra nào khiến người dùng coi là hoàn thành?
2. Bước nào bắt buộc session độc lập, công cụ kiểm chứng và output contract cụ thể là gì?
3. Người dùng muốn chọn provider/model ở đâu; flow có model mặc định hay dùng lựa chọn từ Nimbalyst?
4. Những điều kiện nào cần người dùng can thiệp, ngân sách/repair mặc định là bao nhiêu?
5. Nimbalyst session API đã có bằng chứng source; cần thử nghiệm host thực tế và khảo sát task integration.
6. Core sở hữu trạng thái chuyển bước; cần thiết kế đối chiếu session và xử lý trường hợp kết quả chưa rõ để tránh tạo trùng khi gián đoạn.

Chưa thực hiện triển khai, migration memory hay benchmark. Có [probe CLI](cli-invocation-probe.md) xác nhận khởi chạy/thu output nhưng chưa có inference thành công; đó không phải bằng chứng SDK hoặc workflow end-to-end đã hoạt động. Việc tiếp theo là chọn task đại diện, hoàn thiện contract flow và kiểm chứng adapters trong môi trường có auth/network phù hợp.
