# Thử nghiệm guard OpenCode — chưa sẵn sàng dùng production

Đây là harness riêng, không thay đổi production runner hoặc khóa fake của overlay LangConfig. Không tạo lại hay sao chép DB quota live. `LIVE_PAUSED` là khóa sau lỗi quota thật; không chạy lại khi chưa xử lý nguyên nhân và thống nhất với người sở hữu lượt chạy.

Trong các đường dẫn dưới đây, `E` là `/home/hieu-tran/.local/share/langconfig-eval-20261114` trên máy đã chạy thử.

## Bằng chứng 15/11/2026

- Một workflow LC live đã thử đúng `opencode/deepseek-v4.1-flash-free#high`. Guard ghi một reservation trước dispatch, sau đó OpenCode báo **Free usage limit reached**; retry bị veto. Không có review thật. Systemd scope `neomind-run-aaad8eae-67e8-4cc0-a0a2-a7729909be41.scope` được xác nhận dừng. Bằng chứng trong `E/live-guard-20261115/live-lc.log` và `runs/live-lc-x5t6_26z/worker/trace.jsonl`; lỗi trong log server riêng của run đó. Một reservation là **cận trên 1 physical request**, không phải bằng chứng độc lập cho số POST phía server. Không fallback.
- DB budget gốc là `E/live-guard-20261115/live-budget.sqlite`, đã có **1 workflow, 1 reservation**. Không reset hay tạo DB khác để thử tiếp; tổng phê duyệt vẫn tối đa 4 workflow, 40 physical request. Không có token, tài khoản hay billing nào được sao chép hoặc sửa.
- Fake suite dùng network namespace chỉ có loopback, OpenCode server 2.2.7 riêng, fake upstream và DB quota riêng. 429 cho phép một retry: 2 POST và 2 reservation. Với retry veto: 1 POST. Có bằng chứng title static, compact, generate deny, model/variant không đúng không tới upstream, quota đầy, DB mất, interrupt, disconnect receipt và thiếu plugin. Ép WebSocket trên fake route **rơi về HTTP được guard**; chưa trực tiếp chạy được WebSocket deny hook.
- `test_runner.mjs` nối `RunnerRegistry` NeoMind → experimental factory → worker có systemd scope → OpenCode thật → fake upstream. Output là `TurnResult` từ model giả và kiểm schema; stop scope được xác nhận; `sandboxVerified: false`. Đây không phải `LocalRun` đầy đủ và không phải production runner.
- `test_local_run.mjs` chạy LocalRun read-only hoàn chỉnh từ flow Research rút gọn, kiểm journal intent/receipt/output và phase `completed`, một attempt, 1 fake POST/1 reservation; kiểm unit inactive và cgroup rỗng sau run. Parent đã replay trên fixture mới sau sửa guard. Output `Synthetic fake review` là kịch bản giả, không phải review AI thật; không có request live trong test này.
- Private server có XDG/HOME riêng, chỉ plugin guard local, MCP rỗng, catalog chỉ model được chọn, và hook chỉ chấp nhận hai instruction source built-in rồi thay toàn bộ system text bằng hướng dẫn fixture. Permissions là deny model tools, **không phải OS sandbox**. Namespace của fake suite chặn network ngoài, không tương đương sandbox file.

## Chạy lại fake, không inference thật

Linux cần `unshare -Urn`, `ip`, user systemd, Python 3, Node >=22.16, OpenCode 2.2.7, và NeoMind đã build. Chọn thư mục dữ liệu riêng **đã tồn tại**, đường dẫn tuyệt đối ngoài checkout; không đặt trùng state người dùng. Các lệnh dưới đây chạy từ `experiments/langconfig-opencode/live/`:

```sh
export LIVE_GUARD_DATA=/absolute/path/to/private-experiment-data
export OPENCODE_BIN=/absolute/path/to/opencode
export NEOMIND_ROOT=/absolute/path/to/NeoMind
mkdir -p "$LIVE_GUARD_DATA/tmp"
sh run-fake.sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -v test_quota
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -v test_runtime_paths
node test_runtime_paths.mjs
node test_scoped_run.mjs
node test_runner.mjs
```

Để chạy full LocalRun bằng fixture mới, vẫn đứng tại thư mục `live/` và dùng
environment ở trên. `prepare_fixture.py` từ chối đích đã có; nó chỉ tạo một
commit baseline trong **repo fixture mới**, không commit/sửa checkout NeoMind,
không cần Git identity toàn cục hoặc network:

```sh
export LOCALRUN_LAB_BASE="$LIVE_GUARD_DATA"
export SYNTHETIC_BASE_REPO="$LIVE_GUARD_DATA/source-fixture"
python3 prepare_fixture.py --dest "$SYNTHETIC_BASE_REPO"
node test_local_run.mjs
```

Kết quả parent ngày 15/11: 7 test Python quota/path/anchor đạt; test Node path và
signal cleanup đạt; fake acceptance, runner contract và full LocalRun đều đạt.
Các fake DB không dùng hoặc sửa DB quota live gốc. Script LocalRun đòi baseline
đúng ba file tổng hợp, từ chối repo dữ liệu thật; không kiểm writer/approval/commit
kết quả và không phải production runner đã tích hợp guard.

Mỗi lệnh fake tạo run directory mới dưới `LIVE_GUARD_DATA/runs`; không dùng DB live. `auth_probe.py` là kiểm catalog signed-out, không gửi prompt; catalog khả dụng không chứng minh inference hay auth thành công.

## Giới hạn và bước tiếp

`runner.mjs` hiện chỉ chấp nhận model `fixture/fake-review#high`, read-only và từ chối resume/write/web. `live_lc.py` dùng adapter overlay đã cài với transport thử nghiệm riêng; không sửa overlay. Script live yêu cầu backend và Python LangConfig được chỉ định, shared DB đã tồn tại, opt-in và không có `LIVE_PAUSED`; không tự tạo budget mới. Giá trị opt-in công khai không chứng minh người dùng đã đồng ý: cần đồng thuận rõ ràng cho từng lượt. Chỉ chủ lượt chạy mới chủ động gỡ **cả hai** pause sau khi quota được xử lý chính thức; không tự động gỡ.

Để ngăn nhầm DB, chủ sở hữu chuẩn bị riêng `$LIVE_GUARD_DATA/live-budget.anchor.json`, từ DB gốc hiện có, không ghi hay sao chép DB. Anchor có `schemaVersion: 1`, `database` là đường dẫn tuyệt đối canonical, `device` và `inode` là số từ `stat`, `minimumWorkflows`, `minimumReservations` ít nhất 1, và `requiredReservationIds` là mảng ID reservation gốc. Runtime chỉ đọc anchor và DB, kiểm tra identity, lịch sử tối thiểu, reservation và cap 40/4 trước khi tạo workflow attempt mới; metadata UUID lưu dưới `live-attempts/`. Attempt lỗi vẫn có thể tiêu thụ một slot; không hỗ trợ resume. Anchor chỉ giảm nhầm lẫn, **không chống người vận hành cố ý sửa** anchor/DB. Không tạo anchor hay DB mới để chạy lại lượt đã dùng budget.

Có khả năng plugin bị unload giữa preflight và dispatch; thử nghiệm chưa chứng minh đó là ranh giới an toàn production. Chưa có live NeoMind LocalRun hoặc verdict LC thật; dừng vì quota upstream, không tuyên bố auth hoạt động hay không hoạt động. OpenCode V2 lưu account trong SQLite cùng server state; không dùng shared dataHome khi chưa xác minh cách tránh thay đổi state chung. Cách kết nối chính thức là `/connect` hoặc `opencode auth login` trong context do chủ tài khoản kiểm soát, không đưa token vào chat.

Nguồn API: OpenCode 2.2.7 `@opencode/plugin` Promise `session.d.ts`, `registration.d.ts`, `model.d.ts`; `@opencode/schema` `model.d.ts`; tài liệu V2 `/build/plugins/server/`, `/config/`, `/cli/providers/`. Guard và fixture được viết mới dựa trên thí nghiệm wire trước; LC adapter được import từ bản prototype đã đóng gói, không sao chép credential hay thay file overlay.
