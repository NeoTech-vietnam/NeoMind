# NeoMind

NeoMind cấu hình và chạy agent flows, với kế hoạch cần duyệt, kiểm tra độc lập và memory dùng chung theo project.

Hiện đã chạy end-to-end **Codex standalone trên Linux** trong worktree riêng: khảo sát → duyệt kế hoạch → thực hiện → checks → review → commit local. Đây là bản đang phát triển; nhiều writer song song, tích hợp nhánh và Nimbalyst chưa hoàn tất.

Đọc [tiến độ hiện tại](docs/adaptive-agent-flow/implementation-status.md) và [bàn giao session ngày 29/10/2026](docs/adaptive-agent-flow/session-handoff-2026-10-29.md) trước khi tiếp tục. [Thiết kế v1](docs/adaptive-agent-flow/design-v1.md) vẫn là phạm vi mục tiêu.

## Chạy Flow Studio

Cần Node >=22.16, Codex CLI đã đăng nhập và Linux user-systemd hoạt động cho worker scopes. Runtime đã được thử với Node 22.22.1 và Codex CLI 0.165.0.

```bash
npm ci
npm test
npm run build:ui
npm run neomind -- editor /absolute/path/to/project
```

Mở URL localhost được in ra. Editor hỗ trợ canvas kéo thả, flow/profile drafts và versions, model/reasoning, theo dõi run, duyệt kế hoạch, yêu cầu sửa kế hoạch, pause/resume/cancel, thử lại Git, memory và duyệt lessons. Publish flow trước khi chạy bản chỉnh sửa. Preview hiển thị cấu hình thực tế và chặn graph chưa được executor hỗ trợ.

Mặc định standalone dùng `gpt-6-luna` reasoning `low`; có thể chọn `gpt-6.1-sol` hoặc `gpt-6.1-terra` khi runner cung cấp. Không tự chuyển model ngoài danh sách fallback đã cấu hình. Chạy thật sử dụng quota tài khoản Codex.

## CLI cơ bản

Thay đường dẫn ví dụ bằng project Git thực tế:

```bash
npm run neomind -- run preview /absolute/path/to/project dev
npm run neomind -- run start /absolute/path/to/project dev "Mô tả task"
npm run neomind -- run list /absolute/path/to/project
npm run neomind -- run show /absolute/path/to/project RUN_ID
npm run neomind -- run approve /absolute/path/to/project RUN_ID --plan-hash PLAN_HASH
npm run neomind -- run resume /absolute/path/to/project RUN_ID
```

`PLAN_HASH` lấy từ trạng thái kế hoạch đang chờ duyệt. CLI còn thiếu một số controls đã có trên UI. Chỉ một process được sở hữu scheduler của mỗi run; không điều khiển đồng thời run đang được editor sở hữu từ CLI.

## Dữ liệu và giới hạn

Flow/profile project nằm trong `.neomind/flows` và `.neomind/profiles`; cấu hình project tùy chọn ở `.neomind/project.json`. Journal, coordination SQLite và worktrees nằm dưới `${XDG_STATE_HOME:-~/.local/state}/neomind/<project-key>`. Các linked worktrees dùng identity Git common directory chung.

Memory Markdown độc lập với frontend. UI cho cấu hình root, ghi context/quyết định với receipt và duyệt lesson trước khi chia sẻ. Revision và nội dung memory được ghim trong từng run; root không khả dụng sẽ báo lỗi. Nimbalyst adapter chưa được triển khai.

Executor hiện chỉ hỗ trợ worktree riêng với tối đa một writer; reviewer có thể chạy song song trong giới hạn cấu hình. Commit local dùng `commit-tree` và cập nhật ref có kiểm tra baseline, **không chạy Git hooks**. Flow không tự push hoặc tạo PR. Xem bàn giao để biết giới hạn recovery, Git và acceptance còn lại.
