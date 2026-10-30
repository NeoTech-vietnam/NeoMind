# Đọc nội dung session agent (Codex, Claude Code) trong NeoMind · research

Ngày 30/10/2026. Câu hỏi: NeoMind có thể cho xem agent đã làm gì trong từng bước (tin nhắn, file đã đọc, lệnh đã chạy, file đã sửa) không, cho cả Codex và Claude Code?

> [!NOTE]
> **Đã triển khai (30/10/2026)** theo đề xuất bên dưới: B làm nguồn chính, A làm dự phòng. Các quyết định đã chốt: luồng trực tiếp 2 cột, agent thứ 3+ thu thành một dòng; giới hạn 200 dòng output, 60 dòng mỗi lần đọc file, chỉ giữ tóm tắt suy luận; hiện rõ khoảng trống và cho chuyển nguồn bằng tay; bước xong thì luồng thu thành dòng tóm tắt kèm "Xem session". Chi tiết ở [implementation-status.md](implementation-status.md) và README (mục "Xem agent đang làm gì"). Phát hiện phụ 2 (lượt bị dừng) hiện là sự kiện `end` có trạng thái `interrupted`; phát hiện phụ 1 (tách cấu hình Codex) chưa làm.

**Trả lời ngắn: được.** Mỗi lần NeoMind giao việc cho agent đều ghi lại `sessionId` (thread của Codex, session của Claude) cùng worktree trong journal. Cả hai runtime đều lưu lịch sử session trên máy, và đã kiểm chứng đọc được cho chính các run NeoMind ở `demo/claude-e2e1`.

## Kết quả kiểm chứng trên máy này

| | Codex | Claude Code |
| --- | --- | --- |
| Nơi lưu | `~/.codex/sessions/YYYY/MM/DD/rollout-<thời điểm>-<threadId>.jsonl` (28 file trên máy) | `~/.claude/projects/<cwd đổi ký tự lạ thành ->/<sessionId>.jsonl` (hoặc dưới `CLAUDE_CONFIG_DIR`) |
| Run NeoMind có lưu không | Có. Ví dụ reviewer của run `run-4d417ad1…`: thread `01a18b1c-a824-…` | Có. Ví dụ writer của run `run-e25824d9…`: session `16ff3999-…`, thư mục theo đường dẫn worktree của run |
| Cách đọc ổn định | **API chính thức của app-server**: `thread/read`, `thread/turns/list` (`itemsView: full`), `thread/items/list` (phân trang). Đã gọi thật: trả về `userMessage`, `agentMessage`, `commandExecution` (lệnh + output), verdict cuối | **Không có API đọc session.** Chỉ có file JSONL nội bộ; Claude Code dùng nó cho `--resume` |
| Loại nội dung | Item có kiểu rõ ràng: userMessage, agentMessage, reasoning, plan, commandExecution, fileChange, mcpToolCall, webSearch, contextCompaction, … | Bản ghi `user`/`assistant` với các phần `text`, `thinking`, `tool_use` (Read, Edit, Write, Glob, Grep, StructuredOutput), `tool_result`; xen lẫn nhiều bản ghi nội bộ (`queue-operation`, `api-request-blob`, `cost-state`, `attachment`, …) |
| Độ bền định dạng | Ổn định (API có schema, `codex app-server generate-json-schema`) | Định dạng nội bộ, có thể đổi theo phiên bản; phải đọc khoan dung (chỉ lấy `user`/`assistant`, bỏ qua loại lạ) |
| Thời gian giữ | Theo Codex (có `archive`/`delete`) | Claude Code tự dọn session cũ theo `cleanupPeriodDays` của người dùng |

Session của NeoMind cũng hiện trong lịch sử của chính Codex và Claude Code (vì là session bình thường), nên `codex resume` hoặc `claude --resume` từ worktree của run có thể mở lại, nhưng làm vậy là chạy agent ngoài tầm kiểm soát của NeoMind (không journal, không giới hạn quyền như lúc chạy run).

### Phát hiện phụ (nên sửa riêng)

1. **Worker Codex của NeoMind nạp cấu hình cá nhân của người dùng.** Transcript reviewer có `AGENTS.md` toàn cục (`~/.codex/AGENTS.md`), phần skills và hướng dẫn multi-agent của Codex. Phía Claude đã tách sạch bằng `--setting-sources ""`; phía Codex chưa. Cần chạy Codex với `CODEX_HOME`/cấu hình tách riêng cho NeoMind (vẫn dùng chung đăng nhập), rồi kiểm chứng transcript không còn các phần này.
2. **Lượt Claude bị dừng để lại câu "No response requested."** trong session (lượt viết bị kill khi thử crash ở E2E 3). Khi hiển thị nên gắn nhãn "lượt bị dừng" thay vì coi là câu trả lời của agent.
3. Session của NeoMind làm đầy lịch sử Codex/Claude của người dùng. Có thể đặt tên thread Codex (`thread/name/set`, ví dụ "NeoMind · Dev · Implement") để dễ nhận ra.

## Hai cách làm

### A. Đọc lịch sử gốc của runner khi người dùng mở

- Codex: khởi một worker app-server ngắn hạn, gọi `thread/turns/list` + `thread/items/list` theo `sessionId` của attempt, lọc theo `runnerTurnId` để chỉ lấy đúng lượt của bước đó.
- Claude: đọc `<config>/projects/<slug(worktree)>/<sessionId>.jsonl`, lấy các bản ghi `user`/`assistant` từ prompt của attempt tới kết quả.
- Ưu: không tốn thêm chỗ, có đủ chi tiết runner ghi. Nhược: phụ thuộc runner còn giữ session; định dạng Claude không ổn định; cần process Codex để đọc.

### B. NeoMind tự ghi transcript chuẩn hóa trong lúc chạy

- Luồng sự kiện đã đi qua NeoMind: Claude `stream-json` (đã parse trong `claude-stream.ts`), Codex notifications `item/started`, `item/completed`, delta (đã nhận trong `codex-turn-events.ts`).
- Ghi thành `runs/<runId>/transcripts/<attemptId>.jsonl` với một định dạng chung cho mọi runner: `message`, `reasoning` (tóm tắt), `tool` (đọc file, sửa file kèm số dòng +/−, chạy lệnh kèm exit code và output rút gọn), `structured_output`, `usage`, `interrupted`.
- Ưu: một định dạng cho mọi runner (cả runner sau này), bền cùng run, không phụ thuộc runner dọn dẹp, và **chính là nguồn cho luồng "Hoạt động" trực tiếp** trong mockup màn đang chạy. Nhược: phải sửa hai adapter, cần giới hạn kích thước (output lệnh, nội dung file đọc).

### Đề xuất

Làm **B làm nguồn chính** cho run mới, **A làm phương án dự phòng** cho các run cũ và nút "Xem session gốc" (Codex qua API, Claude qua file). UI: trên mỗi bước agent ở màn theo dõi run có "Xem session", mở ngăn bên với dòng thời gian: prompt (thu gọn), tin nhắn agent, thao tác (đọc, sửa, chạy lệnh) có thể mở rộng xem output/diff, output có cấu trúc, token; khi run đang chạy, dòng thời gian cập nhật trực tiếp.

## Lưu ý an toàn

- Transcript chứa nội dung file và output lệnh, có thể có bí mật. Chỉ phục vụ qua editor local (đã có kiểm tra host/token), không ghi vào log, giới hạn kích thước mỗi mục.
- Ẩn thông tin tài khoản trong metadata session Codex (`creator_user_id`, `creator_account_id`).
- Chỉ đọc. Không cung cấp nút tiếp tục session từ UI NeoMind, vì như vậy agent chạy ngoài journal và ngoài giới hạn quyền.

## Ước lượng

| Phần | Việc |
| --- | --- |
| B · ghi transcript | Bộ ghi chung + hook trong adapter Claude và Codex; giới hạn kích thước; test với fake runner |
| A · đọc lịch sử gốc | Codex qua app-server API, Claude qua file; ghép theo attempt; test với file mẫu |
| API + UI | `GET /api/runs/:id/attempts/:attemptId/transcript`; ngăn "Xem session" + luồng Hoạt động trực tiếp |
| Phát hiện phụ 1 | Tách cấu hình Codex của NeoMind khỏi cấu hình cá nhân |
