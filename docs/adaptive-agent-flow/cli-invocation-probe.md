# Thử gọi nhiều CLI từ một chương trình điều phối

Ngày: 28/10/2026. Nhánh: `hieu/adaptive-agent-flow`.

## Mục tiêu

Kiểm tra một chương trình ngoài Nimbalyst có thể khởi chạy Codex CLI, Claude Code và OpenCode ở chế độ không tương tác, gửi prompt và thu kết quả có cấu trúc hay không.

Prompt yêu cầu chỉ trả lời `NEOMIND_PROBE_OK`, không dùng tools, sửa file hoặc tạo agent/session khác. Dùng Python `subprocess.run` với argument arrays, capture stdout/stderr, giới hạn 45 giây và chạy các tiến trình độc lập từ cùng chương trình bằng thread pool. Working directory là `/tmp/neomind-cli-probe/work`, không phải source project.

## Công cụ và điều kiện

- Codex CLI `0.163.0`, có sẵn; `codex login status` báo đăng nhập bằng ChatGPT.
- Claude Code `2.1.312` và OpenCode `1.19.5` cài tạm từ npm vào `/tmp/neomind-cli-probe`, không sửa manifests/lockfiles của project.
- Claude auth status báo chưa đăng nhập. OpenCode auth list báo không có saved credentials; có phát hiện tên biến cho Vertex, nhưng không kiểm chứng quyền truy cập Vertex vì không thuộc mục tiêu DeepSeek.
- Không có secret/runtime-variable bindings trong cấu hình cloud được quan sát. Không in hoặc sao chép credential values.

## Kết quả quan sát

| Công cụ | Gọi tiến trình và đọc output | Inference hoàn tất |
| --- | --- | --- |
| Codex | Có JSONL `thread.started`, `thread_id`, `turn.started` và error events | Không: proxy từ chối kết nối tới ChatGPT backend bằng HTTP CONNECT 403; dừng sau timeout 45 giây |
| Claude Code | Có JSON result, `session_id`, exit code 1 và `is_error: true` | Không: `Not logged in · Please run /login`; không có token inference được báo cáo |
| OpenCode | Có JSON error event, `sessionID` và exit code 1 | Không: model DeepSeek chưa resolve được; catalog request tới `models.opencode.ai` cũng bị proxy từ chối 403 |

Codex dùng `exec --ephemeral --json --sandbox read-only --skip-git-repo-check --disable multi_agent`. Claude dùng `-p --output-format json --tools "" --strict-mcp-config --mcp-config '{"mcpServers":{}}' --no-session-persistence`. OpenCode dùng `run --pure --format json --model ...`; `--pure` không đồng nghĩa cưỡng chế tắt subagent.

OpenCode thử `deepseek/deepseek-chat`; bật diagnostic logs xác định `ProviderModelNotFoundError`. Thử tiếp `deepseek/deepseek-v4-pro` theo gợi ý diagnostic vẫn không resolve được model trong môi trường này. Không coi tên model gợi ý là cấu hình đã được xác nhận hay tiếp tục đoán tên. Cần kiểm tra danh sách model thực tế sau khi có cấu hình provider và catalog hoạt động.

Các session IDs chỉ chứng minh CLI tạo hoặc gán định danh phiên; không chứng minh phiên đã gọi model thành công, có lịch sử bền vững hoặc có thể resume. Codex/Claude được chạy ở chế độ không lưu phiên.

## Hàm ý thiết kế

Một caller chung có thể chạy các CLI riêng biệt. Cần adapter riêng cho từng công cụ để chuẩn hóa arguments, auth diagnostics, events và final result. Không có một định dạng output hoặc cách định danh model chung mặc định.

Một chi tiết thực tế từ Claude: JSON có `subtype: success` nhưng đồng thời `is_error: true`, `terminal_reason: api_error`, thông báo chưa đăng nhập và process exit code 1. Adapter không được dùng một nhãn `success` đơn lẻ để đánh dấu node hoàn thành.

Chưa kiểm chứng inference thành công, output handoff giữa các CLI, resume/cancel, chạy song song có ích, giới hạn token, hay integration với Nimbalyst. Không có kết luận rằng flow end-to-end đã hoạt động.

## Bước thử tiếp

Thử trong môi trường người dùng đã có CLI đăng nhập và network phù hợp; hoặc cấu hình quyền truy cập cần thiết trong cloud rồi kiểm tra lại. Không cần cung cấp credential values trong chat.

1. Xác nhận model/provider đang hoạt động bằng một yêu cầu tối thiểu cho từng CLI.
2. Lặp cùng test qua caller chung, kiểm tra nội dung trả lời, exit code và semantic error fields.
3. Thử bàn giao đầu ra từ CLI A sang CLI B trong hai phiên độc lập.
4. Sau đó kiểm tra resume, cancellation, isolation và cấu hình chặn delegation của từng adapter.

Google Antigravity không được thử trong probe này. [Khảo sát sau đó](antigravity-research.md) đã xác minh SDK và CLI tồn tại, nhưng người dùng quyết định tạm hoãn tích hợp vì ngân sách.
