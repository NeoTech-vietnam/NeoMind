# LangConfig với OpenRouter thật — 15/11/2026

## Quyền và budget

Sau [lượt NeoMind router thành công](session-handoff-2026-11-15-langconfig-free-resume.md), người dùng yêu cầu test LangConfig với model thật và **duyệt thêm một workflow**, tối đa **5 request cho lượt mới**, tổng trần **5 workflow / 40 request**. Không phải quyền retry vô hạn, đổi model hoặc fallback trả phí.

Parent chỉ nâng `limits.workflow_cap` của **DB gốc** từ 4 lên 5 trong transaction; so sánh toàn bộ rows `workflows`, `sessions`, `reservations` trước/sau không đổi. Không reset/copy DB, không sửa lịch sử. Anchor giữ path/device/inode và cả bốn reservation cũ, thêm `workflowCap: 5`; runtime vẫn đòi đúng cap request 40. Anchor cũ thiếu trường này giữ mặc định 4, DB đổi cap mà anchor chưa đổi bị từ chối. Không hỗ trợ cap ngoài 4/5 chỉ vì biến môi trường.

## Chuẩn bị không inference

- Tách `execute_graph` từ script LC thật để replay cùng graph: LangConfig `StateGraph` gọi `core.workflows.nodes.execute_tool_node` thực, `read_file → opencode_review`; dùng OpenCode 2.2.7 và upstream giả trong network namespace chỉ loopback. **Đạt, 1 POST giả/1 reservation**, xác nhận từng dòng file đọc bằng native tool có trong prompt OpenCode. Hai lần assertion test đầu sai vì đọc message user từ `content` thay vì trường `text` của API; đã sửa cách kiểm theo response thật, không sửa graph hoặc bỏ điều kiện nội dung.
- Python quota/path/model/reconcile/probe **15 test đạt**, có test extension cap phải khớp anchor, giữ reservation cũ, chặn workflow thứ sáu và request thứ sáu của workflow mới. Guard router đạt, không fetch.
- `npm test` với TMPDIR thuộc lab: **369 test, 357 đạt, 0 lỗi, 12 skip**, 69 giây; log `langconfig-live-router-neomind-tests.log`. Không sửa production core/UI/extension.
- Catalog chính thức vẫn xác nhận `openrouter/openrouter/free` active, không variant, input/output/cache giá metadata 0. Dùng tài khoản hiện có qua chính OpenCode và `OPENCODE_DB`, không đọc/copy credential hay restart service chính. Server/config/HOME/cache riêng nhưng DB tài khoản dùng chung như lượt trước.

## Kết quả lượt thật

**Đã dispatch model thật nhưng LangConfig chưa hoàn tất thành công.** Workflow `lc-47d477aa-ab60-4ecf-95d8-538a7ca83de4` tạo session `ses_e231fb085ffe2G0r4IdwZ0ffvq`; adapter ghi stage `admitted`, prompt receipt `msg_db7b0f2213a5fe1e7975338e`. Guard ghi đúng một `reserved` cho provider `openrouter`, model `openrouter/free`, kind `primary`, không variant. Sau đó có `retry` attempt 2, `allowed: false`.

Log worker lúc `2026-11-15T01:44:11Z` ghi **`Provider returned error`**, cause **`AI.Error.RateLimit`**. Không kết luận cụ thể là quota tài khoản, model nền hay provider nào; không capture được HTTP status/body chi tiết hoặc actual routed model. Chưa có JSON review/verdict/findings/usage/billing để đánh giá. `attempts.sqlite` không có terminal result và `review.json` không được tạo; không coi receipt thành công là review thành công.

Scope `neomind-run-54a2dbc0-758d-4fdb-bd6e-7ef6f7d9d128.scope` trả `stoppedVerified: true`; parent kiểm `ActiveState=inactive`, `ControlGroup` rỗng. Đã khôi phục cả hai `LIVE_PAUSED`, không gửi retry hoặc workflow khác.

Tổng budget cuối **5/5 workflow attempts, 5/40 reservations**. Reservation là cận trên outbound requests của worker, không đối chứng số POST ở dịch vụ hoặc fanout nội bộ router. Owner anchor đã nâng floor lên 5/5, giữ cả năm IDs, không sửa số đếm. Bản ghi cấp thêm quyền ở lab `live-guard-20261115/langconfig-extension-20261115.json` giữ cap trước/sau và hash lịch sử không đổi.

## Evidence và tiếp tục

Trong `E=/home/hieu-tran/.local/share/langconfig-eval-20261114`:

- `langconfig-live-router-20261115.log`: scope stop, workflow outcome exited, số đếm 5/5.
- `live-guard-20261115/runs/live-lc-0aocy2jv/worker/trace.jsonl`: reservation và retry veto; log OpenCode cùng run có typed rate-limit error.
- `live-guard-20261115/runs/live-lc-0aocy2jv/attempts.sqlite`: admission/receipt, không terminal; fixture tổng hợp trong `fixture/source.txt`.
- `parent-router-replay-20261115/runs/lc-fake-6038omto`: fake graph thành công và message user xác nhận source/draft thực được đọc vào prompt.

**Lượt router này chưa tích hợp LangConfig model thật thành công.** Đường graph/adapter/server đã dispatch được, nhưng lần này upstream rate limit chặn kết quả. Không lặp lại lỗi bằng lượt mới khi chưa xử lý điều kiện và có quyền cụ thể. Sau đó người dùng duyệt thêm hai lượt trả phí, ghi ở phần dưới. Phép thử vẫn là TOOL_NODE prototype, chưa phải full HTTP backend/WorkflowExecutor/UI hay chu trình writer/review/repair.

## Lượt trả phí Z.ai GLM-5.3-Flash high — 15/11/2026

Người dùng duyệt **thêm hai workflow LC trả phí**, mỗi lượt tối đa 5 request và 8.192 output token/request; trần chung giữ 40 request. Parent nâng `limits.workflow_cap` DB gốc 5→7 trong transaction; so sánh toàn bộ rows `workflows`/`sessions`/`reservations` trước/sau không đổi. Anchor giữ path/device/inode, sáu reservation cũ và `workflowCap: 7`; bản ghi `live-guard-20261115/zai-paid-extension-20261115.json` giữ cap trước/sau, `perWorkflowRequestCap: 5`, `maxOutputTokens: 8192` và hash lịch sử không đổi.

Model ghim đúng **`zai/glm-5.3-flash` variant `high`**, không phải FlashX. Catalog Z.ai có model này nhưng bộ lọc "chỉ bản mới nhất" ẩn nó; lượt kiểm đầu đã bỏ sót. Preflight worker xác nhận session dùng đúng provider/model/variant; guard `test_guard_zai.mjs` đạt: chỉ endpoint native Z.ai, không tools/fallback, trần 8.192 output, cap 5 request/workflow, veto retry, không fetch. Không nạp credits, không đổi tài khoản.

**Lượt 6 — draft mâu thuẫn** (`lc-bc7e3a11-7a0e-4e78-9186-5538c63e253a`): model thật trả lời đúng, verdict `needs_changes`, hai finding đúng (retention 90 vs 30 ngày; một vs hai reviewer), nhưng JSON nằm trong khối Markdown nên graph ghi lượt là lỗi. Parent reconcile **offline trên response đã có**, 0 prompt mới (`newPrompts: 0`, `jsonFenceNormalized: true`), số đếm giữ 6/6; kết quả ở `runs/live-lc-z7qup2s5/reconciliation.json`. Adapter nay chấp nhận đúng một khối `json` được bao kín, vẫn kiểm schema nghiêm ngặt và từ chối mọi dạng khác.

**Lượt 7 — draft control** (`lc-1542c848-b8ac-4132-84b8-503b565f338b`): completed, verdict `pass`, findings rỗng; `model-usage.json` xác nhận `glm-5.3-flash`/`zai`/`high`, 154 input/56 output/9 reasoning token, cost báo 5,56e-05 USD. Kết quả ở `runs/live-lc-dgd9impb/review.json`.

Budget cuối **7/7 workflow, 7/40 reservations**; cả hai `LIVE_PAUSED` khóa lại, không còn lượt được duyệt. Scope cả hai lượt trả `stoppedVerified: true`, parent kiểm inactive và cgroup rỗng. Không retry, không fallback, không gửi request thứ ba.

Kiểm chứng sau sửa cuối: `npm test` **369 test, 357 đạt, 0 lỗi, 12 skip** (`paid-zai-20261115/neomind-final-tests.log`); Python quota/path/model/reconcile/probe **15 đạt**; overlay LangConfig **27 đạt, 1 warning**; guard Zai đạt.

Giới hạn: vẫn là TOOL_NODE prototype, chưa phải full HTTP backend/WorkflowExecutor/UI hay chu trình writer/review/repair. Chỉ một draft mâu thuẫn và một control, không phải benchmark chất lượng hay phép thử false-positive trên diện rộng; cost chỉ từ một lượt nên không suy ra giá các lượt khác. Findings tham chiếu dòng trong draft inline, không phải file thật được kiểm.
