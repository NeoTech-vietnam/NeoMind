# VS Code 1.146: điều chỉnh WorkForce theo native Agent Host

Đối chiếu ngày **11/11/2026**. Source WorkForce: nhánh `codex/workforce-vscode-native`, HEAD `70f2c4c`; working tree sạch lúc bắt đầu khảo sát.

Đây là nghiên cứu tài liệu và source, **chưa nghiệm thu WorkForce thực chạy trên VS Code 1.146**. Lượt này chỉ thêm tài liệu; không sửa executable, cấu hình, UI hoặc gọi model.

## Kết luận

Ngày 12/11/2026, H0 đã được đưa vào [kế hoạch triển khai hiện hành](../plans/2026-11-10-plugin-agent-helpers-plan.md): **H0 → H1 → H2 → H3**. Tài liệu nghiên cứu này giữ snapshot khảo sát 11/11; kế hoạch là nguồn thứ tự và acceptance hiện hành. H0 vẫn chưa triển khai/nghiệm thu. Giữ runtime Local đang hoạt động đến khi đường mới được nghiệm thu. Không xây lại orchestrator hoặc khôi phục OpenCode.

## Những điều đã xác minh

| Thay đổi của VS Code | Hệ quả với WorkForce |
| --- | --- |
| Bản stable 1.146 phát hành 11/11/2026; Local harness đã deprecated, đóng băng tính năng và dự kiến bị bỏ tháng 2/2027. | Không tiếp tục coi Local harness là nền tảng dài hạn. [Release notes](https://code.visualstudio.com/updates/v1_146#copilot-harness-and-deprecation-of-the-local-harness). |
| Copilot harness có thể chạy trên máy người dùng; harness, nơi chạy code và provider model là ba lựa chọn khác nhau. | Chuyển harness không đồng nghĩa chuyển project lên cloud hoặc bắt buộc bỏ custom endpoint. [Hướng dẫn chuyển đổi](https://code.visualstudio.com/docs/agents/run/move-to-copilot#understand-what-changes). |
| BYOK trong Copilot editor/Agents window cần `chat.agentHost.byokModels.enabled`, hiện Experimental. Desktop có thể dùng BYOK được hỗ trợ mà không đăng nhập GitHub; browser Agents cần GitHub sign-in. | Thử giữ 9router như model provider; chưa được tuyên bố mọi cấu hình 9router hoặc tool-call đều tương thích. [Models](https://code.visualstudio.com/docs/agent-customization/language-models#bring-your-own-language-model-key), [accounts](https://code.visualstudio.com/docs/agents/run/agents-window-configuration#manage-ai-providers-and-accounts). |
| Custom Endpoint hỗ trợ Chat Completions, Responses và Messages. | Giữ provider do người dùng cấu hình; không tạo yêu cầu bắt buộc alias `top-models`/`worker-models`. [Custom Endpoint](https://code.visualstudio.com/docs/agent-customization/language-models#add-a-custom-endpoint-model). |
| Copilot dùng runtime/provider-qualified model IDs, khác qualified display names của Local. Một số fields hiển thị trong agent-file schema không được chuyển sang SDK custom-agent configuration. | Cần adapter model/config theo harness; editor validation không đủ chứng minh runtime thực thi permissions. [Custom-agent reference](https://code.visualstudio.com/docs/agents/reference/custom-agent-file-reference). |
| Local và Copilot dùng cơ chế subagent khác nhau; public LM API chỉ bảo đảm gọi tools có trong `lm.tools`. | Không đổi chuỗi `runSubagent` thành `task` rồi coi đã tích hợp. Phải chứng minh đường gọi backend qua public API được hỗ trợ, đúng schema/context/result/cancellation. [Subagents](https://code.visualstudio.com/docs/agents/run/subagents), [LM API](https://code.visualstudio.com/api/references/vscode-api#lm). |
| Extension tools phụ thuộc editor client đang kết nối, kể cả khi Agent Host tiếp tục chạy. | Không hứa WorkForce tiếp tục đầy đủ sau khi đóng editor nếu công việc còn cần extension tools. [Agent Host](https://code.visualstudio.com/docs/agents/concepts/agent-host#session-lifetime-and-client-dependencies). |

Source hiện tại xác nhận `src/native-mcp.ts` chỉ đăng ký `request_status` và `work_prepare`; MCP này không có dispatch. Cài Agent Plugin hiện tại không tự tạo đường thay thế điều phối. `src/native-local-contract.ts` sinh worker với `agents: []`; không được giả định ràng buộc Local này giữ nguyên hiệu lực trên Copilot. Các kết luận source này cần được kiểm tra lại nếu HEAD thay đổi.

## H0 — việc cần làm trước khi mở rộng helpers

1. **Feasibility trước refactor:** trong workspace riêng, dùng VS Code 1.146, Copilot harness chạy trên máy và Custom Endpoint đang hoạt động. Chứng minh backend gọi một specialist đúng danh tính/context, nhận kết quả, override model và hủy được. Nếu SDK-native `task` không có public extension invocation seam, ghi rõ giới hạn và chọn public integration đã chứng minh; không dùng private API hoặc chuyển ownership sang model âm thầm.
2. **Model adapter:** lấy inventory/capabilities thật theo harness, resolve role preferences sang ID phù hợp; giữ default/inherit khi người dùng không chọn. Freeze model mỗi invocation; ghi requested và observed riêng. Không tự đồng bộ model của mọi chat hoặc tự sửa provider của người dùng.
3. **Agents, tools, hooks:** sinh config đúng harness từ một contract, kiểm tra fields thực sự được SDK chuyển tiếp. `agents`, handoffs và Local tool IDs không được coi là portable. Các fields `model-policy`, `mcp-servers`, `github`, `deferred-tool-loading`, `strict-tools-list`, `include-custom-instructions` có giới hạn conversion được tài liệu nêu; không dùng chúng như runtime-wide security proof. Hooks cần đối chiếu event/payload/failure behavior riêng, không có automatic conversion. [Migration guide](https://code.visualstudio.com/docs/agent-customization/migrate-customizations), [agent-file limitations](https://code.visualstudio.com/docs/agents/reference/custom-agent-file-reference#copilot-specific-configuration).
4. **MCP và lifecycle:** chọn forwarding hoặc cấu hình native Copilot theo scope thực tế; `.vscode/mcp.json` không đồng nghĩa `.mcp.json`. `${input:...}`/`${command:...}` và editor secrets không tự chuyển; disabled state cũng không portable. Giữ owned registration, pin và active leases, không bật lại integration đã tắt hoặc chép credential vào file. [MCP migration](https://code.visualstudio.com/docs/agent-customization/migrate-customizations#migrate-mcp-servers).
5. **Tương thích:** giữ `.workforce`, request IDs/history, reusable qualified tools, năm roles và evidence V-model/ASPICE. H0 phải thay transport/config đúng chỗ, không làm lại storage hoặc thêm tầng gate cho model.

## Tận dụng native UI, giữ phần đặc thù

- Chat/Agents window quản lý conversation, tools, changes, session status và quyền. WorkForce giữ panel V-model gọn để hiển thị stage/request/evidence theo backend thực tế.
- Agents window extension support, chat windows, Inbox và Canvases có Preview/Experimental; đánh giá sau khi dispatch cốt lõi đạt. Chưa thay panel bằng Canvas vì tên tính năng giống nhau không bảo đảm API/lifecycle tương đương. [1.146 notes](https://code.visualstudio.com/updates/v1_146).
- Skills over MCP có thể giảm phần phân phối skill trùng về sau; hiện Preview, cần consent và kiểm thử riêng. Chưa thay skills/package lifecycle đang dùng. [Skills over MCP](https://code.visualstudio.com/updates/v1_146#skills-over-mcp-preview).
- Fusion/model comparison có thể phục vụ đánh giá model do người dùng chọn; không bật tự động hoặc thêm lượt judge/synthesizer vào mọi request. Không là gate của H0/H1. [Model selection](https://code.visualstudio.com/docs/agent-customization/language-models#use-copilot-fusion).

## Nghiệm thu cần bổ sung

- [ ] Request mới từ prompt người dùng: Cornell note + C/C++, actual native specialists, kiểm chứng độc lập và đóng thật.
- [ ] Request tương tự: Manager tìm đúng qualified procedure, chạy script cần thiết một lần, tránh helper/model calls thừa.
- [ ] Original plug-in ABC: gọi native thật, role dùng kết quả; giữ nguyên các lựa chọn H1–H3 đã chốt về tên/model/quyền; config không hỗ trợ phải hiện lý do trước paid call.
- [ ] Explicit role model, default/inherit và inventory refresh dùng đúng ID của harness; provider unavailable/quota được phân biệt với lỗi adapter.
- [ ] MCP thật và Disable/Enable/Unregister khi đang chạy giữ lease đến khi effects được đối soát, sau đó drain; không đổi integration ngoài sở hữu WorkForce.
- [ ] Cancel, lost response, editor reload/đổi cửa sổ và resume không tạo request/effects trùng hoặc nhận acceptance trên revision cũ.
- [ ] Windows/Ubuntu regression; desktop acceptance ghi đúng OS/harness/provider/build thực chạy, không dùng core CI thay desktop proof.

**Thứ tự đã cập nhật vào kế hoạch ngày 12/11:** H0 → H1 helper tối thiểu → H2 tích hợp → H3 nghiệm thu và phát hành. M7/REA và managed routing vẫn deferred. Chưa đổi release hoặc triển khai transport nào trong lượt cập nhật tài liệu này.
