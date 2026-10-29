# NeoMind v1 — trạng thái implementation

Ngày: 28/10/2026. Baseline thiết kế: [design-v1](design-v1.md). Đây là tiến độ đang phát triển, chưa phải v1 hoàn tất.

## Đã có

- Schema flow/profile, graph compiler và templates Fast/Dev/Research; kiểm tra graph, scope, policy, approval và review. Binding kế thừa/ghim, provenance và snapshot; materialization ghim profile và nội dung skill. Validation chưa thay thế enforcement khi chạy.
- Thư viện flow/profile lưu draft và version bất biến, clone, rename, archive/restore, xóa có xác nhận tên. Các thao tác draft/metadata cần cơ chế đồng bộ ngoài khi nhiều process cùng ghi.
- Logic thuần về readiness của graph, fork/join, review aggregation, lựa chọn reviewer kiểm tra lại theo phạm vi ảnh hưởng đã xác minh, repair budget, approval, preflight và lifecycle. Journal fsync, kiểm tra recovery và mô phỏng run bằng fake adapter; chưa dispatch agent thật. Run mô phỏng có service tuần tự hóa lệnh và journal được bảo vệ bằng run-owner lease, fencing trong SQLite. Lease không hết hạn tự động; recovery cần xác nhận scheduler cũ đã dừng trước khi giải phóng. Quyền run không xác nhận worker đã dừng và không tự fence các tiến trình bên ngoài NeoMind.
- SQLite thử nghiệm cho workspace writer lease, fencing và quarantine; Git baseline ghi nhận thay đổi staged/unstaged/untracked mà không đổi index. Đây chưa phải workspace manager hay cơ chế tích hợp/commit.
- Markdown memory store có CAS và khóa SQLite chia sẻ giữa các process, integrity hash, truy xuất lexical và lesson proposal trong run artifacts; promotion yêu cầu xác nhận từ lớp ứng dụng. CLI có đọc/tìm kiếm khi chỉ rõ root và coordination DB. Registry local map Git common directory đến root và CLI có thể tìm theo project; các host phải được cấu hình dùng cùng database. Có receipt duyệt lesson ràng buộc proposal và revision; chưa có audit receipt cho quyết định project hay giao diện duyệt proposal, và chưa tích hợp host Nimbalyst. Các quyền xác nhận là assertion từ ứng dụng đáng tin cậy, không phải xác thực độc lập.
- Có tạo detached worktree từ commit đầy đủ và resolve primary checkout, thử với dirty checkout; chưa tích hợp run hay xử lý ghép/conflict.
- Transport JSONL cho Codex app-server có handshake, phân tuyến sự kiện và đánh dấu timeout effect unknown; đã khởi tạo thành công app-server `codex-cli 0.156.1` local, chưa dispatch inference, stop hay recovery thật. Nút Run vẫn khóa.
- CLI cho templates, schema, flow/profile library, validate, doctor và editor. Doctor chỉ phát hiện binary, không xác thực capability, đăng nhập hay inference.
- Flow Studio chạy local, cho tạo từ template, chỉnh canvas kéo thả, kết nối, thiết lập bước và reviewer, lưu nháp, validate, publish, sao chép, đổi tên, lưu trữ/khôi phục và xóa. API giới hạn localhost, kiểm tra origin và token khi ghi. Chưa có quản lý profile đầy đủ, monitor run hay thực thi agent; nút Run bị khóa. Bản sao dùng draft đã lưu.

## Kiểm chứng

- Node `v22.22.1`: `npm test` có 61 tests, bao gồm graph, libraries, recovery, workspace fencing, Git baseline, server editor và fake run và memory/registry. `npm run build:ui` thành công; kiểm tra thủ công trên project tạm xác nhận tạo flow, chọn bước và lưu nháp.
- `npm install --package-lock-only --ignore-scripts` báo 0 lỗ hổng. [Node SQLite](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html) vẫn experimental trên Node 22; cần xác minh tương thích host.

## Còn thiếu

| Mốc | Trạng thái |
| --- | --- |
| M0 foundation | Schema, store, materialization và preflight cơ bản đã có; cần hoàn thiện contracts và đồng bộ ghi nhiều process. |
| M1 core | Có service cho fake adapter kết nối scheduler, journal và run-owner coordinator; chưa có run service production hoặc adapter thật, và recovery owner chưa có UI/CLI xác minh scheduler cũ. |
| M2 workspace/memory/CLI | Có worktree detached và memory CAS nền; chưa có tích hợp run, merge/conflict/commit, audit quyết định project, read leases hoặc CLI chạy flow. |
| M3 editor/monitor | Editor prototype đã có; còn profile editor, đầy đủ cấu hình graph, accessibility và run monitor. |
| M4 standalone runtime | Có transport app-server và handshake local; chưa tích hợp adapter vào run service hoặc kiểm chứng inference/auth/stop/resume. |
| M5 Nimbalyst | Chưa triển khai hoặc kiểm chứng tích hợp host. |
| M6 acceptance | Chưa thể chạy; v1 chưa hoàn thành. |

Tiếp theo cần hoàn thiện run service và audit quyết định project, tích hợp workspace, sau đó kiểm chứng adapter thực và Nimbalyst. Không coi fake adapter hay schema validation là security boundary.
