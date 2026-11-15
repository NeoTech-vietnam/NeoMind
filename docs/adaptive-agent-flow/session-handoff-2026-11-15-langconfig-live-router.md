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

**Chưa thể nói LangConfig model thật đã tích hợp thành công.** Đường graph/adapter/server đã dispatch được, nhưng lần này upstream rate limit chặn kết quả. Không lặp lại lỗi bằng lượt mới khi chưa xử lý điều kiện và có quyền cụ thể. Không có budget còn lại, không tự gỡ pause, đổi DB/model hoặc nạp credits. Phép thử vẫn là TOOL_NODE prototype, chưa phải full HTTP backend/WorkflowExecutor/UI hay chu trình writer/review/repair.
