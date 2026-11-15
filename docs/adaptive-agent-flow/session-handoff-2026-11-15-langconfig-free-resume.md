# Tiếp tục kiểm thử model free — 15/11/2026

**Cập nhật sau mốc này:** người dùng duyệt thêm một workflow LC, cap tổng 5/40; lượt đó bị rate limit. Xem [bàn giao LC live](session-handoff-2026-11-15-langconfig-live-router.md). Các số 4/4 dưới đây là lịch sử trước lần cấp thêm quyền, không phải budget hiện tại.

## Phạm vi và quyền đã duyệt

Tiếp tục nhánh `research/langconfig-opencode` sau `2468310`, theo mục tiêu tích hợp thử nghiệm chỉ đọc LangConfig và NeoMind với model free của OpenCode. Không thay production runner, không thêm writer, không tự dùng model có phí hoặc tạo PR. Parent kiểm kết quả và xử lý commit/push; session Terra 6.1 `xhigh` triển khai và kiểm thử.

Người dùng xác nhận ngày mới đã reset quota, cho phép thử lại DeepSeek Free. Parent xác minh budget gốc/anchor bằng mode read-only rồi bỏ hai pause sentinel theo xác nhận đó; **không reset, copy hoặc tạo lại DB**. Model catalog vẫn có `opencode/deepseek-v4.1-flash-free#high` với giá metadata 0; catalog không chứng minh inference khả dụng.

## Lượt thử lại DeepSeek

- Scope `neomind-run-fd657298-b9ed-4e36-bdfe-8ab5e542c849.scope` dừng xác nhận; run kết thúc lỗi, không có review thật.
- Log OpenCode riêng ghi tiếp **`Free usage limit reached`** lúc `2026-11-15T00:32:31Z`; không kết luận riêng đó là quota tài khoản, IP hay lỗi auth.
- Guard ghi đúng model/variant DeepSeek Free `high`, một reservation và `retry` attempt 2 bị veto. Không fallback và không chạy NeoMind/control sau lỗi quota.
- Budget tích lũy sau lượt này: **2/4 workflow attempts, 2/40 reservations**. Reservation là cận trên physical requests, không phải đối chứng số POST ở phía dịch vụ. Parent tăng floor owner anchor lên 2/2 và giữ cả hai reservation IDs gốc; SQLite không bị sửa/reset.
- Evidence ở lab cũ: `live-guard-20261115/live-lc-resume-20261115.log` và `runs/live-lc-ldd_q89z/worker/trace.jsonl`; không commit raw log hoặc DB.

## Đổi model được người dùng duyệt

Sau lỗi trên, người dùng đã chọn **GLM Free** trong question tool: `opencode/glm-5.3-flash-free#high`. Catalog xác nhận active và input/output/cache giá 0 tại thời điểm duyệt. Đây là thay lựa chọn có xác nhận, **không phải auto fallback**. Tổng trần không đổi: 4 workflow/40 request cho cả bài đánh giá; còn tối đa hai workflow attempts sau hai lỗi DeepSeek.

Lượt GLM duy nhất đã dispatch trước khi yêu cầu chuyển OpenRouter có hiệu lực. Dịch vụ cũng trả **`Free usage limit reached`**, retry bị veto; không có JSON review và không chạy NeoMind live sau lỗi. Scope GLM đã dừng, hai pause được khôi phục. Budget gốc lúc bàn giao: **3/4 workflow attempts, 3/40 reservations**. Parent kiểm read-only rồi nâng owner anchor lên 3/3, giữ cả ba reservation IDs; không thay SQLite hoặc trần.

Evidence GLM ở `glm-preflight-20261115/live-lc-glm.log` và `live-guard-20261115/runs/live-lc-aavh4nhf/worker/trace.jsonl` trong lab cũ. Worker báo fresh overlay 19 test đạt (1 warning), quota/path/model/reconcile 11 test đạt, guard GLM và SIGTERM cleanup đạt. Full LocalRun qua factory thử nghiệm đạt với upstream giả: 1 fake POST/reservation, journal và scope stop được kiểm; **không phải model thật**. Parent replay phiên bản cuối ở mục kiểm chứng bên dưới.

## Chuyển sang OpenRouter Free Router

Người dùng yêu cầu thử Free Models Router của OpenRouter, không tăng budget. Full ID OpenCode là **`openrouter/openrouter/free`**: provider `openrouter`, native model ID `openrouter/free`; catalog không có variant. Không gán nhãn giả `high` hoặc coi router là một model cố định. Model thực được chọn có thể khác giữa các lượt, cần ghi nếu response cho phép quan sát.

Parent kiểm nguồn chính thức: metadata công khai của `openrouter/free` báo prompt/completion giá 0. Biến `OPENROUTER_API_KEY` không có trong môi trường execution; `opencode auth list` chính thức exit 0 và có OpenRouter trong danh sách tài khoản đã lưu. Chỉ kiểm boolean, không đọc/copy credential hoặc công bố danh sách.

Khi chuyển hướng chỉ còn **một workflow attempt**, dành cho NeoMind LocalRun thật sau fake-test guard và preflight auth/config không inference. Không chạy LC live trước để tiêu slot cuối, không gộp hai workflow nhằm né cap. Guard kiểm native endpoint, đúng router, không variant, giá tối đa prompt/completion 0, không provider fallback hoặc plugin trả phí; HTTP outbound do worker gửi được reservation trước dispatch. Fanout/retry bên trong OpenRouter không quan sát được, không tuyên bố đã đếm mọi request backend.

### Kết quả thật đã kiểm lại

- **LocalRun `run-d10b500e-cb22-4947-a57d-0bcafa6742da` completed**, một attempt read-only, từ `2026-11-15T01:27:31Z` đến `01:27:38Z`. Đây là factory thử nghiệm cắm qua `RunnerRegistry`, không phải session OpenCode độc lập được gọi là NeoMind flow và không phải production runner đã đổi policy.
- JSON model trả `needs_changes`; finding 1: “Audit log retention period differs: source specifies 30 days, draft specifies 90 days”; finding 2: “Production release approval requirement differs: source requires two reviewers, draft requires one reviewer”. Parent đọc journal và kiểm đúng cả hai nội dung. Findings dùng `task_description:SOURCE_line_1`/`SOURCE_line_2`: **nhãn inline do model đặt, không phải đường dẫn/line file được xác minh**. Không đánh dấu đạt yêu cầu citation file của flow Research nói chung.
- Source/draft được truyền trong task; mọi tool OpenCode bị deny. Không chứng minh model tự đọc file, sửa file, writer/review/repair đầy đủ hoặc LangConfig live. Fixture Git dùng để vận hành workspace không đồng nhất với hai tài liệu inline được model đối chiếu.
- Worker OpenCode riêng dùng config/HOME/cache/log riêng nhưng **dùng DB tài khoản chính thức qua `OPENCODE_DB`**, không phải DB hoàn toàn cô lập. Chính OpenCode truy cập credential theo cơ chế ứng dụng; agent không trích key, không copy/read raw credential/DB, không xem hoặc sửa session cũ và không restart service dùng chung. Probe tạo session mới không prompt. Không tuyên bố không có ghi vào state tài khoản chung: các session thử nghiệm mới nằm trong DB đó.
- Router catalog không có variant; OpenCode lưu sentinel session `default`, hook chỉ chuẩn hóa đúng router thành reference không variant trước outbound. Assistant reference cũng không variant. NeoMind binding `medium` chỉ là nhãn contract hiện tại, **không ghim reasoning router**. Trace có một `reserved`, không retry; không capture model nền thực được chọn. OpenCode báo input 327, output 140, reasoning 221 token và cost 0, **không phải đối chứng hóa đơn**.
- Scope `neomind-run-2fb76022-736d-4757-9e21-16625e439074.scope`: parent kiểm `ActiveState=inactive`, `ControlGroup` rỗng và cgroup cũ không còn. Journal có intent → baseline → scope → turn → receipt → output → attempt finished theo thứ tự.
- Budget kết thúc **4/4 workflow attempts, 4/40 reservations**. Parent nâng owner anchor floor lên 4/4 và giữ cả bốn reservation IDs; DB không reset/copy/sửa. Cả hai `LIVE_PAUSED` đã cập nhật lý do **hết workflow budget**, không còn giữ số cũ 3/3. Không chạy thêm LC hoặc control tài liệu đúng, không tăng cap hay fallback trả phí.

Evidence dưới `E=/home/hieu-tran/.local/share/langconfig-eval-20261114`: journal `live-guard-20261115/localrun-yO3a1m/state/runs/run-d10b500e-cb22-4947-a57d-0bcafa6742da/events.jsonl`; `runs/neomind-runner-3xdy7uh1/turn-status.json` và `worker/trace.jsonl` thuộc `live-guard-20261115`; stdout `glm-preflight-20261115/router-neomind-live.log`. Probe cuối thành công không redirect log riêng; artifacts `live-guard-20261115/runs/router-probe-3l8ldj1p`. Các log `router-account-probe*.log` cũ còn trên đĩa chứa lỗi preflight trước sửa sentinel, **không phải bằng chứng probe cuối thành công**.

## Kiểm chứng nền

Parent chạy lại `npm test` với `TMPDIR` thuộc filesystem lab: **369 test, 357 đạt, 0 lỗi, 12 skip**, log `neomind-free-resume-20261115-tests.log`. Kết quả fake/cold-install trước đó xem [bàn giao đóng gói](session-handoff-2026-11-15-langconfig-package.md). Các unit/fake tests không trừ vào DB budget live.

Parent chạy lại suite khi chuẩn bị OpenRouter: **369 test, 357 đạt, 0 lỗi, 12 skip**, 79 giây, log `neomind-openrouter-20261115-tests.log`. `pip check` trên cold venv đã cài trước đó vẫn đạt (`No broken requirements found`). Đây là kiểm chứng nền, không chứng minh đường router mới hoặc chất lượng review model.

Parent review/replay cuối trên Linux, dữ liệu ngoài repo ở `parent-router-replay-20261115/`:

- Fresh stage từ overlay cuối: **21 test adapter đạt, 1 warning**; thêm ca session sentinel `default` chỉ cho router, assistant vẫn bắt buộc reference không variant; fixture HTTP vẫn từ chối mọi model live. Lifecycle harness **4 test đạt**.
- Python quota/path/model/no-resubmit và probe: **14 test đạt**. Review phát hiện probe nuốt lỗi nhưng vẫn phát `PROBE_DONE`; đã sửa failure sentinel thành `PROBE_FAILED`, wrapper exit khác 0 và test fake cả hai nhánh, không chạy thêm probe hoặc inference thật.
- Guard router và GLM đều đạt, không fetch; fake native-router LocalRun completed, **1 fake POST / 1 fake reservation**, scope dừng. SIGTERM cleanup đạt sau khi parent bổ sung đủ env fixture; lần gọi đầu thiếu `LOCALRUN_LAB_BASE`/`SYNTHETIC_BASE_REPO` đã lỗi preflight, không có inference.
- Sau sửa cuối, `npm test` tiếp tục **369 test, 357 đạt, 0 lỗi, 12 skip**, 74 giây; log `parent-router-replay-20261115/neomind-tests.log`. Python AST, Node syntax và `git diff --check` đạt. Không sửa UI/extension hoặc chạy model thêm.

## Phần còn lại

Không còn workflow budget. Chưa có LC live thành công, control false-positive, actual routed-model identity, writer hoặc production integration. Lượt router duy nhất chứng minh được đường LocalRun và phát hiện hai sai lệch inline, không đủ kết luận chất lượng model ổn định hay LangConfig tốt/kém hơn NeoMind. Muốn chạy thêm phải xin budget mới cụ thể; không xóa pause, đổi DB hoặc reset lịch sử để tiếp tục.

Code/guard/tests và README thử nghiệm được lưu ở commit `21ceeda` (`feat: add guarded OpenRouter free router experiment`) trên nhánh nghiên cứu đã duyệt; báo cáo resume đi thành commit tài liệu riêng. Không PR, không đổi production core hoặc đưa dữ liệu lab/credential vào Git.
