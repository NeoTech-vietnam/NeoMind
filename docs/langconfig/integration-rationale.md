# Vì sao thử LangConfig với OpenCode?

Ngày 15/11/2026 · **Đề xuất nghiên cứu, chưa quyết định migration hay triển khai production.** Tài liệu này không thay đổi policy, schema hoặc flow hiện hành.

## Bài toán và quyết định tạm thời

Người dùng cần tạo nhiều loại workflow agent dễ dàng, đáng tin cậy và nhanh tái sử dụng agent/skill nhất quán giữa các repo; workflow có thể xử lý tài liệu, nghiên cứu hoặc tác vụ khác, không chỉ sửa code trong Git. Cần biết một flow đã dùng những instructions nào, làm gì khi lỗi, và khi nào người dùng phải duyệt. UX và chi phí vận hành cũng quan trọng như số tính năng.

**Đề xuất:** thử LangConfig làm nơi thiết kế và điều phối graph, gọi OpenCode như một worker qua adapter task có ranh giới rõ. Bắt đầu bằng review chỉ đọc và fixture; giữ NeoMind hoạt động độc lập. Nếu thử nghiệm chứng minh giá trị và độ tin cậy, mới xét lớp tích hợp mỏng hoặc thay thế từng phần. Không giữ NeoMind chỉ vì đã đầu tư, cũng không thay runtime của nó bằng LangGraph chỉ vì có canvas.

LangConfig bản đánh giá giấy phép MIT, ghim commit `eb786cf8efe0b6cc9e45d07362e66da6ec465424`, xây trên LangGraph; source có canvas React Flow, templates, export/import và thư viện agent/skill. Đây là nền để **đánh giá** tạo flow nhanh, thay vì tự xây lại toàn bộ UI và cơ chế soạn graph. Canvas mới được đọc source và xem frontend kết nối, chưa đo trải nghiệm soạn flow. Bản ghim chưa có tích hợp OpenCode native.

### Các hướng thay thế

| Hướng | Đánh đổi và lựa chọn hiện tại |
| --- | --- |
| **LangConfig + native task tool gọi OpenCode** | Ưu tiên prototype: tái sử dụng authoring/orchestration, nhưng worker là OpenCode session riêng; cần kiểm chứng ranh giới, recovery và vận hành. |
| LangGraph thuần + OpenCode | Linh hoạt và ít phụ thuộc LangConfig hơn, nhưng phải tự làm hoặc tích hợp phần canvas, template, thư viện và UX quản lý; vẫn là phương án đối chứng nếu lớp LangConfig quá nặng. |
| OpenCode độc lập | Hữu ích cho task đơn giản và làm mốc so sánh agent đơn; không tự chứng minh một engine workflow nhiều bước có approval, khôi phục và tái sử dụng giữa repo. |
| Proxy giả OpenAI/model API để LangConfig coi OpenCode là LLM native | Không chọn: che mất ngữ nghĩa session, tool loop và quyền của worker; không giải quyết các giới hạn truy cập model free. Không giả header/client hay gọi thẳng endpoint free từ LangConfig. |
| Viết lại NeoMind core hoặc thay ngay bằng LangGraph | Quá sớm khi chưa đo UX, chất lượng, phục hồi và tổng chi phí; tiếp tục NeoMind hoặc thay thế đều có thể đúng sau khi có bằng chứng. |

## Ranh giới kiến trúc

Đường **đã thử**, không phải sơ đồ một sản phẩm hoàn chỉnh:

```text
Fixture source
    │
    ▼
LangConfig StateGraph: START → TOOL_NODE native read_file
    │                          (đọc nội dung fixture)
    ▼
TOOL_NODE native opencode_review (nhận instruction + nội dung đã đọc)
    │
    ▼
Adapter Python → HTTP 127.0.0.1 → OpenCode 2.2.7 session
                                      │ mọi tool bị deny
                                      ▼
                               fake provider/upstream
                                      │ verdict giả có schema
                                      ▼
Adapter kiểm kết quả → graph → END
```

Nội dung đi từ `read_file` của LangConfig vào instruction gửi OpenCode; **OpenCode không tự đọc fixture trong wire hiện tại**. Graph thử gọi `execute_tool_node` thật, nhưng không chạy toàn bộ HTTP backend, `WorkflowExecutor` hay UI graph. LangConfig điều khiển thứ tự graph; OpenCode sở hữu session và, nếu được cấp quyền ở thử nghiệm tương lai, vòng agent/tool bên trong session. Nested session không tương đương việc LangConfig tự thực thi native LLM/tool loop.

| Trách nhiệm | Chủ thể / trạng thái |
| --- | --- |
| Định nghĩa, hiển thị và điều phối workflow | LangConfig/LangGraph theo đề xuất; xử lý lỗi, pause và recovery còn phải kiểm chứng end-to-end. |
| Task, session và hợp đồng kết quả | Native `opencode_review` và adapter: kiểm danh tính session, model, workspace và schema verdict; ghi intent/prompt ID, reconcile thay vì tự gửi lại khi kết quả chưa rõ. Chỉ là prototype fixture. |
| Model/provider, phiên agent, tools/skills và xác thực | OpenCode quản lý trong context của chính nó; adapter không giả làm provider, không sao chép credential. Session wire hiện tại deny mọi tool; việc nạp/tái sử dụng skill chưa được chứng minh. |
| Authority với dữ liệu và side effect | LangConfig native file tool dùng quyền process của LangConfig; quyền OpenCode không giới hạn được chính tool đó. Owner tin cậy phải xác thực nguồn, scope, instruction, context và các hành động trước dispatch; chưa có cơ chế production được xác minh. |
| Duyệt và isolation | Cần cổng duyệt tin cậy trước tác động bên ngoài và isolation theo use case. Không dựa vào LangConfig `APPROVAL` hiện tại cho production khi chưa kiểm chứng pause/reject/resume. Quyền OpenCode **không phải OS sandbox**. |

[API OpenCode V2](https://opencode.ai/docs/api) công bố các route session; nhiều phần, bao gồm session, được đánh dấu experimental. [Client chính thức](https://opencode.ai/docs/build/client) dùng cùng hợp đồng HTTP. Adapter phải pin/kiểm tra version, auth, location và contract thực tế, không giả định API bất biến. [Console](https://opencode.ai/docs/zen/) quy định free-tier chat model cần OpenCode: dùng context OpenCode thực, không spoof endpoint/header hoặc chuyển credential sang LangConfig. Metadata giá 0 không chứng minh tài khoản hoặc model free khả dụng trong context thử nghiệm.

Không đánh đồng adapter native này với custom HTTP tool của LangConfig: cơ chế HTTP chung chặn loopback để giảm SSRF; native `opencode_review` là capability tối thiểu được thêm có chủ đích, không nên mở generic localhost. Trong source bản ghim, `MCP TOOL_NODE` nạp native tool registry, không có nghĩa tự gọi MCP server tùy ý; CLI registry được khảo sát chỉ có Jira. Cần thiết kế và kiểm chứng tích hợp MCP riêng nếu thật sự cần.

## Tái sử dụng giữa các repo: hợp đồng đề xuất

Chưa có bằng chứng một shared library live hoặc cập nhật skill tự lan đúng sang nhiều repo. Đề xuất kiểm chứng một hợp đồng độc lập với cách lưu cụ thể:

- Định danh và version bất biến cho flow, agent, skill và adapter; khai báo dependencies, version tương thích, input/output và capability cần có. Import thiếu dependency hoặc sai version phải báo lỗi rõ, không âm thầm dùng bản khác.
- Mỗi run chốt snapshot/hash nội dung và cấu hình có hiệu lực, bao gồm skill, instructions và model/variant; thay đổi thư viện chỉ ảnh hưởng run mới sau khi được chọn/duyệt. Ghi nguồn và provenance để tái lập; không nhúng hay xuất secret.
- Repo/project binding cung cấp đường dẫn, nguồn dữ liệu, quyền và secret references riêng; không trộn metadata LangConfig project với danh tính Git repo. Xác nhận lại quyền và scope ở repo đích, không tin tuyệt đối flow import.
- Thử cùng agent/skill ở ít nhất hai repo, sửa skill, kiểm run cũ giữ snapshot và run mới dùng đúng phiên bản được chọn; thử restart, dependency thiếu, xung đột version và export/import không lộ secret. Đây là tiêu chí, **không phải tính năng đã có**.

## Bằng chứng và giới hạn

| Đã quan sát | Không được suy ra |
| --- | --- |
| LangConfig mock A/B đọc nguồn và sửa draft thật bằng native tools; export/import graph sang project B sau khi sửa marker. Verdict được lập trình sẵn, graph tuyến tính luôn chạy repair. | Không chứng minh reviewer AI tìm lỗi, conditional repair, portable skill/dependency hay reuse UI. |
| NeoMind fake A/B dùng runtime Dev biến đổi, không commit kết quả: duyệt plan, review hai findings, repair, review pass trong worktree riêng. | Không chứng minh AI thật, sandbox thật, UX tốt hơn hay tốc độ tổng thể tốt hơn; hai bài A/B không đối xứng. |
| Prototype unit/fake: 17 pytest đạt, 1 warning. Wire riêng dùng TOOL_NODE thật → OpenCode 2.2.7 thật → `fixture/fake-review#high` upstream giả; `e2e5.log` trả `needs_changes` và finding giả. | Unit fake và wire server thật là hai loại bằng chứng riêng; không phải full backend/UI, model thật hay chất lượng review. **0 workflow model thật, 0 inference request thật.** Transport HTTP cố ý từ chối model thật; core NeoMind không đổi. |
| Tiếp tục 15/11: guard SQLite nhiều process và retry thực đã thử với upstream giả; factory qua NeoMind RunnerRegistry và LocalRun chỉ đọc hoàn chỉnh đều đạt, journal/stop được kiểm. Một workflow DeepSeek Free thực trả `Free usage limit reached`, có 1 reservation và 0 lượt live hoàn thành. Cold install Python chọn lọc cũng chạy đạt. | Dòng prototype phía trên là lịch sử trước lượt live. LocalRun mới dùng upstream giả, chưa có verdict/findings từ AI thật hay LocalRun live; reservation là cận trên 1 request, không phải đối chứng POST của dịch vụ. Giữ pause và budget gốc, không fallback hoặc reset quota. |
| Trong môi trường Linux cài dependency chọn lọc, các graph dựng qua API từng báo `completed` dù node lỗi; skill cá nhân GET 404 sau restart dù còn row DB; graph approval thử nghiệm nuốt interrupt, không pause; hai crash khi dùng event loop mặc định, `--loop asyncio` là workaround thử nghiệm. | Không kết luận mọi cấu hình, UI hay upstream đều lỗi; nguyên nhân crash chưa rõ. Cần đối chứng với dependency đầy đủ và test pause/resume, lỗi và recovery trước production. |

Chưa có benchmark chất lượng AI hay tốc độ tổng thể, đo usability UI, hoặc xác minh cập nhật skill xuyên repo. Báo cáo đầy đủ và giới hạn môi trường: [đánh giá LangConfig so với NeoMind](../adaptive-agent-flow/research-langconfig-vs-neomind-2026-11-14.md). Evidence cục bộ của lượt thử ở `/home/hieu-tran/.local/share/langconfig-eval-20261114`, có thể không tồn tại trên máy khác.

## Các cổng thử nghiệm tiếp theo

1. **Chỉ đọc, fake trước:** chạy toàn bộ backend/`WorkflowExecutor` và graph UI với adapter fixture; xác nhận lỗi node làm task thất bại, kết quả không hợp lệ bị từ chối, intent/reconcile không gửi lại khi receipt mất, và cancel chỉ báo đã dừng khi có bằng chứng. Đối chứng approval qua UI và test restart/crash; chưa cho phép tool ghi hay dữ liệu nhạy cảm.
2. **Authority và guard trước model thật:** owner tin cậy phải xác minh effective location, instructions, plugin, MCP, auth, workspace và dữ liệu được phép gửi. Kiểm guard fail-closed, atomic/durable xuyên process trước từng physical dispatch; ghim đúng provider/model **và variant**, không fallback trả phí; test concurrent, retry, timeout, cancel, mất plugin/config, title, compaction, WebSocket và các luồng phụ. Test no-resubmit và stopped proof với server thật. Title cố định, cấu hình compaction, retry hay giới hạn model steps riêng lẻ **không chứng minh hard cap physical requests**. Guard bridge hiện chỉ thử fake, chưa được xác minh live.
3. **Model free thực chỉ sau các cổng trên và đúng phạm vi được người dùng duyệt:** kiểm lại khả dụng, tài khoản, privacy và chi phí trong context OpenCode; nếu không chứng minh được giới hạn hoặc không được phép thì dừng, không fallback. So sánh chất lượng, thời gian, chi phí và feedback với cùng task, input và tiêu chí, bao gồm OpenCode đơn lẻ làm đối chứng.
4. **Writer về sau, cần duyệt rõ ràng:** chỉ sau khi có thiết kế được người dùng duyệt cho quyền ghi, phạm vi và nơi áp dụng; thử trên fixture cách ly trước. Kiểm approve/reject/resume, hành vi khi crash trước/sau side effect, duplicate effects, provenance, review độc lập khi phù hợp và khả năng rollback. Git worktree hữu ích cho repo, nhưng workflow ngoài Git cần cơ chế staging/compensation phù hợp riêng.

Điều kiện thành công không chỉ là graph chạy: người dùng tạo và sửa được nhiều flow có ích, reuse phiên bản nhất quán ở hai repo, hiểu và duyệt đúng hành động, lỗi/restart không báo thành công giả hay lặp side effect, và có số liệu so sánh thực về UX, chất lượng, vận hành và chi phí. Nếu không đạt, không chuyển production.

## Chi phí, khả năng quay lui và điểm quyết định

LangConfig bổ sung vận hành Python, Postgres/pgvector, dependency, backup và nâng cấp; OpenCode/Node và adapter thêm version, auth, logging và bề mặt lỗi. NeoMind cũng có chi phí duy trì scheduler, runners, policy và UI. Nếu phải tự xây approval, versioned library, recovery và side-effect fencing quanh LangConfig, lớp tích hợp có thể không còn mỏng. Chưa đủ dữ liệu để ước lượng ngày công hoặc chọn phương án rẻ nhất.

Giữ hai hệ thống cùng tồn tại và NeoMind runtime không đổi trong thử nghiệm; tắt adapter và tiếp tục flow NeoMind nếu prototype không đạt. Sau pilot đo được, **thay thế** chỉ khi LangConfig đáp ứng các cổng tin cậy và tổng lợi ích tốt hơn; chọn **lớp mỏng** nếu canvas/orchestration mang lại lợi ích mà phần bổ sung còn thực sự nhỏ; **tiếp tục NeoMind hoặc thử LangGraph thuần** nếu tích hợp quá phức tạp, không an toàn hoặc UX không cải thiện. Quyết định dựa trên bằng chứng và nhu cầu thực, không dựa trên sunk cost.

Tham khảo thêm: [cài đặt và kiểm thử](setup-and-tests.md) · [thử nghiệm đóng gói](../../experiments/langconfig-opencode/README.md) · [định hướng NeoMind đang đề xuất](../adaptive-agent-flow/direction-2026-11.md).
