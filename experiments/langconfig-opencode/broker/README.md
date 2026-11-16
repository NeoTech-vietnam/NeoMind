# Broker fixture độc lập

Prototype Python → Node qua stdio thuộc process cha, dùng `RunnerRegistry` thật với ba factory giả `codex`, `claude-code`, `opencode`. Không gọi model, CLI agent, workspace hay factory production. Trường binding cố định `fixture` / `fake-readonly` / `high`; chỉ nhận `access: read`. Không có fallback hoặc retry tự động. Module registry lấy từ `dist`; cần build nếu chưa có hoặc không khớp source.

Mỗi cặp `taskId` / `idempotencyKey` được giữ trong bộ nhớ của một process: request giống nhau dùng chung kết quả, payload khác trả conflict; lỗi dispatch cũng được giữ. Restart làm mất toàn bộ trạng thái: không dùng để đảm bảo idempotency bền, recovery, chống replay hoặc side effect. Stdio không chứng minh xác thực hay sandbox. Không có approval, grant, journal, timeout, dừng process được xác minh, schema output, giới hạn tài nguyên đầy đủ hoặc tích hợp LangConfig/LocalRun. Không dùng cho production.

Chạy test từ gốc repo:

```sh
node --test experiments/langconfig-opencode/broker/broker.test.mjs
node --test experiments/langconfig-opencode/broker/fixture-registry.test.mjs
python3 -m unittest discover -s experiments/langconfig-opencode/broker -p 'test_client.py'
```

## Graph LangConfig thật, broker giả

`test_langconfig_graph.py` dùng `SimpleWorkflowExecutor`, graph builder và tool node của stage LangConfig đã áp overlay; tool fixture do test cài trực tiếp, gọi client stdio và Node broker giả. Mỗi runner có một ca thành công và ba ca từ chối: tham số node thừa, binding không phải fixture, broker đã đóng. Các ca lỗi kiểm `FAILED` và node kế tiếp không chạy. Task ID, binding và prompt được cố định trong test, không lấy quyền hay đường dẫn từ node; đây không phải kiểm chứng cấp quyền task thực tế.

Ví dụ trên Linux, từ gốc NeoMind, với stage đã chuẩn bị và Python đã cài dependency chọn lọc của LangConfig (không tự cài hoặc thay đổi stage):

```sh
NEOMIND="$PWD"
STAGE=/dev/shm/neomind-langconfig-approved-20261115-01
PYTHON=/home/hieu-tran/.local/share/langconfig-eval-20261114/env/bin/python
env -i PATH=/usr/bin:/bin HOME=/dev/null LANG=C.UTF-8 PYTHONDONTWRITEBYTECODE=1 \
  DATABASE_URL=postgresql://fixture:fixture@127.0.0.1:1/fixture \
  PYTHONPATH="$STAGE/backend:$NEOMIND/experiments/langconfig-opencode/broker" \
  "$PYTHON" -m pytest -q -p no:cacheprovider \
  "$NEOMIND/experiments/langconfig-opencode/broker/test_langconfig_graph.py"
```

Đường dẫn Python là ví dụ của máy thử, cần thay bằng môi trường phù hợp. Stage đã thử ở upstream `eb786cf8efe0b6cc9e45d07362e66da6ec465424` với overlay hiện có; stage `/dev/shm` không bền qua reboot. Test dùng DB, event bus, callback và checkpointer trong process giả hoặc bộ nhớ; bỏ qua validation tool của executor, không thử HTTP/API, PostgreSQL, approval, recovery hay cô lập OS. Không suy ra bảo đảm production từ kết quả này.

## Spike registry NeoMind

`registry-spike.test.mjs` là test độc lập ban đầu. Broker stdio hiện dùng module `fixture-registry.mjs` riêng, import `RunnerRegistry`, `verifiedSession` và `assertSessionBound` thật từ `dist` với ba factory giả; graph ở trên đi qua module này. Scope, session, model và mọi kết quả đều giả trong bộ nhớ. Không dùng registry mặc định, runner thật, CLI agent hay model. Test kiểm mapping, session/binding, no-delegation giả, thứ tự và lỗi stop; stop proof chỉ là trạng thái do fake báo, không kiểm OS process. Đây không phải admission, journal, capability probe hay `LocalRun` production.

Chạy từ gốc repo, sau `npm run build` nếu `dist` chưa có hoặc không khớp source:

```sh
node --test experiments/langconfig-opencode/broker/registry-spike.test.mjs
```

## Tạo Git fixture tổng hợp mới

Các test LocalRun cần một Git repository tổng hợp có baseline commit. Tạo mới ở
filesystem còn chỗ; thư mục cha phải tồn tại và đích chưa được tồn tại:

```sh
export SYNTHETIC_BASE_REPO=/dev/shm/neomind-synthetic-fixture-new
python3 experiments/langconfig-opencode/broker/create_fixture.py --dest "$SYNTHETIC_BASE_REPO"
```

Helper từ chối ghi vào thư mục đã có; chỉ tạo commit trong repository fixture
mới, không sửa hoặc commit checkout NeoMind. Không tự xóa thư mục khi lỗi. Các
đường dẫn `/dev/shm` không bền qua reboot; chọn đích khác nếu đã tồn tại.

## LocalRun thật với runner giả

`localrun-fixture.test.mjs` dùng `LocalRun`, `RunnerRegistry`, journal và workspace coordinator thật cùng ba `FakeRunner`/scope trong bộ nhớ. Với mỗi runner ID: test thành công xác minh binding, đọc journal ngay trong `startTurn` để kiểm intent và scope đã ghi trước dispatch, rồi kiểm thứ tự receipt `accepted` và kết thúc sau khi fake báo stop. Các ca binding/delegation sai bị chặn trước intent; dispatch ném lỗi có receipt `unknown` và không retry; fake stop không xác nhận thì run bị chặn, không ghi attempt hoàn thành. Không có bằng chứng dừng OS process hay runner production.

Test cần `dist` đã build và một repo Git fixture tổng hợp **đã có sẵn**: test kiểm chính xác ba file ở HEAD, clone vào thư mục tạm riêng, không tạo commit hoặc thay đổi repo nguồn. Ví dụ trên máy thử, chạy từ gốc NeoMind:

```sh
env -i PATH=/usr/bin:/bin HOME=/dev/null LANG=C.UTF-8 TMPDIR=/dev/shm \
  GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 GIT_ALLOW_PROTOCOL=file \
  SYNTHETIC_BASE_REPO="$SYNTHETIC_BASE_REPO" \
  node --test experiments/langconfig-opencode/broker/localrun-fixture.test.mjs
```

Đường dẫn fixture cần thay theo máy; dữ liệu ngoài repo không được đảm bảo còn tồn tại. Lượt Linux gần nhất: **15/15 đạt**. Scope không chạy process và `stopVerified` chỉ là kết quả giả. Không kiểm production runner, approval, writer hay recovery.

## Graph → host grant cố định → LocalRun fixture

`test_langconfig_localrun.py` kiểm executor/graph LangConfig thật → tool cài bởi test → `DurableLocalRunFixtureClient` → SQLite admission → `LocalRunFixtureClient` → stdio host `localrun-host.mjs` → LocalRun/journal thật → ba factory fake. Wrapper và host tạo grant fixture từ runner do **test khởi tạo**, với task và binding cố định; node không chọn workspace hoặc cấp quyền. Host giới hạn prompt fixture cố định. Sai task, runner/provider/model hoặc input thừa bị từ chối; lỗi tool làm graph dừng trước node sau. Lệnh hợp lệ chạy research read-only qua lifecycle LocalRun, kiểm intent/scope đã ghi ngay trong `startTurn`, receipt accepted và stop giả; kết quả hợp lệ được lưu bền trong DB fixture để trả lại sau restart wrapper.

```sh
NEOMIND="$PWD"
STAGE=/dev/shm/neomind-langconfig-approved-20261115-01
PYTHON=/home/hieu-tran/.local/share/langconfig-eval-20261114/env/bin/python
env -i PATH=/usr/bin:/bin HOME=/dev/null LANG=C.UTF-8 TMPDIR=/dev/shm PYTHONDONTWRITEBYTECODE=1 \
  DATABASE_URL=postgresql://fixture:fixture@127.0.0.1:1/fixture \
  SYNTHETIC_BASE_REPO="$SYNTHETIC_BASE_REPO" \
  PYTHONPATH="$STAGE/backend:$NEOMIND/experiments/langconfig-opencode/broker" \
  "$PYTHON" -m pytest -q -p no:cacheprovider \
  "$NEOMIND/experiments/langconfig-opencode/broker/test_langconfig_localrun.py"
```

Đây là đường fixture riêng, không thay thế broker `server.mjs`. Grant cố định không phải xác thực hay authority production; test tự cài tool, DB/event bus giả và bỏ qua validation tool của LangConfig. Flow research này không có bước approval: không chứng minh approval, writer, recovery, idempotency bền hay OS stop. Host cần stage và repo fixture ngoài checkout như trên, có thể không còn sau reboot. Không dùng model/runner thật.

## Admission SQLite fixture độc lập

`durable_admission.py` là store fixture; `durable_localrun_client.py` nối store vào đường graph → host ở trên. Wrapper giữ task/attempt cố định, ghi reservation trước khi gửi tới Node và chỉ lưu kết quả sau khi host xác nhận lifecycle fixture. `FixtureGrant` do mã test tin cậy tạo trong process; request không thể cung cấp grant. SQLite ghi reservation `taskId`/`attemptId`, hash payload chuẩn hóa và owner token trong transaction `BEGIN IMMEDIATE` trước khi trả `admitted`. Cùng key và payload khi còn reserved trả `unknown`, payload khác trả `conflict`; chỉ owner token cùng hash được ghi kết quả fixture. Sau restart, completed được đọc lại, reserved vẫn `unknown` và không được cấp dispatch lại. Store không tự reconcile kết quả bên ngoài hay chứng minh exactly-once side effect; SQLite và journal LocalRun không thuộc cùng transaction.

Test multi-process có tranh chấp cùng/khác payload và crash sau fake dispatch trước khi hoàn tất. Chạy từ gốc repo:

```sh
env -i PATH=/usr/bin:/bin HOME=/dev/null LANG=C.UTF-8 TMPDIR=/dev/shm PYTHONDONTWRITEBYTECODE=1 \
  python3 -m unittest discover -s experiments/langconfig-opencode/broker -p 'test_durable_admission.py' -v
```

SQLite WAL/FULL và owner token là thí nghiệm local; chưa kiểm power loss, filesystem khác, chống sửa DB, xác thực host, multi-host, thu hồi grant, timeout hay quản lý secret. Không phải approval, sandbox hoặc bằng chứng OS isolation; không dùng production.

`test_durable_localrun.py` dùng hook chỉ test cấu hình để ghi counter ngoài sau khi journal intent/scope được ghi và giữ fake turn. Một process khác kiểm duplicate `unknown` khi đang chạy; test giết owner và host, khởi tạo wrapper lại hai lần, kiểm `unknown`/`conflict` và counter vẫn một dispatch cho từng runner. Hook không thể được node cấu hình. Chạy với cùng `SYNTHETIC_BASE_REPO` như ví dụ graph:

```sh
env -i PATH=/usr/bin:/bin HOME=/dev/null LANG=C.UTF-8 TMPDIR=/dev/shm PYTHONDONTWRITEBYTECODE=1 \
  SYNTHETIC_BASE_REPO="$SYNTHETIC_BASE_REPO" \
  python3 -m unittest discover -s experiments/langconfig-opencode/broker -p 'test_durable_localrun.py' -v
```
