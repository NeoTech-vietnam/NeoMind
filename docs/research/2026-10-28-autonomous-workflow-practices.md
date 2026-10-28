# WorkForce và các thực hành xây workflow agents tự động

Ngày đối chiếu: **28/10/2026**. Chỉ dùng nguồn chính thức/first-party. Đây là nghiên cứu kiến trúc, **không phải bằng chứng WorkForce đã được triển khai hoặc nghiệm thu**.

Quyết định áp dụng nằm trong [kế hoạch tổng hợp WorkForce](../plans/2026-10-28-workforce-final-plan.md); tài liệu này là nguồn tham khảo, không phải kế hoạch triển khai riêng.

## Kết luận trực tiếp

Có những nhóm kỹ sư đang xây hệ thống có cùng hướng với WorkForce: phân rã công việc, workers chuyên trách, kiểm chứng độc lập, thực thi qua nhiều phiên và tự tiếp tục. Những ví dụ dưới đây là hệ thống/thử nghiệm thực được chính nhóm xây dựng mô tả. Chúng không chứng minh một tổ chức PM + năm agents cố định là tối ưu, hoặc một SDK bảo đảm mọi request thành công.

Các nguồn đã đọc không xác nhận việc dùng V-model/ASPICE giống WorkForce. Đó là lựa chọn quản trị kỹ thuật riêng của sản phẩm, cần được triển khai thành coverage/evidence thực thay vì suy ra từ số vai trò.

## 1. Anthropic: chọn workflow hoặc agent theo công việc

**Nguồn, 19/12/2024:** [Building effective agents](https://www.anthropic.com/research/building-effective-agents).

- Phân biệt workflow có đường đi được code định trước với agent tự quyết định cách dùng tools.
- Khuyến nghị bắt đầu đơn giản, tăng độ phức tạp khi cần; mô tả routing, orchestrator–workers và evaluator–optimizer.
- Routing có thể đưa việc quen thuộc sang model tiết kiệm, việc khó sang model mạnh. Đây là pattern thiết kế, không phải chứng minh small-first luôn rẻ nhất.

**Giới hạn thời điểm:** trang tự ghi landscape đã đổi từ 2024 và trỏ sang Managed Agents. Dùng bài này cho khái niệm; không coi danh sách framework/model trong bài là khuyến nghị hiện tại.

## 2. Anthropic: làm tiến triển nhỏ, bàn giao bằng artifacts

**Nguồn, 26/11/2025:** [Effective harnesses for long-running agents](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents).

Thử nghiệm dùng initializer chuẩn bị môi trường/danh sách tính năng và coding agent hoàn thiện từng phần, để lại progress cùng Git history. Tác giả ghi nhận agent tự nhận xong quá sớm; browser testing theo cách người dùng sử dụng giúp bắt lỗi mà unit tests hoặc curl chưa bộc lộ. Bài viết vẫn nêu giới hạn và câu hỏi nghiên cứu mở về single-agent so với multi-agent.

**Liên hệ WorkForce:** source code, test result và checkpoint phải giúp phiên kế tiếp làm tiếp; một bản tóm tắt “đã hoàn thành” không thay thế sản phẩm.

## 3. Anthropic: generator/evaluator và bỏ scaffolding không còn cần

**Nguồn, 24/03/2026:** [Harness design for long-running application development](https://www.anthropic.com/research/harness-design-long-running-apps).

Thử nghiệm có planner, generator và evaluator; evaluator thao tác app thật bằng Playwright. Khi model mạnh hơn, tác giả bỏ sprint machinery và đánh giá lại phần harness còn đem lại giá trị. Một so sánh công bố solo $9/20 phút với harness $200/6 giờ, nhưng planner đã mở rộng scope: không phải benchmark cùng scope chứng minh harness luôn hiệu quả. Tác giả cũng mô tả lỗi QA và bug còn sót.

**Suy luận cho WorkForce:** role và gate phải có lợi ích đo được. Thêm nhiều vòng review có thể tăng chất lượng nhưng không tự bảo đảm nhanh/rẻ; không cho PM tự mở rộng scope rồi so chất lượng với task nhỏ hơn.

## 4. Anthropic: tách session, harness và môi trường thực thi

**Nguồn, 08/04/2026:** [Scaling Managed Agents: Decoupling the brain from the hands](https://www.anthropic.com/research/managed-agents).

Thiết kế tách durable session log, agent harness và execution environment. Tác giả mô tả phục hồi harness từ log khi instance chết và tách credentials khỏi môi trường chạy code. Đây là mô tả kiến trúc hosted service, không phải bằng chứng local OpenCode/9router có sẵn cùng khả năng.

**Suy luận cho WorkForce:** session bị thay không nên làm mất artifacts hoặc engineering state; phân quyền giữa engine và gateway phải rõ. Không trộn tất cả trạng thái vào một conversation mong manh.

## 5. Cursor: planner/workers giống WorkForce, coordination cũng từng thất bại

**Nguồn, 14/01/2026:** [Scaling long-running autonomous coding](https://cursor.com/blog/scaling-agents).

Cursor mô tả thử nghiệm agents ngang quyền tự claim/lock công việc, gặp contention và lỗi coordination. Họ chuyển sang planner và workers tập trung nhiệm vụ, có đánh giá theo chu kỳ. Nhóm nhấn mạnh chọn model theo vai trò và bỏ độ phức tạp không cần thiết. Các kết quả là nghiên cứu quy mô lớn do Cursor tự công bố, không phải bảo đảm cho project của người dùng.

## 6. Cursor: bớt bàn giao và bỏ “integrator” thành nút thắt

**Nguồn, 05/02/2026:** [Towards self-driving codebases](https://cursor.com/blog/self-driving-codebases).

Thiết kế sau gồm root planner/subplanners và workers có repo copy riêng, trả một handoff cho người giao việc; workers không phải cross-talk toàn hệ thống. Cursor bỏ integrator trung tâm vì tạo bottleneck. Họ chấp nhận lỗi tạm thời trong research branch để tăng throughput nhưng vẫn đề cập final green branch trước release. Browser thử nghiệm không được mô tả là sản phẩm production-ready cho bên ngoài.

**Suy luận cho WorkForce:** có thể lưu checkpoint chưa hoàn hảo để tiếp tục, nhưng chỉ nhận accepted cho sản phẩm qua verification. Không sao chép việc nới intermediate correctness của một thử nghiệm lớn thành bỏ kiểm chứng cuối cho user.

## 7. Nguồn bổ sung đã được agent chính đối chiếu

Các tóm tắt dưới đây được tổng hợp từ nguồn chính thức đã được agent chính đọc trong cùng lượt nghiên cứu; ngày truy cập 28/10/2026.

Ví dụ gần nhất về cách tổ chức là [MetaGPT — Software Company as Multi-Agent System](https://github.com/FoundationAgents/MetaGPT): README mô tả nhận yêu cầu một dòng và tạo user stories/requirements/data structures/APIs/docs bằng các vai trò như product manager, architect, project manager và engineer cùng SOPs. Đây là tuyên bố năng lực của chính repository; không chứng minh production reliability và không phải khuyến nghị cài thêm framework vào WorkForce.

- [OpenAI — Codex as a platform](https://developers.openai.com/blog/codex-as-a-platform): có thể tái sử dụng agent loop/harness; ứng dụng sở hữu product context, rules và tools. Pattern này không tự chứng minh khả năng dùng Codex App Server với 9router.
- [OpenAI — Model selection](https://developers.openai.com/api/docs/guides/model-selection): đánh giá model trên cùng đầu vào; chọn model nhẹ đáp ứng chất lượng, tính cả thời gian sửa và review.
- [OpenAI — Optimizing agents for cost and quality](https://developers.openai.com/cookbook/examples/agent_optimization/optimizing_agents_for_cost_and_quality#measure-task-efficiency-not-just-token-efficiency): tối ưu chi phí của task hoàn thành, không chỉ giá token; repeated attempts của model rẻ có thể làm tổng chi phí cao hơn. Các số minh họa trong notebook là **mock**, không dùng làm số đo thực nghiệm.
- [LangGraph — Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence), [Fault tolerance](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance): có checkpoint/store và các cơ chế retry/backoff/timeout/error handling. Có framework không đồng nghĩa mọi lỗi/quota đều tự retry được.

## 8. Điều nên giữ và điều cần thay trong WorkForce

Phần này là **đề xuất suy luận cho WorkForce**, không phải kết luận đo được trên implementation hiện tại.

| Ý định WorkForce | Cách tổ chức thực dụng |
| --- | --- |
| PM + năm vai trò | Giữ trách nhiệm/ownership rõ; không bắt mọi request chạy đủ mọi phiên hoặc viết lại cùng thông tin. |
| Tuân thủ V-model/ASPICE | Map criterion với thiết kế, output, phép kiểm và evidence; không dùng form/record count làm proxy chất lượng. |
| Model nhỏ rồi model mạnh | Chọn tier theo task; việc khó có thể strong ngay. Nâng tier khi có failure/capability evidence; không gọi model mạnh để chữa lỗi backend. |
| Tự động hóa request lặp | Công việc rõ và tool đủ qualification chạy bằng code/procedure có tham số; dùng model cho phần cần suy luận. |
| Giao việc mới/chưa biết | Plan ngắn theo deliverables, thực hiện từng increment, nhận feedback thực và điều chỉnh. Tránh đóng cứng chi tiết sai quá sớm. |
| Mỗi request có output | Lưu useful artifacts liên tục, phân biệt draft/verified/accepted; không chỉ lưu receipts hoặc hội thoại. |
| Không tốn quota vì coordination | Workers nhận bounded context/tools, một result có nội dung; backend quản lý IDs/ownership và events. |
| Tái sử dụng backend ngoài | Engine chịu session/tool loop; WorkForce giữ engineering contract. Loại phần trùng, không xếp hai harness cùng điều khiển. |
| Hoàn thành từ phía user | Kiểm tra trên installed build và thao tác người dùng thật; LLM reviewer và unit tests không đủ cho mọi tương tác. |

## 9. Kết luận để quyết định

1. Hướng của người dùng có tiền lệ thực tế. Phần cần tránh là mô phỏng nguyên một phòng ban cho mọi task mà không đo hiệu quả.
2. Ý tưởng đáng ưu tiên là **workflow xác định cho việc đã biết + agent có quyền tự tìm cách trong phạm vi cho việc mới**, có output/evidence bền vững.
3. Năng lực model, harness, tools và evaluation phải được đo cùng nhau. Không có nguồn nào ở đây chứng minh một sơ đồ tổ chức hay SDK loại bỏ được mọi thất bại.
4. Bước tiếp theo là benchmark vài request thật của NeoLearning với cùng input/criteria: baseline đơn giản, WorkForce orchestration và routing tiers. Báo accepted products/time/calls/corrections; không dùng LoC hoặc số agents làm kết quả chính.
5. Tài liệu này không tự thay đổi kế hoạch WorkForce, không cài framework, không sửa runtime và không chứng minh client acceptance.
