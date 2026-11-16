# Prototype approval độc lập

Chỉ dùng thư viện chuẩn Python và SQLite local. Chạy từ gốc NeoMind:

```sh
python3 -m unittest discover -s experiments/langconfig-opencode/approval -p 'test_prototype.py' -v
```

`decide` ghi quyết định, receipt và job trong cùng transaction; request lặp cùng key và nội dung trả receipt cũ. Worker claim job có lease và epoch; hoàn thành chỉ thành công nếu còn đúng owner, epoch và lease. Test bao gồm tranh chấp, idempotency, stale, reject, tiến trình chết trước commit và takeover sau lease.

**Không phải production:** không kết nối LangGraph, checkpoint thật, HTTP, authentication hay authorization. Checkpoint là chuỗi fixture do caller cung cấp, chưa xác minh với saver. SQLite `BEGIN IMMEDIATE` tuần tự hóa writer, không chứng minh hành vi PostgreSQL hay transaction với PostgreSQL checkpointer. Đồng hồ worker do process cung cấp; lease không fence checkpoint hay side effect bên ngoài. Không thực thi side effect và không bảo đảm exactly once: crash sau effect trước `finish` có thể dẫn đến effect lặp. Không có heartbeat, durable audit đầy đủ, migration, kiểm soát truy cập hoặc reconciliation checkpoint; không dùng prototype này để cấp quyền production.

## PostgreSQL prototype disposable

`postgres_prototype.py` là adapter riêng dùng psycopg; `test_postgres.py` khởi tạo cluster riêng trong `/dev/shm`, Unix socket riêng, không lắng nghe TCP; chỉ dừng và dọn cluster do test tạo. Test dùng binary `initdb`/`pg_ctl` tại đường dẫn cố định trong file test và Python có psycopg:

```sh
PYTHONDONTWRITEBYTECODE=1 /home/hieu-tran/.local/share/langconfig-eval-20261114/install-check-20261115/venv/bin/python -m unittest discover -s experiments/langconfig-opencode/approval -p 'test_*.py' -v
```

Test adapter kiểm tra cạnh tranh giữa process, outbox atomic, crash trước/sau commit và claim/lease/fence ở mức DB. Trust auth chỉ dùng cho cluster/socket fixture riêng. Test này không chứng minh side effect, integration, checkpoint, reconciliation hoặc kiểm soát truy cập. Không triển khai production dựa vào prototype.

## LangGraph PostgreSQL saver fixture

`test_langgraph_postgres.py` chạy graph giả với `PostgresSaver` thật trên một cluster disposable mới khác; process tạo pause thoát, process khác nạp checkpoint và resume sau khi đối chiếu receipt với thread, checkpoint ID, interrupt ID và task. Test cả thiếu receipt sau crash, sai identity, và crash sau resume trước khi hoàn tất job. Chạy riêng:

```sh
PYTHONDONTWRITEBYTECODE=1 /home/hieu-tran/.local/share/langconfig-eval-20261114/install-check-20261115/venv/bin/python -m unittest discover -s experiments/langconfig-opencode/approval -p 'test_langgraph_postgres.py' -v
```

Saver và DB ứng dụng ghi độc lập, **không atomic chung**. Fixture giữ PostgreSQL session advisory lock theo thread trong lúc kiểm receipt/checkpoint và resume; kiểm owner, epoch và lease của job tại admission. Test hai process hợp tác tranh lock, counter giả, process giữ lock chết và admission sai lease/epoch.

Lock chỉ có hiệu lực với worker hợp tác, không ngăn mã bỏ qua lock hoặc thay đổi checkpoint bên ngoài. Mất session DB giải phóng lock trong khi graph hoặc process OS vẫn có thể chạy; lease cũng có thể hết hạn sau admission. Không fence process OS, checkpoint saver hay side effect; không chứng minh split-brain, exactly once hoặc an toàn khi mất kết nối. Chưa có auth, journal/reconciliation tự động hay production integration; job còn running sau crash cần xử lý riêng. Graph fixture không dùng model hay broker; không mở live dựa vào kết quả này.

## PostgreSQL fenced sink fixture

`fenced_sink_fixture.py` độc lập với LangGraph saver. Trong cùng PostgreSQL transaction, sink khóa hàng job, kiểm owner/epoch/lease, và ghi effect giả cùng receipt theo key và SHA-256; retry đúng payload trả cùng receipt, payload khác bị từ chối. Khóa hàng tuần tự hóa effect với takeover hợp tác. Lease được kiểm khi lấy hàng, không khẳng định còn hiệu lực tại thời điểm commit nếu transaction kéo dài.

`test_fenced_sink.py` dùng cluster disposable mới; kiểm duplicate đồng thời giữa process, worker cũ sau takeover, và crash trước/sau commit effect. Đây chỉ là effect giả nằm trong DB transaction; không fence filesystem, network, process OS hay sink khác; không có transaction chung với LangGraph checkpoint và không chứng minh exactly once tổng quát hoặc production readiness.

## Authority thống nhất fixture

`unified_fixture.py` thử nối quyết định, receipt, job và sink giả cùng authority PostgreSQL; graph dùng `PostgresSaver` trên connection riêng và advisory lock hợp tác. `test_unified_fixture.py` kiểm revoke trước và sau admission, receipt sink lặp, hai process tranh resume, checkpoint/owner/epoch sai, crash trước/sau effect và trạng thái `unknown` không tự replay. Principal chỉ do test host dựng; đây không phải xác thực hay authority production.

Transaction saver và authority tách biệt; sau crash `reconcile` chỉ quan sát hai store và có thể trả `unknown`, không chứng minh atomicity hoặc exactly once. Advisory lock không chặn worker không hợp tác hoặc OS worker vẫn chạy sau khi DB session mất; sink giả chỉ fence transaction PostgreSQL của nó, không fence file/network. Lượt đầu test crash thất bại vì harness làm mất tham chiếu semaphore trước khi process con khởi tạo; giữ tham chiếu và chạy lại **6 test đạt** trên Linux với cluster disposable, không nới điều kiện.

Ngày 16/11, test cố ý kết thúc PostgreSQL session giữ advisory lock ngay sau admission trong khi worker fixture chờ: worker tiếp tục chạy và ghi một effect giả trước khi báo lỗi mất session. `test_unified_fixture.py` **7 test đạt**. Đây là bằng chứng đối chứng rằng mất lock không dừng worker; không dùng advisory lock làm stop proof hoặc căn cứ mở writer production.

Biến thể `bind_sink=True` thử thực hiện effect PostgreSQL trên cùng connection giữ advisory lock. Test đối chứng cắt session sau admission: effect DB không commit, reconciliation trả `unknown`, không tự resume lại; các ca thành công và revoke sau admission cũng được kiểm. `test_unified_fixture.py` **10 test đạt**. Điều này chỉ áp dụng cho sink DB hợp tác sử dụng cùng connection; worker vẫn có thể chạy và LangGraph saver vẫn connection riêng. Không dùng làm fencing filesystem/network, OS stop proof hay chứng minh exactly once.

Test tiếp theo cắt connection sau insert nhưng trước commit: effect DB rollback, reconciliation trả `unknown`; unified fixture **11 test đạt**. Suite approval đầy đủ 49 test trước test bổ sung này; chưa suy diễn sang mất nguồn hay sink khác.

Sau đó `resume` mặc định dùng sink cùng connection; đường connection tách riêng chỉ giữ làm đối chứng test (`bind_sink=False`). Chạy lại unified fixture **11 test đạt**. Đây vẫn không phải cổng production hay cơ chế dừng worker.

Completion receipt fixture gắn effect, thread và checkpoint ID; checkpoint thay sau khi hoàn tất hoặc crash sau checkpoint trước receipt đều làm reconciliation trả `unknown`, không tự replay. Unified fixture **12 test đạt**; đây vẫn là các transaction tách biệt và không xác thực DB chống giả mạo.

`worker-stop.test.mjs` dùng worker tổng hợp trong user-systemd scope thật (Linux), mô phỏng mất authority rồi yêu cầu `scope.stop()` và xác nhận scope không active. Chạy `TMPDIR=/dev/shm node --test experiments/langconfig-opencode/approval/worker-stop.test.mjs` sau `npm run build`: **1 test đạt**. Chưa nối DB/graph; không chứng minh phát hiện mất session hay ngăn effect trước stop.

`test_watchdog_scope.py` kết thúc một PostgreSQL session giữ advisory lock thật trong cluster disposable; test host nhận lỗi khi đọc session đó rồi **tự chuyển tiếp** thông báo qua stdin tới supervisor fixture. Supervisor xác nhận worker systemd scope còn active trước yêu cầu dừng và `scope.stop()` trả xác nhận dừng; **1 test đạt** trên Linux. Lượt đầu test báo timeout do harness để stdin mở sau thông báo; đóng stdin rồi chạy lại đạt. Đây không phải cơ chế theo dõi production: không test tự phát hiện mất session khi không có host chuyển tiếp, graph/writer, hoặc ngăn side effect trước stop. Không coi DB lock là stop proof.

Monitor riêng của `auto-watchdog-fixture.mjs` gửi heartbeat sau truy vấn PostgreSQL; supervisor dừng scope khi monitor báo mất session, thoát bất ngờ hoặc không gửi heartbeat trong 2 giây. Trên Linux, bốn ca relay, mất session tự phát hiện, monitor crash và monitor treo đều đạt; toàn bộ Python approval suite sau thay đổi **55 test đạt**. Ca crash đầu lỗi vì Python thiếu `os.pidfd_open`; harness sau đó để supervisor gửi tín hiệu cho process con của chính nó. Đây chỉ là fixture: chưa nối graph hay writer thực, chưa kiểm supervisor chết, split-brain toàn diện hoặc effect xảy ra trước khi dừng.

`localrun_bridge_fixture.py` thử binding task và hash request vào authority/receipt/job giả và checkpoint `PostgresSaver`, rồi gọi durable admission SQLite fixture → `LocalRun` thật với runner giả chỉ đọc. Linux: **4 test đạt**, gồm ba runner, request sai, revoke, checkpoint thật bị thay và mất kết quả sau dispatch; trường hợp chưa chắc trả `unknown`, không dispatch lại. Suite approval sau bổ sung: **59 test đạt**. Effect DB trong unified fixture là synthetic marker, không phải receipt của `LocalRun`; principal, grant, approval và stop proof runner là giả. Callback có khoảng hở sau kiểm authority, các store/journal không chung transaction, chưa test writer, quarantine, watchdog hoặc crash thật trên đường ghép này; không dùng làm authority production hay coi `observed_complete` là chứng cứ production.

Sau đó thêm `writer-bridge-fixture.mjs`: authority/checkpoint fixture gọi `RunService` và `CodexWriteDispatch` thật (các thành phần được `LocalRun` dùng), với approval được ghi vào journal, workspace lease và fake runner/scope. Stop giả trả false: journal giữ attempt unresolved, SQLite coordinator giữ quarantine, request lặp và client tạo lại không dispatch thêm; kết quả bridge `unknown`. Suite approval Python **60 test đạt** trên Linux. Đây chưa phải toàn bộ vòng đời writer của `LocalRun`: approval fixture PostgreSQL và approval journal được tạo độc lập, chưa ràng buộc hash plan/approval, lease/fence, baseline hoặc journal identity giữa hai phía; request fixture chỉ được trusted test host ánh xạ tới writer. Fake scope không chứng minh OS worker dừng, không test watchdog, crash thật hay fencing. Không dùng kết quả để mở production.

Chế độ `--bound` của writer fixture dựng evidence từ core: run/attempt, hash plan và approval journal, workspace canonical, fence, baseline và hash journal. Trusted test host đưa evidence vào request được hash trong authority cùng task/checkpoint; writer fixture kiểm lại evidence và lease trước dispatch. Test kiểm fence request sai, baseline thay, revoke trước dispatch, stop không xác nhận và host `process.exit(73)` trong `startTurn`; mọi outcome chưa chắc giữ `unknown`, không dispatch lại. Suite approval Python **61 test đạt** trên Linux. Với crash, intent/workspace/scope đã ghi trong journal và lease còn trong DB nhưng `quarantined=0`: fixture không chạy recovery sau crash, không chứng minh workspace được quarantine hay tái cấp an toàn. Evidence và approval fixture vẫn do trusted harness tạo, chưa liên kết thực với authority production, journal completion hoặc toàn bộ `LocalRun`; kiểm tra lại cũng không loại race sau check, watchdog chưa được nối. Không dùng làm OS stop proof hay mở writer production.

`test_localrun_crash_recovery.py` kiểm riêng **LocalRun thật**: scheduler process chết trong writer `startTurn`, runner/scope và approval đều tổng hợp, không gọi model. Sau khi xác nhận scheduler chết, process mới dùng `LocalRun.recover` hai lần; identity scope giả không được xác nhận dừng, run `blocked`, attempt unresolved, lease cũ được giữ nguyên, coordinator từ chối owner khác và release không có stop proof, `resume` không dispatch lại. Linux: **1 test đạt**, toàn suite approval Python **62 test đạt**. Lượt đầu lỗi trước dispatch do process con thiếu `TMPDIR` và `/tmp` hết quota; đặt `TMPDIR` trong fixture rồi chạy lại. Đây không phải crash trên bridge authority/checkpoint hay worker OS còn sống; chưa chứng minh cờ quarantine được đặt, fencing side effect hoặc watchdog production.

Test `test_authority_localrun_crash_with_live_systemd_worker` nối authority/checkpoint fixture qua trusted callback tới `LocalRun` writer thật với fake runner và worker Node tổng hợp trong systemd scope thật. Scheduler chết sau dispatch, test xác nhận scope vẫn active; recovery không tìm thấy `systemctl` trả `blocked`, giữ attempt/lease và từ chối cấp workspace cho owner khác. Sau đó recovery với `systemctl` dừng scope xác nhận, chuyển `recovering` và không tự chạy lại; authority vẫn `unknown`, duplicate không dispatch. Linux: test đạt, toàn bộ approval suite **63 test đạt**. Lượt đầu harness che stderr và chưa tạo scope; sau khi hiện lỗi, phát hiện scope phải active trước admission, sửa thời điểm khởi động rồi chạy lại. PostgreSQL authority, approval NeoMind và journal vẫn chưa ràng buộc transaction hoặc identity end-to-end; test không nối watchdog, không kiểm revoke trong lúc chạy hoặc side effect trước stop, không chứng minh OS sandbox hay production readiness.

Bridge fixture nay kiểm lại authority/job đã dispatch và checkpoint ngay trước callback. Revoke hoặc thay checkpoint sau synthetic marker nhưng trước kiểm tra làm outcome `unknown` và callback không được gọi. Test đối chứng cố ý revoke **sau** lần kiểm này vẫn quan sát một dispatch `LocalRun` giả chỉ đọc; completion trả `unknown`, không replay. Đây là bằng chứng race check-to-dispatch vẫn tồn tại, không phải fencing hay cách ngăn revoke sau khi worker bắt đầu. Linux: **10 test bridge đạt** sau khi thêm assertion callback không được gọi; toàn suite approval **66 test đạt** trước khi bổ sung assertion đó. Watchdog chưa được nối và writer production vẫn đóng.

`revoke-watchdog-fixture.mjs` và `revoke-monitor-fixture.py` thử giám sát policy PostgreSQL fixture trong khi writer `LocalRun` chạy fake runner và worker Node tổng hợp trong systemd scope thật. Test host khởi động watchdog trỏ đúng scope của run rồi revoke policy: watchdog tự phát hiện. Khi không gọi được systemctl, `stopVerified=false`, scope vẫn active và coordinator từ chối cấp lease khác; test host sau đó giết scheduler và recovery vẫn `blocked`. Watchdog thứ hai xác nhận dừng scope, `LocalRun.recover` chuyển `recovering`, authority vẫn `unknown` và duplicate không dispatch lại. Linux: **67 test approval đạt**. Monitor/supervisor/authority đều fixture, scheduler được test chủ động giết chứ không do watchdog điều phối; không kiểm OS side effect trước stop, race mọi sink, supervisor chết hoặc binding production. Không suy ra revoke tức thời, fencing, sandbox hay exactly once.
