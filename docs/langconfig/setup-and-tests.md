# LangConfig và OpenCode — chuẩn bị và kiểm thử

Tài liệu này dành cho lab Linux riêng, không phải hướng dẫn triển khai production. Chi tiết kết quả và giới hạn nằm trong [báo cáo đánh giá](../adaptive-agent-flow/research-langconfig-vs-neomind-2026-11-14.md). Windows **chưa được kiểm chứng**.

## Chọn đúng phép thử

| Mức | Cần gì | Kết luận được phép rút ra |
| --- | --- | --- |
| NeoMind baseline | Node, npm; chạy ở checkout NeoMind | Suite NeoMind, không phải test LangConfig. |
| Prototype unit/graph giả | Python và dependency LangConfig chọn lọc; **không cần DB server** | Test adapter với transport giả và graph gọi tool node thật. Overlay cuối 21 test đạt, 1 warning; lịch sử trước mở rộng model là 17. |
| Wire giả | Thêm OpenCode **2.2.7** và fake upstream loopback | `StateGraph` → LangConfig `execute_tool_node` → OpenCode server thật → upstream giả. Verdict được lập trình sẵn; đây là phép thử riêng, không nằm trong 17 test. |
| Guard và NeoMind thử nghiệm | Linux namespace, user-systemd, NeoMind đã build | Đã chạy runner contract và LocalRun chỉ đọc thật với upstream giả, kiểm journal và dừng scope; không phải model AI thật hoặc production runner được sửa. |
| UI/backend LangConfig | Thêm PostgreSQL 16 và pgvector, frontend và fake endpoint | UI/backend/DB từng chạy với model giả; graph prototype ở trên **không** đi qua toàn bộ HTTP backend hay `WorkflowExecutor`. |
| Model free thật | Hết budget, giữ pause | NeoMind LocalRun router completed; ba lượt LC đầu bị quota, lượt LC router được duyệt thêm bị rate limit sau dispatch. Tổng **5/5 workflow, 5/40 reservations**; chưa có review LC thật. Không capture model nền thực, không xác minh citations file/billing; xem [bàn giao LC live](../adaptive-agent-flow/session-handoff-2026-11-15-langconfig-live-router.md). |

## Điều kiện và cách ly

- Git; Node **>=22.16** cho NeoMind. LangConfig ở SHA dưới hỗ trợ Node `^20.19.0 || >=22.12.0`, npm **>=10**. Lượt trước dùng Node 22.23.5, npm 10.9.9.
- Python **3.12** (LangConfig hỗ trợ 3.11–3.13); lượt trước là 3.12.16. Wire cần binary OpenCode **2.2.7** chính xác; `opencode --version` chỉ kiểm version, không chứng minh cấu hình an toàn.
- Chỉ mức full backend cần PostgreSQL 16 + extension pgvector; lượt trước dùng 16.16 và 0.7.4. Docker **không bắt buộc**: PostgreSQL riêng tại máy đã chạy thành công. Không cần `sudo` hay thay đổi global nếu môi trường đã được chuẩn bị. Không chạy setup mặc định dựa vào Docker Compose trên máy dùng chung.
- Chọn một thư mục lab **ngoài checkout và chưa tồn tại**, trên filesystem còn quota cho user, và chỉ dùng fixture tổng hợp. Chạy các block dưới trong **một shell Bash riêng**; giữ `set -euo pipefail` để lỗi tải/kiểm checksum/khởi động dừng chuỗi lệnh. Ví dụ thay đường dẫn sau bằng thư mục thuộc quyền của bạn; không đặt secret vào đây:

```bash
set -euo pipefail
export LAB="$HOME/langconfig-lab"
mkdir -m 700 "$LAB"
mkdir -p "$LAB"/{home,tmp,cache,prefix}
export HOME="$LAB/home"
export TMPDIR="$LAB/tmp"
export XDG_CACHE_HOME="$LAB/cache"
export PIP_CACHE_DIR="$LAB/cache/pip"
export npm_config_cache="$LAB/cache/npm"
export LANG=C.UTF-8 LC_ALL=C.UTF-8
```

`mkdir "$LAB"` cố ý thất bại nếu lab đã tồn tại: chọn tên mới, không xóa hoặc ghi đè lab cũ. Không bỏ qua lỗi rồi chạy block tiếp theo. Chuẩn bị Python/Node/Postgres trong prefix riêng hoặc dùng binary đã chuẩn bị sẵn; ví dụ bên dưới dùng `$LAB/prefix/bin`. Chọn `LAB` trước khi đổi `HOME`. Các biến chỉ ảnh hưởng shell riêng đó và process con, không cần đổi cấu hình người dùng. Nếu cần tránh kế thừa credential/config, dùng `env -i` và truyền đúng biến cần thiết. OpenCode còn có thể nạp config/instructions từ ancestor và config hệ thống: HOME riêng **không chứng minh isolation**; xem [OpenCode V2 config](https://opencode.ai/docs/config) và [API](https://opencode.ai/docs/api). Không dùng service OpenCode/Postgres đang dùng chung; chọn port loopback chưa có người dùng và dừng nếu port đã bận.

`EDQUOT` có thể xảy ra ở `/tmp` dù `df` còn trống: kiểm tra **user quota** và filesystem của cả temp, cache và prefix; chuyển tất cả sang lab được phép thay vì xóa dữ liệu khác. `C.UTF-8` phải có trên máy; nếu không, chọn locale UTF-8 có sẵn.

### Cài prefix local như lượt đã thử

Lab trước dùng micromamba **2.10.0** trên Linux x86-64, tải từ upstream chính thức; không cài global. Với **lab mới**, tải và đối chiếu checksum trước khi giải nén binary:

```bash
mkdir -p "$LAB/bin"
curl --fail --location https://micro.mamba.pm/api/micromamba/linux-64/2.10.0 \
  --output "$LAB/micromamba.tar.bz2" || exit 1
printf '%s  %s\n' \
  '9a97976244929bbae28fb1fae504e74a3e7e6d1932870e3a03321f01b7fbd07b' \
  "$LAB/micromamba.tar.bz2" | sha256sum --check || exit 1
tar -xjf "$LAB/micromamba.tar.bz2" -C "$LAB" bin/micromamba
export MAMBA_ROOT_PREFIX="$LAB/mamba"
"$LAB/bin/micromamba" create -y -p "$LAB/prefix" -c conda-forge \
  python=3.12 postgresql=16 pgvector nodejs=22
export PATH="$LAB/prefix/bin:$PATH"
python --version
node --version
npm --version
```

URL phiên bản và checksum artifact đã được đối chiếu ngày 15/11; checksum không thay cho xác minh nguồn phát hành. Lệnh tạo prefix dựa trên `conda-meta/history` của lượt cài thực tế, resolve khi đó ra các version nêu trên. Nó **không phải lockfile dependency** và chưa được chạy lại từ prefix trống trong đợt đóng gói. Kiểm version thực tế sau cài; npm phải >=10. Các gói PostgreSQL/pgvector chỉ cần nếu muốn thử full backend, có thể bỏ chúng cho unit/wire. Không tạo prefix đè lên môi trường đang dùng. Dependency Python của prototype được cài theo README package bên dưới; không cần tự cài toàn bộ stack ML/audio của upstream cho phép thử giả.

## 1. Baseline NeoMind

Từ gốc checkout NeoMind, trong shell với Node phù hợp:

```bash
npm ci
TMPDIR="$LAB/tmp" npm test
```

Nếu không dùng shell lab ở trên, đặt `TMPDIR` tới thư mục riêng đã tồn tại trên filesystem đủ quota. Đây là suite riêng của NeoMind, không phải benchmark model. Lượt mặc định ngày 15/11 có 369 test: 253 đạt, 104 lỗi, 12 skip; lỗi đầu là `Disk quota exceeded` khi Git ghi worktree/index.lock dưới `/tmp/neomind-test-...`, sau đó Git init và SQLite cũng lỗi. Không sửa code/test để che lỗi môi trường. Chạy lại với `TMPDIR` ngoài `/tmp` trên filesystem lab: **369 test, 357 đạt, 0 lỗi, 12 skip**, Linux. Không chạy server hoặc model thật chỉ để kiểm tài liệu.

## 2–3. Prototype giả và wire

Chuẩn bị clone LangConfig riêng tại SHA được đánh giá; không áp prototype vào checkout NeoMind hoặc clone dữ liệu đang dùng:

```bash
git clone https://github.com/LangConfig/langconfig.git "$LAB/langconfig"
git -C "$LAB/langconfig" switch --detach eb786cf8efe0b6cc9e45d07362e66da6ec465424
git -C "$LAB/langconfig" rev-parse HEAD
```

Từ gốc checkout NeoMind, dùng [gói prototype](../../experiments/langconfig-opencode/README.md) đã lưu trong nhánh. Script chuẩn bị chỉ nhận đích mới ngoài repo; giữ clone baseline ở trên làm đối chứng:

```bash
export NEOMIND="$(pwd)"
export PYTHON="$LAB/prefix/bin/python"
"$PYTHON" -m pip install -r "$NEOMIND/experiments/langconfig-opencode/requirements-selected.txt"
"$PYTHON" "$NEOMIND/experiments/langconfig-opencode/prepare.py" \
  --source "$LAB/langconfig" --dest "$LAB/stage"
export TEST_RUN="$(mktemp -d "$LAB/pytest-run-XXXXXXXX")"
(
  cd "$LAB/stage"
  PYTHONPATH="$PWD/backend" "$PYTHON" -m pytest -q -p no:cacheprovider \
    --basetemp="$TEST_RUN/unit-tmp" tests/prototype/test_opencode_review.py
) 2>&1 | tee "$TEST_RUN/unit.log"
"$PYTHON" -m pytest -q -p no:cacheprovider \
  --basetemp="$TEST_RUN/harness-tmp" "$NEOMIND/experiments/langconfig-opencode/tests"
"$PYTHON" "$NEOMIND/experiments/langconfig-opencode/wire/run.py" \
  --stage "$LAB/stage" --work "$LAB/wire-1" \
  --python "$PYTHON" --opencode "$(command -v opencode)"
```

Giữ `set -euo pipefail` của shell lab. `--basetemp` phải là thư mục mới vì pytest có thể xóa đích đó. OpenCode 2.2.7 cần được chuẩn bị trước theo hướng dẫn phát hành chính thức; harness kiểm version và dừng nếu không khớp, không tự cài hoặc đổi bản OpenCode toàn cục. Wire cài dependency plugin đúng 2.2.7 trong work directory riêng bằng npm, kiểm config ancestor và không dùng service chung. Sau lượt replay environment cũ, đã cài lại Python dependencies từ **venv 3.12 mới, không system site-packages, cache pip riêng ban đầu trống**: cài đạt trong khoảng 887 giây, `pip check` đạt; 17 test adapter, 4 test lifecycle và wire 1 fake request đều đạt. Test harness cleanup chạy riêng, không nằm trong 17 test adapter. Chưa kiểm cold install toàn bộ UI/backend hoặc Windows.

Kỳ vọng unit lịch sử: `17 passed, 1 warning`; test dùng `DATABASE_URL` dummy để import cấu hình nhưng **không kết nối DB**. Wire lịch sử dùng model giả `fixture/fake-review#high`, source fixture tổng hợp, server OpenCode riêng và upstream IPv4 loopback giả; kết quả `needs_changes` với `Fixture fake finding`. Adapter HTTP cố ý từ chối model thật. Session permissions deny tool không phải OS sandbox. Guard giả đã thử 429/retry, compaction và ngưỡng từ chối, nhưng không phải quota guard production.

Dependency vẫn là **chọn lọc**, không phải full requirements: FastAPI 0.136.3, LangGraph 1.2.22, checkpoint-postgres 3.2.1, DeepAgents 0.6.12, langchain-openai 1.8.0. Manifest trực tiếp đã lưu trong gói; cold install ghi nhận 191 dependency, nhưng transitive vẫn không được khóa. `pip-freeze.txt` là chứng cứ cục bộ, không phải lockfile portable. Các thành phần ML/audio nặng bị bỏ khỏi yêu cầu trực tiếp, vì vậy không kết luận các tính năng đó đã được kiểm chứng. Lần cài tương lai có thể resolve transitive khác dù lượt Linux hiện tại đã thành công.

## 4. Full UI/backend: tham chiếu lượt đã chạy

Phần này **không bắt buộc** cho unit hoặc wire. Cần clone SHA ở trên, prefix chứa dependency đã chọn, cluster PostgreSQL và database **mới thuộc riêng lab**, extension `vector` đã cài, dummy password riêng và fake server. Không dùng DB đã tồn tại của người khác. Các lệnh sau là mảnh ghép của lượt đã chạy và hướng dẫn tạo cluster mới, không phải script bootstrap toàn bộ ứng dụng; chưa kiểm chứng cài mới từ đầu.

Với `$LAB/pgdata` **chưa tồn tại**, tạo cluster có user `eval`; mật khẩu sau chỉ là dummy fixture. Dừng nếu thấy dữ liệu đã có, không dùng `--reset-db`:

```bash
umask 077
printf '%s\n' 'local-eval-only-password' > "$LAB/db-password"
"$LAB/prefix/bin/initdb" -D "$LAB/pgdata" -U eval \
  --encoding=UTF8 --locale=C.UTF-8 --auth-host=scram-sha-256 \
  --auth-local=scram-sha-256 --pwfile="$LAB/db-password"
```

Encoding/locale tường minh tránh cluster mới mặc định `SQL_ASCII` như log lab cũ. Đây là cải thiện hướng dẫn, không khẳng định lab cũ đã được chuyển encoding.

Ví dụ port lịch sử: PostgreSQL `55439`, backend `8780`, UI `11425`, fake OpenAI-compatible `11439`; đều bind `127.0.0.1`. Kiểm tra port trống trước khi bắt đầu. Mã giả lịch sử hard-code một số port; nếu đổi port phải kiểm tra và điều chỉnh bản **copy trong lab**, không trỏ vào dịch vụ thật. Với cluster đã chuẩn bị trong `$LAB/pgdata`:

```bash
"$LAB/prefix/bin/pg_ctl" -D "$LAB/pgdata" -l "$LAB/postgres.log" \
  -o "-h 127.0.0.1 -p 55439 -k $LAB/tmp" start || exit 1
PG_DATA=$(PGPASSWORD=local-eval-only-password "$LAB/prefix/bin/psql" \
  -h 127.0.0.1 -p 55439 -U eval -d postgres -At \
  -v ON_ERROR_STOP=1 -c 'SHOW data_directory;') || exit 1
test "$(realpath "$PG_DATA")" = "$(realpath "$LAB/pgdata")" || exit 1
PGPASSWORD=local-eval-only-password "$LAB/prefix/bin/createdb" \
  -h 127.0.0.1 -p 55439 -U eval langconfig_eval
PGPASSWORD=local-eval-only-password "$LAB/prefix/bin/psql" \
  -h 127.0.0.1 -p 55439 -U eval -d langconfig_eval \
  -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION vector;'
```

Thiết lập kết nối DB fixture trong shell lab, chỉ dùng mật khẩu ví dụ và DB riêng đã tạo:

```bash
export DATABASE_URL='postgresql://eval:local-eval-only-password@127.0.0.1:55439/langconfig_eval'
cd "$LAB/langconfig"
"$LAB/prefix/bin/python" backend/scripts/setup.py --db-only --skip-docker --skip-playwright
```

Kiểm tra output trước khi tiếp tục. Lượt trước schema được tạo nhưng seed lỗi: script chạy file trong `backend/db/` khiến `db/types.py` che module chuẩn `types`. Nếu gặp đúng lỗi đó, sau khi xác nhận schema đã tạo, chạy các module từ thư mục backend (không chạy `--reset-db`):

```bash
cd "$LAB/langconfig/backend"
"$LAB/prefix/bin/python" -m db.init_deepagents
"$LAB/prefix/bin/python" -m db.init_custom_tools
"$LAB/prefix/bin/python" -m db.seed_langconfig_dev
```

Lượt trước báo 7 agent và 8 workflow templates; seed custom tools báo lỗi ASCII và 0 tools trong môi trường thiếu locale. Đặt `LANG` và `LC_ALL` UTF-8 như trên, rồi kiểm tra kết quả thực tế, không mặc định seed đã thành công.

Chỉ sau khi fake endpoint đã chạy riêng ở `127.0.0.1:11439`, khởi động backend từ `backend/` bằng dummy key, URL giả, locale và môi trường tách biệt:

```bash
cd "$LAB/langconfig/backend"
env -i HOME="$LAB/home" TMPDIR="$LAB/tmp" PATH="$LAB/prefix/bin:/usr/bin:/bin" \
  LANG=C.UTF-8 LC_ALL=C.UTF-8 DATABASE_URL="$DATABASE_URL" \
  OPENAI_API_KEY=dummy-local-only OPENAI_BASE_URL=http://127.0.0.1:11439/v1 \
  LITELLM_PROXY_URL=http://127.0.0.1:11439 LITELLM_API_KEY=dummy-local-only \
  "$LAB/prefix/bin/python" -m uvicorn main:app --loop asyncio --host 127.0.0.1 --port 8780
```

Trong terminal lab khác, sau khi cài frontend dependencies ở clone riêng, `npm run dev -- --host 127.0.0.1 --port 11425 --strictPort` mở UI; Vite ở SHA này proxy `/api` sang `127.0.0.1:8780`. Lượt trước dùng `npm ci --ignore-scripts --no-audit --no-fund`; bỏ lifecycle scripts có thể làm cài đặt không đầy đủ. `--loop asyncio` là workaround đã thử sau hai crash, **không** chứng minh nguyên nhân hay độ an toàn production.

Fake server lịch sử `mock_openai.py` trả câu cố định; `benchmark_mock.py` trả tool calls theo phase và dùng file fixture trong lab. Đăng ký qua API local model với **DB name `fixture`**, base URL `http://127.0.0.1:11439/v1`; runtime dùng `local-fixture`. Các script `simple_probe.py`, `langconfig_benchmark.py`, `langconfig_reuse_full.py` lịch sử phụ thuộc template/project/workflow ID và dữ liệu fixture cụ thể; đọc và điều chỉnh bản copy trước khi chạy trên DB mới. Không coi chúng là công cụ portable hay chạy lại trực tiếp lên lab cũ đã thay đổi. Không gửi prompt hoặc file thật tới fake server; không dùng bất kỳ endpoint model thật nào.

## Kiểm tra lỗi và dọn dẹp

- `ModuleNotFoundError`: kiểm tra interpreter trong prefix, `PYTHONPATH` và dependency package yêu cầu; đừng suy full requirements đã được cài chỉ từ selected list.
- Kết nối DB thất bại: kiểm tra cluster thuộc lab, `vector`, URL dummy và port; unit giả không cần khởi động PostgreSQL để sửa lỗi cấu hình import.
- UI không thấy backend: kiểm tra đúng Vite proxy/port, health backend và log riêng; đừng đổi hoặc dừng service khác. Kiểm tra fake upstream trước backend; từ chối chạy nếu không chắc endpoint trỏ đúng loopback giả.
- OpenCode sai version, port bận, guard không nạp hoặc phát hiện config/plugin/MCP ngoài dự kiến: dừng wire; không chuyển sang service chung hoặc bỏ guard để chạy tiếp. Không gửi credential vào log.
- Chỉ dừng process mình đã khởi động, ví dụ Ctrl+C ở terminal tương ứng. Với cluster **đã xác nhận thuộc lab**, dùng `"$LAB/prefix/bin/pg_ctl" -D "$LAB/pgdata" stop`; không dừng system service. Giữ nguyên dữ liệu lab để kiểm tra, không tự xóa cluster, cache, log hay fixture của người khác.
- Log/evidence cục bộ chỉ là tạm thời, có thể chứa prompt, đường dẫn hoặc dữ liệu nhạy cảm. Không commit raw log, `.env`, credential, database hay artifact chưa được rà soát.

## Gate trước model thật

Overlay ban đầu vẫn khóa fake, không gỡ khóa chỉ vì wire đã qua. Harness riêng ở [live/README](../../experiments/langconfig-opencode/live/README.md) đã kiểm guard SQLite nhiều process và retry thực với upstream giả, rồi thử một workflow DeepSeek Free: **`Free usage limit reached`**. Worker đã dừng; không retry hoặc đổi model. Không có lệnh live trong tài liệu setup này.

Giữ `LIVE_PAUSED`, DB quota gốc và owner anchor ngoài checkout; không sao chép/tạo mới DB để chạy tiếp. Catalog giá 0 không xác nhận billing, auth hoặc khả dụng inference. Tổng đã dùng: **1 workflow thử / 1 reservation**, trong trần 4 workflow/40 physical requests. Reservation chỉ là cận trên request, không phải bằng chứng độc lập số POST tới dịch vụ. Để tiếp tục cần chủ tài khoản xử lý giới hạn qua giao diện OpenCode chính thức (`/connect` hoặc lệnh auth được bản cài hỗ trợ); không gửi key/token vào chat và không tự đăng ký gói trả phí. Không cam kết đăng nhập sẽ giải quyết được quota, vì lỗi hiện tại không xác định riêng trạng thái auth.

Trước production vẫn cần đối chứng guard unload/config, WebSocket thật, isolation và hợp đồng quyền theo use case; không coi permissions là OS sandbox. Phần NeoMind hiện là factory thử nghiệm, không thay guard của production runner; LocalRun/model thật chưa được xác nhận hoàn tất.
