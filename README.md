# NeoMind
Shared AI workflows, agent skills, and reusable tooling for Neo projects. Project-specific policies and daily work remain in their owning repositories.

Research and design for the `hieu/adaptive-agent-flow` branch: [start with the local-session handoff](docs/adaptive-agent-flow/README.md). This branch currently contains design documents and research findings; the proposed runtime is not implemented yet.

Current implementation baseline: [NeoMind v1 consolidated design](docs/adaptive-agent-flow/design-v1.md), with [implementation handoff and acceptance milestones](docs/adaptive-agent-flow/implementation-handoff.md). The user has requested implementation in a separate GPT-6.1 Terra chat; runtime functionality still requires implementation and verification.

### Project memory (foundation)

Memory Markdown hiện được lưu độc lập với lựa chọn frontend. Tạo thư mục memory và chọn một SQLite coordination database dùng chung cho các ứng dụng trên cùng máy; thay các đường dẫn ví dụ bằng đường dẫn thực tế:

```bash
npm run build
npm run neomind -- memory configure /path/to/project /path/to/coordination.sqlite /path/to/memory
npm run neomind -- memory project-search /path/to/project /path/to/coordination.sqlite "từ khóa"
```

Các linked worktree dùng cùng mapping theo Git common directory. `configure` chỉ tạo mapping mới; đổi mapping đã có cần API có compare-and-swap. Nếu root không khả dụng, lệnh báo lỗi và không tự tạo root thay thế. Các lệnh này hiện hỗ trợ đọc; giao diện duyệt lesson và kết nối Nimbalyst chưa hoàn tất. Không chạy những lệnh trên với đường dẫn ví dụ nguyên văn.
