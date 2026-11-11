# Bàn giao MCP standalone — 07/11/2026

- Theo kế hoạch người dùng duyệt, thêm MCP server stdio theo project (`node dist/src/cli/main.js mcp <project>`), dùng SDK MCP và các session tool hiện có; không đăng ký tool riêng của panel. Nguồn duyệt được ghi là phiên MCP. Khi ngắt kết nối hoặc nhận signal, server chặn tool mới và chờ tool đang xử lý trước khi đóng RunManager.
- README hướng dẫn đăng ký với Codex CLI và Claude Code; giữ các thay đổi README đã có trước phiên. Không sửa cấu hình MCP của worker NeoMind.
- Windows: TypeScript build đạt; test MCP stdio và drain đạt 2/2. Chưa chạy inference thật, chưa kiểm chứng host Codex/Claude kết nối thực tế hoặc Linux. `npm ci` chưa kiểm chứng: npm online bị treo, cache thiếu `@hono/node-server`; lockfile được cập nhật bằng metadata offline, SDK được giải nén từ cache để kiểm thử.
- Suite `npm test` trong sandbox chạy trên bản build trước khi sửa lifecycle, bị dừng sau khi đã có lỗi: test Claude process scope, Dev Claude end-to-end và bốn ca khóa file/draft. Chưa có tổng kết đầy đủ, chưa xác định nguyên nhân và không coi các lỗi đó đã được sửa. Hai test MCP được chạy lại sau sửa lifecycle.
