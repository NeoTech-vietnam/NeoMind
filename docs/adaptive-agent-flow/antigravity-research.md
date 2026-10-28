# Xác minh Antigravity SDK, CLI và đường tích hợp Nimbalyst

Ngày khảo sát: 28/10/2026. Phạm vi: tài liệu/source công khai và metadata package; chưa cài SDK/CLI hoặc chạy inference.

**Quyết định sau khảo sát:** người dùng tạm hoãn Antigravity vì ngân sách, ưu tiên đăng nhập tài khoản/subscription hiện có. Report được giữ làm lịch sử nghiên cứu; các thử nghiệm tiếp được liệt kê bên dưới đã hoãn, không phải công việc được lên lịch cho phase hiện tại.

## Kết luận

Đã tìm được SDK Python và CLI trong tổ chức GitHub `google-antigravity`. Có interface phù hợp để nghiên cứu adapter NeoMind; chưa đủ bằng chứng kết luận adapter thực tế đã hoạt động. Thông tin trước đây "chưa xác minh" được thay bằng kết quả bên dưới.

## 1. SDK Python

- Repo: [antigravity-sdk-python](https://github.com/google-antigravity/antigravity-sdk-python).
- HEAD quan sát: `91dc5f84565bb505577ac9524f107f453a6e8d1f`.
- Package: [`google-antigravity`](https://pypi.org/project/google-antigravity/), version PyPI quan sát `0.1.22`, Python `>=3.10`, manifest ghi Development Status Alpha, tác giả Google LLC, Apache-2.0.
- Các wheel version này trên PyPI được upload ngày 13/10/2026 UTC. Có artifacts cho macOS, Linux và Windows; chưa kiểm chứng conformance từng hệ điều hành.
- README yêu cầu cài package từ PyPI để có compiled runtime binary. Clone source đơn thuần không đủ để chạy.

API mô tả ba lớp: `Agent` quản lý config/lifecycle, `Conversation` giữ session/history/turn/usage, `Connection` và `ConnectionStrategy` quản lý transport và process. Local connection dùng một Go harness, WebSocket và protobuf messages serialized dưới dạng JSON.

Một `async with Agent(...)` tạo một Conversation; nhiều instance có thể tạo các conversation độc lập. Các khả năng được mô tả gồm chat/streaming, custom tools, MCP, skills paths, hooks và policies. Connection API có `cancel()` và `disconnect()`. Đây là bằng chứng interface/tài liệu, không phải xác nhận durable resume qua process restart hoặc delegation enforcement đã chạy được.

Auth được tài liệu SDK chỉ dẫn:

- Gemini API key (`GEMINI_API_KEY`).
- Google Cloud/Vertex: API key Express Mode hoặc project/location với Application Default Credentials.

Không có bằng chứng trong các tài liệu đã đọc rằng SDK tự dùng tài khoản/subscription đã đăng nhập trong Antigravity IDE. Không suy ra CLI login và SDK auth có thể dùng thay nhau.

## 2. CLI chính thức

- Repo: [antigravity-cli](https://github.com/google-antigravity/antigravity-cli).
- HEAD quan sát: `a6b3429ebabafd6efd129c6d2f6161b02f061f22`.
- Lệnh được README giới thiệu: `agy`.
- README mô tả TUI, coding/tools, persistent history, engine chung với Antigravity 2.0 và khả năng export terminal session vào GUI.
- Auth dùng system keyring, fallback sang Google Sign-In qua browser hoặc URL khi remote/SSH.

README chưa đủ để xác nhận non-interactive mode, machine-readable event protocol hoặc session-control API mà NeoMind cần. Không đánh đồng việc có CLI tương tác với khả năng làm runner headless đã được kiểm chứng. Chưa chạy installer hay binary.

## 3. Nimbalyst hiện dùng một đường khác

Source [GeminiAntigravityProvider.ts](https://github.com/nimbalyst/nimbalyst/blob/main/packages/runtime/src/ai/server/providers/GeminiAntigravityProvider.ts) mô tả:

- Provider `antigravity-gemini-agent` dùng Antigravity language server qua Connect-RPC, không dùng SDK Python ở trên.
- Call `GetModelResponse({prompt, model})` là stateless/buffered; Nimbalyst tự cung cấp tool loop qua `AntigravityToolLoopProtocol`.
- Không có provider-native session ID trong đường này; history nằm ở host và được đưa lại vào prompt.
- Không có token usage trong response đó; không được coi thiếu telemetry là chi phí bằng 0.
- Reuse login Antigravity hiện có; Nimbalyst không lưu API key riêng cho provider này.

Đây là implementation của Nimbalyst, không phải bằng chứng Connect-RPC là API public/stable được Google hỗ trợ cho bên thứ ba. Không đề xuất copy cách đọc credentials hoặc dựa vào endpoint nội bộ cho standalone NeoMind.

## 4. Hàm ý cho NeoMind

Trong Nimbalyst, vẫn ưu tiên session API của host và capability checks; session ở lớp host có thể tồn tại dù upstream không giữ native session. Không cần cài SDK Python để tận dụng host provider nếu nó được phiên bản Nimbalyst mục tiêu hỗ trợ.

Standalone có ứng viên SDK Python chính thức. Nếu core chọn TypeScript, có thể nghiên cứu Python worker với protocol có cấu trúc; đây là phương án thiết kế, chưa phải quyết định bổ sung process layer. Cần kiểm tra auth/cost phù hợp nhu cầu tài khoản của người dùng trước khi ưu tiên runner này.

Các thử nghiệm tiếp: install/import runtime từ wheel đã pin; request tối thiểu khi có auth; độc lập Conversation; tool/delegation restrictions; cancel; durable persistence/resume; output/error/usage normalization. Không tự mở rộng Antigravity thành yêu cầu bắt buộc v1.

## Nguồn và giới hạn truy cập

- [SDK README](https://github.com/google-antigravity/antigravity-sdk-python/blob/91dc5f84565bb505577ac9524f107f453a6e8d1f/README.md).
- [SDK manifest](https://github.com/google-antigravity/antigravity-sdk-python/blob/91dc5f84565bb505577ac9524f107f453a6e8d1f/pyproject.toml).
- [Conversation documentation](https://github.com/google-antigravity/antigravity-sdk-python/blob/91dc5f84565bb505577ac9524f107f453a6e8d1f/google/antigravity/conversation/README.md).
- [Connection documentation](https://github.com/google-antigravity/antigravity-sdk-python/blob/91dc5f84565bb505577ac9524f107f453a6e8d1f/google/antigravity/connections/README.md).
- [PyPI metadata](https://pypi.org/pypi/google-antigravity/json).
- [CLI README](https://github.com/google-antigravity/antigravity-cli/blob/a6b3429ebabafd6efd129c6d2f6161b02f061f22/README.md).
- [Nimbalyst adapter source](https://github.com/nimbalyst/nimbalyst/blob/main/packages/runtime/src/ai/server/providers/GeminiAntigravityProvider.ts), URL nhánh động.

Trang `antigravity.google/docs` bị proxy môi trường chặn HTTP CONNECT 403. Khảo sát tiếp tục qua GitHub và PyPI; không coi lỗi truy cập đó là bằng chứng SDK không tồn tại. Các repo SDK cộng đồng/unofficial trong search không được dùng làm cơ sở xác nhận SDK chính thức.
