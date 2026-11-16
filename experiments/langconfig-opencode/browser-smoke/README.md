# Browser smoke — NodeConfigPanel fixture

Chạy Chrome headless thật với `NodeConfigPanel.tsx` của stage đã patch, bundle
trong bộ nhớ bằng esbuild từ node_modules lab; không sửa stage và không chạy
backend LangConfig. HTTP server giả chỉ lắng nghe loopback trong network
namespace mới. Playwright chặn mọi URL ngoài origin đó, service worker bị tắt;
server từ chối endpoint ngoài danh sách giả. Không dùng model hay credential.

```sh
SMOKE_TMP_ROOT=/dev/shm sh experiments/langconfig-opencode/browser-smoke/run.sh
```

Yêu cầu Linux cho phép `unshare -Urn`, `ip`, Node, Chrome và các dependency đã
cài trong `/home/hieu-tran/.local/share/langconfig-eval-20261114/langconfig/node_modules`.
Mặc định stage `/dev/shm/neomind-langconfig-approved-20261115-01`, Chrome
`/usr/bin/google-chrome`; đổi bằng `LANGCONFIG_STAGE`, `LANGCONFIG_MODULES`,
`CHROME`. Chỉ chạy qua `run.sh`: file `.mjs` không tự tạo network namespace.
Không có fallback nếu namespace không tạo được. HOME/TMPDIR mới được in ra và
giữ lại; mặc định tạo dưới `/tmp/opencode`, có thể chọn filesystem còn chỗ bằng
`SMOKE_TMP_ROOT`. Environment bị xóa trước khi chạy. `--no-sandbox` là giới hạn
Chrome, không phải OS sandbox cho nội dung không tin cậy; namespace này chỉ
chứng minh cách ly mạng, không cách ly filesystem hay Unix socket.

Smoke chọn `mcp:opencode_review`, nhập `attempt_id` và `instruction`, nhấn Save,
kiểm `onSave` nhận node ID, tool type, tool ID và cả hai tham số. Báo hash file
panel đã test, các API giả được gọi và số request ngoài origin. Không kiểm CSS,
toàn bộ app/canvas, backend, lưu thực, gọi tool, approval hay model.

## Kết quả Linux 15/11/2026

Stage HEAD `eb786cf8efe0b6cc9e45d07362e66da6ec465424`, panel SHA-256
`323abd47dd62841413bd62cdde009becec06ce349e651d387a5a3c7004182a80`:
**pass**, `onSave` nhận đủ các giá trị fixture, 0 request ngoài origin, 0 lỗi
trang. Namespace chỉ có `lo`; request tới output-schemas, settings, custom-tools,
skills và workflows đều do HTTP server giả trả lời. Trước đó một lượt bị lỗi
quota ở `/tmp/opencode`, Chrome dừng trước Save; lượt pass dùng `/dev/shm`.
Stage và thư mục tmpfs có thể không còn sau reboot; hash giúp nhận diện file,
không chứng minh các file phụ thuộc khác không đổi.
