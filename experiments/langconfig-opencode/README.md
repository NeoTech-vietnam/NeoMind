# Thử nghiệm LangConfig + OpenCode

Prototype fixture, **không phải tích hợp production**. Mặc định tool bị khóa;
HTTP transport chỉ chấp nhận `fixture/fake-review#high`. Đề xuất
`opencode/deepseek-v4.1-flash-free#high` **chưa bật live**, không có lệnh gọi
model thật. Không sửa NeoMind runtime hoặc dùng service OpenCode đang chia sẻ.

## Chuẩn bị clone và dependency

Trên Linux, cần Git, Python 3.12, Node/npm cho wire và đủ dung lượng ở ngoài
checkout. Đứng tại gốc NeoMind; chọn `$LAB` mới trên filesystem có quota, và
interpreter `$PYTHON` trong môi trường riêng. `prepare.py` clone upstream tại
SHA `eb786cf8efe0b6cc9e45d07362e66da6ec465424`, áp patch registry nhỏ rồi
chép overlay; từ chối đích đã tồn tại hoặc trùng checkout NeoMind, không xóa
dữ liệu cũ. Mặc định clone từ GitHub; có thể thêm `--source /path/to/langconfig`
để clone từ Git repository cục bộ có commit đó (không copy thay đổi working tree).

```bash
set -euo pipefail
export LAB="$HOME/.local/share/neomind-langconfig-lab"
mkdir -m 700 "$LAB"
python3.12 -m venv "$LAB/env"
export PYTHON="$LAB/env/bin/python"
export TMPDIR="$LAB/tmp"
mkdir "$TMPDIR"
"$PYTHON" -m pip install -r experiments/langconfig-opencode/requirements-selected.txt
"$PYTHON" experiments/langconfig-opencode/prepare.py --dest "$LAB/stage"
```

Chạy trong shell Bash riêng. Lệnh tạo lab cố ý dừng nếu thư mục đã tồn tại;
chọn tên khác thay vì xóa/ghi đè. Nếu đã chuẩn bị một lab/prefix riêng theo
[hướng dẫn setup](../../docs/langconfig/setup-and-tests.md), giữ `LAB` đó và đặt
`PYTHON` tới interpreter Python 3.12 của prefix; không tạo lại lab hoặc venv.

`requirements-selected.txt` ghi các dependency trực tiếp từ môi trường đã dùng,
không phải lockfile đầy đủ: transitive dependency vẫn có thể thay đổi. Nó bỏ
stack ML/audio lớn, không phải toàn bộ `backend/requirements.txt` của upstream;
không bảo đảm các chức năng còn lại của LangConfig hoạt động. **Chưa kiểm chứng
cài từ environment rỗng**: lượt replay bên dưới dùng environment đã có sẵn.
Không cần khởi động PostgreSQL hay nhập credential để chạy 17 test này.

## Unit + graph giả

Dùng bản staging vừa tạo. `mktemp` tạo thư mục mới cho log và pytest; không
trỏ `--basetemp` vào thư mục có dữ liệu vì pytest có thể xóa thư mục đó.

```bash
export TEST_RUN="$(mktemp -d "$LAB/pytest-run-XXXXXXXX")"
(
  cd "$LAB/stage"
  PYTHONPATH="$PWD/backend" "$PYTHON" -m pytest -q -p no:cacheprovider \
    --basetemp="$TEST_RUN/tmp" tests/prototype/test_opencode_review.py
) 2>&1 | tee "$TEST_RUN/pytest.log"
```

Nếu cần lấy exit code qua pipe trong bash, bật `set -o pipefail` trước lệnh.
Trên Linux ngày 15/11, clone staging mới dùng Python 3.12 environment có sẵn:
**17 passed, 1 warning** (ngoài ra pytest-asyncio in cảnh báo cấu hình khi
khởi động). Test graph gọi registry và `execute_tool_node` thực, nhưng transport
trong 17 test là fake; không phải full HTTP backend hoặc WorkflowExecutor.

Test lifecycle của harness chạy riêng từ gốc NeoMind, không cần OpenCode hoặc DB:

```bash
"$PYTHON" -m pytest -q -p no:cacheprovider \
  --basetemp="$TEST_RUN/harness-tmp" experiments/langconfig-opencode/tests
```

Các test này kiểm cleanup từng process khi lỗi, SIGTERM và escalation; không
thay cho xác nhận OS scope/stop proof khi dùng model thật. Lượt đóng gói ngày
15/11 chạy **4 test đạt**; parent cũng replay 17 test adapter và wire thành công
trên staging mới sau sửa cleanup và bỏ password khỏi argv. `pip check` trên
environment có sẵn không thấy dependency hỏng; chưa cài thử từ environment rỗng.

## Wire giả — phép thử riêng

Cần binary OpenCode **2.2.7** chính thức và npm truy cập được registry để cài
`@opencode/plugin` đúng 2.2.7 vào thư mục thử riêng. Chọn tên `--work` mới;
không dùng `--pure`, không dùng service đang chạy. Script tạo HOME, XDG,
workspace, plugin, DB và log riêng; khởi động server mới và fake upstream
chỉ trên IPv4 loopback; sau đó dừng process do nó khởi động. Script từ chối
config OpenCode tại ancestor hoặc config managed `/etc/opencode` có dữ liệu.
Cổng được chọn động, nhưng không phải OS sandbox; nếu có config, plugin, MCP,
network policy hoặc service ngoài dự kiến, dừng và điều tra trước khi chạy.

```bash
"$PYTHON" experiments/langconfig-opencode/wire/run.py \
  --stage "$LAB/stage" --work "$LAB/wire-1" \
  --python "$PYTHON" --opencode "$(command -v opencode)"
```

Lượt Linux ngày 15/11 dùng environment có sẵn đã chạy thành công: graph thật
`read_file → opencode_review`, một physical request tới fake upstream và
verdict `needs_changes` cùng finding cố định. Không tính wire vào 17 test;
không đánh giá chất lượng AI. Xem `e2e.log`, `guard-trace.jsonl` và
`upstream-requests.jsonl` trong `$LAB/wire-1`. Giữ mọi output ngoài repo.
Script hiện chỉ replay đường thành công, **không** tái chạy các phép thử 429,
retry, compaction hay ngưỡng guard lịch sử.

`wire/guard` là plugin thử nghiệm chỉ cho provider/model giả và primary; bộ
đếm file không atomic xuyên process, không kiểm variant, không chứng minh được
bao phủ mọi đường dispatch và không phải quota guard cho live. Quyền deny của
session cũng không phải OS sandbox; kết quả wire không chứng minh isolation,
stop proof, không fallback hay an toàn gọi model thật. Không mở khóa live từ
kết quả này. Không đưa `.git`, environment, node_modules, DB, cache, log,
raw output hoặc credential vào repo. Xem `NOTICE` về upstream MIT.
