# Tham khảo thiết kế Thạch và phân biệt các cơ chế agent

Tổng hợp ngày 28/10/2026 để session local không cần đọc lại hội thoại. Mục tiêu là hiểu lựa chọn kiến trúc; chưa có benchmark chứng minh một hướng tốt hơn hướng còn lại.

## 1. Baseline đã xem

Source nhánh `codex/controlled-workflows` của NeoMind được fetch/đọc tại commit `76344c6` trong đợt khảo sát này. Nhánh riêng `hieu/adaptive-agent-flow` không chứa code đó. Không dùng trạng thái checkout hiện tại làm bằng chứng source Thạch vẫn giữ nguyên; xem links đã pin khi đối chiếu.

## 2. Agent, model, session và runtime là các lớp khác nhau

- **Model** tạo suy luận/output; model ID không chứng minh một coding tool cụ thể đang chạy.
- **Agent profile** định nghĩa vai, instructions, skills và quyền mong muốn.
- **Session/thread/conversation** giữ context/lịch sử cho một cuộc làm việc.
- **Agent runtime/harness** thực hiện vòng model/tool, context management, permission và lifecycle.
- **Orchestrator** phân việc giữa các bước/session, quản lý điều kiện chuyển bước.

Codex, Claude Code và OpenCode có cơ chế subagents riêng. Điều đó không tự tạo ra điều phối xuyên công cụ như Claude Code -> Codex -> OpenCode. NeoMind mới dự kiến điều phối ở cấp session/runtime; không yêu cầu flow phụ thuộc native subagents.

## 3. Cơ chế Thạch đang dùng

Trong **controlled mode**, NeoMind tạo conversation riêng với role, model, messages và tools được phép, rồi gọi VS Code Language Model API `model.sendRequest(...)`. Code nhận model tool calls, thực thi scoped tools, đưa kết quả trở lại messages và quản lý vòng tiếp theo.

Đó là agent runtime do NeoMind quản lý qua Bridge, không phải một tiến trình Codex/Claude CLI cho mỗi worker và không đồng nhất với subagent native của Copilot. Một conversation có thể được tiếp tục khi prior invocation, role/workflow/task/model và host instance tương thích; không phải mọi lần gọi đều tạo một context hoàn toàn mới.

Source tham khảo:

- [Conversation và turn ownership](https://github.com/NeoTech-vietnam/NeoMind/blob/76344c6/src/vscode-host.ts#L236).
- [Model/tool loop](https://github.com/NeoTech-vietnam/NeoMind/blob/76344c6/src/vscode-host.ts#L100).
- [Controlled workflow owner](https://github.com/NeoTech-vietnam/NeoMind/blob/76344c6/src/controlled-workflow.ts).

Các đường native/lightweight còn dùng agent/subagent native của client; có đường [gọi `runSubagent`](https://github.com/NeoTech-vietnam/NeoMind/blob/76344c6/extensions/vscode-model-bridge/native-dispatch.cjs#L330). Không gom mọi execution mode thành cùng một cơ chế.

## 4. Vai và cấu hình model

[Role catalog](https://github.com/NeoTech-vietnam/NeoMind/blob/76344c6/docs/roles.md) mô tả 9 profiles cho Copilot: Coordinator, Explorer, Researcher, Planner, Architect, Implementer, Debugger, Verifier và Reviewer. Chúng ánh xạ vào 12 core role IDs để lưu quyền, routing và record ownership; không có nghĩa 21 agents cùng chạy. Implementer/Debugger dùng chung `developer`; Coordinator gộp manager/curator/release; Verifier gộp verifier/check-executor.

Chế độ controlled chọn model theo vendor/model ID trong catalog VS Code. Có thể dùng model khác cho từng role nếu Bridge/provider hỗ trợ. Chọn model Claude qua Bridge không tương đương chạy Claude Code. Model discovery và alias router không chứng minh inference thành công hay danh tính upstream thực tế.

Controlled executor hiện cần đúng project mở trong VS Code, Workspace Trust, Model Bridge enabled và model consent. Đóng chat/panel không tự dừng accepted work; đóng VS Code hoặc Bridge ngừng chạy sẽ ảnh hưởng worker và cần phục hồi checkpoint. Đây là giới hạn implementation được khảo sát, không phải giới hạn bắt buộc của workflow nói chung.

## 5. So sánh với hướng mới

| Tiêu chí | Controlled runtime của Thạch | Hướng Adaptive Agent Flow đã chọn |
| --- | --- | --- |
| Agent execution | Tự quản lý conversation và model/tool loop | Dùng coding runtime đã có qua host/session/SDK adapters |
| Tools và enforcement | Có thể chỉ cung cấp đúng scoped tools của NeoMind | Phụ thuộc capabilities của runner; phải công bố thiếu hụt |
| Observability | Chủ động ghi nhận tool/model boundaries | Chuẩn hóa output/events do host/runtime cung cấp |
| Bảo trì | Context, tool loop, model compatibility và recovery | SDK/CLI versions, adapter semantics và lifecycle |
| Môi trường | Controlled executor gắn VS Code Bridge | Nimbalyst và standalone độc lập, dùng chung core |
| Giá trị tận dụng | Hệ thống permission/evidence riêng | Khả năng coding/tools/context của Codex, Claude Code, OpenCode |

Không suy ra ít token hơn hoặc chất lượng tốt hơn từ kiến trúc. Handoff context giữa sessions và điều kiện nghiệm thu cần được kiểm chứng. Điểm nên học từ Thạch là kết quả/bằng chứng hiện tại và kiểm chứng độc lập; agent nói "xong" không đủ để core đánh dấu accepted.

## 6. Những release đã xem sau commit research

Mốc commit report của người dùng là `543ef16`, lúc 13:47 ngày 26/10/2026 tại Asia/Bangkok. Hai release dưới đây do `VuThach3001` phát hành, sau mốc đó, được đọc trong cuộc trao đổi:

| Release | Giờ phát hành Asia/Bangkok | Nội dung theo release notes |
| --- | --- | --- |
| [alpha.13 / extension 0.11.3](https://github.com/NeoTech-vietnam/NeoMind/releases/tag/v0.1.0-alpha.13) | 19:14 ngày 26/10/2026 | Củng cố backend-owned identities, prepared JSON, check freshness, report-only handoff và receipt recovery. Có thông báo lỗi Cornell Strategy/Flow sau release |
| [alpha.14 / extension 0.11.6](https://github.com/NeoTech-vietnam/NeoMind/releases/tag/v0.1.0-alpha.14) | 01:54 ngày 27/10/2026 | Sửa Cornell renderer/validator và recovery, giữ checkpoint qua pause/resume, panel control queue, chọn Local Coordinator và status response gọn hơn |

Release notes báo actual Local Copilot acceptance và CI Windows/Ubuntu. Alpha.14 ghi rõ các workflow acceptance có build identities riêng và không được chạy lại trên final management-response-only build; đường bị ảnh hưởng có validation riêng. Linux desktop/Codex Desktop acceptance không được claim. Đây là tóm tắt notes được công bố, không phải xác nhận độc lập của session này. Không coi bản release hay branch source là bằng chứng adaptive selector, project memory mới hoặc visual flow designer đã tồn tại.

## 7. Các điều chỉnh hiểu biết về Nimbalyst trong trao đổi

Mô tả ban đầu "Nimbalyst gọi CLI rồi hiện output" đã được làm rõ: source hiện tại dùng Codex App Server mặc định, Claude Agent SDK và OpenCode SDK/server. Có SDK không có nghĩa bỏ runtime process hoặc bắt buộc mua API key.

Các tài liệu provider architecture cũ được đánh dấu draft; dùng source hiện tại để xác minh transport. Codex SDK là wrapper của CLI/JSONL; App Server là giao thức khác. Nimbalyst session IDs khác runtime/provider IDs; không mặc định session hiện ở CLI sẽ hiện trong Nimbalyst hoặc ngược lại.

Hai môi trường độc lập là quyết định của người dùng để không phụ thuộc session interoperability. Nimbalyst vẫn là host thực thi khi chạy bên trong nó, đồng thời cung cấp monitor; standalone có process/lifecycle riêng. Chưa xây một monitor Nimbalyst cho mọi external run.

Antigravity đã tìm được SDK/CLI, nhưng provider Nimbalyst được xem dùng language-server/tool-loop riêng. Do ngân sách, tích hợp Antigravity hiện đã hoãn; xem [report có nguồn](antigravity-research.md).
