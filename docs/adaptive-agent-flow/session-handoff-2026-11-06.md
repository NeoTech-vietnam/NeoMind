# Bàn giao thiết kế lại NeoMind — 06/11/2026

GĐ 0–5: spike `spike/ui-shadcn`, shell `ui/redesign-p1`, Runs `ui/redesign-p2`, Flow Studio `ui/redesign-p3`, Profiles/Memory `ui/redesign-p4`, hoàn thiện `ui/redesign-p5`. Không đổi backend và không push. Chi tiết: [kế hoạch](../design/redesign-plan.md), [trạng thái](implementation-status.md).

## Kiểm chứng

- Windows: `npm test` 222 test: 220 pass, 0 fail, 2 skip; TypeScript UI, build UI và build extension đạt. Panel bundle 1.356.324 bytes (gzip theo Vite 364,84 kB). Không chạy flow thật hoặc cài extension trong lượt này.
- Gallery dữ liệu giả được xem bằng Edge ở web 1440 và panel giả lập 900, tối/sáng, các trạng thái Runs, Flow Studio, Profiles, Memory, Ctrl K và màn chưa có flow. Đã kiểm portal trong shadow root giả lập; chưa xác nhận bản build mới trong host Nimbalyst thật hoặc đổi theme trực tiếp tại host.
- GĐ 3 từng có test `parallel writers run concurrently` fail trong suite nhưng chạy riêng đạt; GĐ 4 suite đầy đủ đạt. Fixture chờ tối đa 5 giây, chưa chứng minh nguyên nhân. Không nới test. `test/claude-capabilities.test.ts` gọi Claude CLI thật khi đăng nhập, chi phí ước tính khoảng $0.002/lần.

## Xem lại

Chạy `npx vite --config ui/vite.config.ts --host 127.0.0.1` trong checkout rồi mở `/__gallery/`, `/__gallery/runs.html`, `/__gallery/flow.html`, `/__gallery/profiles.html`, `/__gallery/memory.html`. Hash `light`, `panel` và trạng thái như `waiting`, `running,session`, `blocked`, `completed`, `new,filter`, `insp`, `add`, `compare`, `errors`, `create`, `edited`, `skills`, `root`, `detail`, `policy` dùng dữ liệu giả. Ảnh mới nằm trong `docs/design/redesign/after-*.png`.

## Bài học kỹ thuật

- Radix Portal phải nhận node từ `usePortalContainer()` nằm trong lớp theme ở shadow root; nếu vào `document.body`, panel mất style.
- `registerDocumentRules` chuyển `@property` và `@font-face` lên document; phần preflight và CSS còn lại chạy trong shadow root. Tailwind `@source "./"` cần thiết khi build panel từ thư mục extension.
- Thứ tự layer là `xyflow, theme, base, components, utilities`. Giữ base text trên `.nm-theme` để portal cùng theme; React Flow dùng token và `colorMode`.
- Host Nimbalyst cấp React 19.2.7, tránh API chỉ có ở 19.3. Không cài extension trong lượt này.
- Edge headless trên Windows: đường dẫn ảnh và `--user-data-dir` viết sẵn trong dấu nháy đơn, dùng profile mới mỗi lần; file ảnh có thể xuất hiện vài giây sau khi lệnh trả. CDP nên khởi động Edge bằng shell với cổng debug riêng.

## Bàn giao Flow Studio đã gộp

GĐ 3 (`ui/redesign-p3` từ `570723e`) chuyển header, canvas, dải thêm bước, thẻ, inspector, ngăn Vấn đề và sheet so sánh; panel dùng sheet inspector. Lượt hoàn thiện thêm component chung, sửa tên bước ngay tại tiêu đề, chọn agent sửa và nhánh join bằng checkbox, giữ ID không còn hợp lệ để người dùng tự bỏ chọn. Gallery `flow.html` có `insp`, `add`, `compare`, `errors`; CDP ở GĐ 3 đã chọn Opus và kiểm chip. Bản so sánh dùng diff thuộc tính hiện có.

## Việc còn lại

- Runs: ước tính token từ lịch sử; diff của commit và áp dụng vào main qua giao diện; chạy lại checks, mở worktree, đổi reviewer, lựa chọn xử lý khi bị chặn và so sánh kế hoạch.
- Flow Studio: phân loại cảnh báo/lỗi từ validate và mô phỏng flow; hiện mọi diagnostic được coi là lỗi.
- Profiles: kiểm tra hash skill đã lệch, đọc nội dung phiên bản profile cũ, thời gian lưu và chuyển các flow sang phiên bản profile mới.
- Memory: revision/cập nhật của toàn bộ thư mục memory. API hiện đã có preview theo task và receipt từ chối lesson, nên hai khả năng này đã được dùng.

- Kiểm cài đặt và tương tác panel thật trong Nimbalyst, gồm đổi theme khi panel đang mở. Skill thiết kế Frontend Design, UI UX Pro Max và shadcn/ui chưa được cài cho project.
