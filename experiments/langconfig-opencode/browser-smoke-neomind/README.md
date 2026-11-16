# Browser smoke preview LangConfig trong NeoMind

Test dùng **editor HTTP và web UI build thật**, Chrome headless, project Git tổng
hợp mới và `workflow-export.json` fixture tổng hợp. Chỉ dùng server test khởi
tạo, không kết nối editor hay project của người dùng. Điều hướng Flows, mở
dialog, chọn file, kiểm POST có origin/token thật, HTTP 200, diagnostics, cảnh
báo không thể chạy và không lộ các sentinel trong response hoặc nội dung trang;
chọn file quá 1 MiB và kiểm không có POST thứ hai. So sánh hash toàn bộ file
project (kể cả `.git`), HEAD và git status trước/sau.

```sh
npm run build
npm run build:ui
sh experiments/langconfig-opencode/browser-smoke-neomind/run.sh
```

Linux cần `unshare -Urn`, `ip`, Git, Node, `/usr/bin/google-chrome`, Playwright
trong `/home/hieu-tran/.local/share/langconfig-eval-20261114/langconfig/node_modules`.
Có thể đổi `CHROME`, `LANGCONFIG_MODULES`, `SMOKE_TMP_ROOT`; mặc định tạo thư mục
mới trong `/dev/shm` và giữ lại, in đường dẫn. `run.sh` xóa environment, cấp
HOME/XDG_STATE_HOME riêng, chỉ bật `lo` trong network namespace mới; thất bại nếu
không tạo được namespace. Không chạy trực tiếp `smoke.mjs` vì nó không tự tạo
namespace. Chrome dùng `--no-sandbox`; namespace mạng không phải sandbox filesystem.

**Host giả có giới hạn:** Playwright trả dữ liệu rỗng cho GET nền `/api/runs`,
`/api/programs`, `/api/stats`, `/api/runners/opencode` để không khởi tạo runtime
hoặc khám phá provider. Trang tĩnh, bootstrap, runners và POST preview dùng server
thật; request khác bị chặn và làm test lỗi. Không kiểm việc chạy/persist của các
endpoint nền; kiểm chứng không ghi chỉ bao phủ project fixture và không có POST
nào khác, không phải theo dõi mọi side effect ở cấp hệ điều hành. Không thử
Nimbalyst, truy cập model, credentials hay mạng ngoài.

Linux 15/11/2026: **pass**, Chrome thật, một POST preview, không request ngoài
allowlist, không lỗi trang, file project và HEAD không đổi; file lớn không gửi
request. Một lượt trước bị chặn GET nền `/api/stats`, sau đó được thêm vào danh
sách mock; không gửi GET đó tới runtime thật. Các thư mục `/dev/shm` không bền
qua reboot.
