# Thử nghiệm guard OpenCode — chưa sẵn sàng dùng production

Đây là harness riêng, không thay đổi production runner hoặc khóa fake của overlay LangConfig. Không tạo lại hay sao chép DB quota live. **Đã hết 10/10 workflow attempts**, với 11/40 reservations; cả hai `LIVE_PAUSED` khóa inference. Hai lượt 6–7 là Z.ai, ba lượt 8–10 dùng `openai/gpt-6-luna#high` theo quyền user, tối đa 5 request/workflow và 8.192 output token/request. Không tự tăng budget. Muốn chạy thêm cần quyền mới, không chỉ gỡ pause hoặc đổi DB.

Trong các đường dẫn dưới đây, `E` là `/home/hieu-tran/.local/share/langconfig-eval-20261114` trên máy đã chạy thử.

## Bằng chứng 15/11/2026

- Ba lượt Luna thật completed: draft mâu thuẫn `needs_changes`, control `pass`, và vòng HTTP ASGI/approval giả/writer fixture/review/repair/review lại `pass`. Ba lượt dùng tổng 4 reservation; model/variant và cap được guard xác nhận. HTTP, approval, storage và writer của vòng cuối có các giới hạn fixture trong [bàn giao](../../../docs/adaptive-agent-flow/session-handoff-2026-11-15-langconfig-luna-integration.md); chưa phải tích hợp production.
- Hai lượt LC trả phí Z.ai **`zai/glm-5.3-flash` variant `high`** (không phải FlashX; bộ lọc "chỉ bản mới nhất" ẩn model này) đã chạy thật. Lượt 6 `lc-bc7e3a11-7a0e-4e78-9186-5538c63e253a` (draft mâu thuẫn) trả `needs_changes` đúng retention 90 vs 30 ngày và một vs hai reviewer, nhưng JSON bọc trong khối Markdown nên graph ghi lỗi; parent reconcile offline trên response đã có, `newPrompts: 0`, `jsonFenceNormalized: true`, số đếm giữ 6/6 (`runs/live-lc-z7qup2s5/reconciliation.json`). Lượt 7 `lc-1542c848-b8ac-4132-84b8-503b565f338b` (control) completed, verdict `pass`, findings rỗng; `model-usage.json` xác nhận đúng model/variant, cost báo 5,56e-05 USD (`runs/live-lc-dgd9impb/review.json`). Budget cuối **7/7 workflow, 7/40 reservations**, anchor `workflowCap: 7`, hai pause khóa lại. [Bàn giao LC live](../../../docs/adaptive-agent-flow/session-handoff-2026-11-15-langconfig-live-router.md).
- Sau lượt NeoMind dưới đây, người dùng duyệt thêm một workflow LC, tối đa 5 request, tổng cap 5 workflow/40 request. Graph LC đã dispatch thật đúng router, có receipt, nhưng upstream trả `Provider returned error` / `AI.Error.RateLimit`; retry bị veto, scope dừng. Chưa có review LC thật. Budget lúc đó **5/5 workflow, 5/40 reservations**, anchor giữ cả năm lượt và cap mới; các số 4/4 dưới đây là lịch sử. [Bàn giao LC live](../../../docs/adaptive-agent-flow/session-handoff-2026-11-15-langconfig-live-router.md).
- **NeoMind LocalRun thật qua OpenRouter Free Router completed**: run `run-d10b500e-cb22-4947-a57d-0bcafa6742da`, một attempt và một reservation outbound; JSON `needs_changes` tìm đúng retention 30/90 ngày và hai/một reviewer. Scope inactive, cgroup không còn, parent đã kiểm journal/output. Chỉ đối chiếu source/draft inline trong task; `task_description:SOURCE_line_*` là nhãn model đặt, không phải citations file đã xác minh. Không phải writer hoặc A/B model thật với LangConfig.
- Full model ID `openrouter/openrouter/free`, native provider `openrouter`, model `openrouter/free`, không variant. OpenCode session có sentinel `default`; hook chỉ chuẩn hóa đúng router, outbound/assistant vẫn không variant. Nhãn binding NeoMind `medium` không ghim reasoning router. Model nền router chọn không capture; OpenCode báo cost 0, 327 input/140 output/221 reasoning token, không phải xác nhận billing. Guard kiểm body giá tối đa prompt/completion 0, không provider fallback, plugins hoặc tools; chỉ endpoint native, không redirect. Fanout nội bộ OpenRouter không quan sát được.
- OpenCode tự dùng tài khoản đã lưu qua `OPENCODE_DB`: **DB tài khoản dùng chung, server/config/HOME/cache/log riêng**. Agent không đọc/copy raw credential hoặc DB; không đọc/sửa session cũ hay restart shared service. Các session fixture mới và session preflight không prompt được ghi vào DB chính thức; không tuyên bố không đụng state dùng chung hoặc có OS sandbox.
- Trước router, DeepSeek thử lại ngày mới và GLM Free `high` được duyệt đều nhận `Free usage limit reached`, mỗi lượt thêm một reservation, retry bị veto. Tổng cuối **4/4 workflow, 4/40 reservations**, anchor floor 4/4 giữ cả bốn IDs. Các đoạn về lượt đầu dưới đây là lịch sử. Xem [bàn giao resume](../../../docs/adaptive-agent-flow/session-handoff-2026-11-15-langconfig-free-resume.md) cho evidence và giới hạn.
- Một workflow LC live đã thử đúng `opencode/deepseek-v4.1-flash-free#high`. Guard ghi một reservation trước dispatch, sau đó OpenCode báo **Free usage limit reached**; retry bị veto. Không có review thật. Systemd scope `neomind-run-aaad8eae-67e8-4cc0-a0a2-a7729909be41.scope` được xác nhận dừng. Bằng chứng trong `E/live-guard-20261115/live-lc.log` và `runs/live-lc-x5t6_26z/worker/trace.jsonl`; lỗi trong log server riêng của run đó. Một reservation là **cận trên 1 physical request**, không phải bằng chứng độc lập cho số POST phía server. Không fallback.
- DB budget gốc là `E/live-guard-20261115/live-budget.sqlite`, tại lượt đầu có 1 workflow/1 reservation; nay đã dùng 4/4 và 4/40. Không reset hay tạo DB khác để thử tiếp; không sao chép token/DB hoặc thay tài khoản/billing.
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
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -v test_live_models test_runner_turn test_router_account_probe
node test_guard_router.mjs
node test_guard_glm.mjs
node test_guard_zai.mjs
node test_guard_luna.mjs
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
NEOMIND_EXPERIMENT_MODE=fake-router node test_live_local_run.mjs
node test_live_runner_signal.mjs
```

Kết quả parent cuối ngày 15/11: **15 test Python quota/path/model/reconcile/probe đạt**;
guard router, GLM và Zai đạt; overlay LangConfig **27 đạt, 1 warning**; fake native-router LocalRun
completed với 1 POST giả/1 reservation, unit inactive và cgroup rỗng. SIGTERM cleanup đạt. Probe
unit dùng mock, không gọi auth hoặc inference thật; lỗi probe phát `PROBE_FAILED` để wrapper exit
khác 0, không báo giả thành công. Guard Zai kiểm đúng `zai/glm-5.3-flash` variant `high`, endpoint
native, trần 8.192 output, cap 5 request, veto retry và không fetch.
Các test Node path và signal cleanup, fake acceptance và runner contract trước đó cũng đạt.
Sau khi được duyệt thêm lượt LC: **15 test Python đạt**, thêm test cap extension khớp
anchor và chặn vượt cap. `test_live_lc_fake.py` replay chính graph LC thật với upstream
giả trong namespace, kiểm source được đọc vào prompt, 1 fake POST/reservation; chạy bằng
Python LangConfig đã cài, `PYTHONPATH` tới backend staging và `FIXTURE_NETNS=1` trong
namespace chỉ loopback. Không dùng script fake này để gửi inference thật.
Các fake DB không dùng hoặc sửa DB quota live gốc. Script LocalRun đòi baseline
đúng ba file tổng hợp, từ chối repo dữ liệu thật; không kiểm writer/approval/commit
kết quả và không phải production runner đã tích hợp guard.

Mỗi lệnh fake tạo run directory mới dưới `LIVE_GUARD_DATA/runs`; không dùng DB live. `auth_probe.py` là kiểm catalog signed-out, không gửi prompt; catalog khả dụng không chứng minh inference hay auth thành công.

## Giới hạn và bước tiếp

`runner.mjs` chỉ fake; `live_runner.mjs` là factory read-only thử nghiệm riêng, có mode `fake`, `fake-router` và `live`, từ chối resume/write/web và không tuyên bố OS sandbox. Mode live chỉ router đã chọn. `models()`/`verifyCapabilities()` của factory cố ý từ chối probe chung: inventory được kiểm trong owned worker; vì vậy đây chưa phải factory production có thể thay thế trực tiếp mọi code path.

`live_lc.py` dùng adapter overlay với transport thử nghiệm riêng. Overlay cho phép đúng các identity đã duyệt khi transport không phải fixture-only; HTTP transport mặc định **vẫn chỉ cho fake model**. Adapter chấp nhận session sentinel `default` riêng cho router nhưng assistant phải không variant; ca này mới kiểm fake, **chưa có LC router live thành công**. Adapter cũng chấp nhận đúng một khối `json` bao kín quanh object review (thêm sau lượt Z.ai 6) và vẫn kiểm schema nghiêm ngặt, từ chối mọi dạng khác. Script live yêu cầu LC backend/Python, budget gốc đã tồn tại, DB tài khoản chính thức, opt-in và không pause; không tự tạo budget mới. Giá trị opt-in công khai không chứng minh người dùng đồng ý. Budget hiện đã hết, không tự gỡ pause.

Để ngăn nhầm DB, chủ sở hữu chuẩn bị riêng `$LIVE_GUARD_DATA/live-budget.anchor.json`, từ DB gốc hiện có, không sao chép DB. Anchor có `schemaVersion: 1`, đường dẫn canonical, `device`/`inode`, floor workflow/reservation và `requiredReservationIds`. Trường `workflowCap` mặc định 4 cho anchor cũ; chỉ giá trị 4/5/7/10 được hỗ trợ, cap request vẫn 40. Theo từng lần user duyệt, owner đổi cap DB gốc, giữ mọi row lịch sử; hiện anchor là 10 workflow/11 reservation. Runtime **không tự nâng cap**, chỉ kiểm anchor/DB phải khớp; metadata UUID lưu dưới `live-attempts/`, có `requestCap: 5` cho LC mới. Attempt lỗi vẫn tiêu slot, không hỗ trợ resume. Anchor giảm nhầm lẫn, **không chống cố ý sửa** anchor/DB. Không tạo anchor/DB khác để né lịch sử.

Có khả năng plugin bị unload giữa preflight và dispatch; thử nghiệm chưa chứng minh đó là ranh giới an toàn production. Lượt LocalRun router thật không capture identity model nền; các lượt LC Luna/Z.ai và control chỉ dùng fixture, không đủ suy ra chất lượng ổn định hoặc khả dụng mọi tài khoản. OpenCode V2 lưu account trong SQLite cùng server state: dùng DB chính thức chỉ qua ứng dụng OpenCode và phải hiểu session mới sẽ ghi vào đó, không copy/query credential. Cách kết nối chính thức là `/connect` hoặc `opencode auth login` trong context do chủ tài khoản kiểm soát, không đưa token vào chat.

Nguồn API: OpenCode 2.2.7 `@opencode/plugin` Promise `session.d.ts`, `registration.d.ts`, `model.d.ts`; `@opencode/schema` `model.d.ts`; tài liệu V2 `/build/plugins/server/`, `/config/`, `/cli/providers/`. Guard và fixture được viết mới dựa trên thí nghiệm wire trước; LC adapter được import từ bản prototype đã đóng gói, không sao chép credential hay thay file overlay.
