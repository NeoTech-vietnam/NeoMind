# LangConfig × OpenCode — hồ sơ thử nghiệm

Nhánh nghiên cứu: `research/langconfig-opencode`, tách từ NeoMind `6306c8b`. Mục tiêu là xem có thể tận dụng LangConfig để dựng và điều phối nhiều loại workflow, còn OpenCode thực thi từng bước, thay vì tiếp tục tự xây mọi tầng trong NeoMind. **Chưa quyết định thay NeoMind hoặc đưa tích hợp vào production.**

## Đọc từ đâu

1. [Ý tưởng và lý do tích hợp](integration-rationale.md): nhu cầu, lựa chọn kiến trúc, trách nhiệm mỗi bên và tiêu chí ra quyết định.
2. [Setup và các tầng kiểm thử](setup-and-tests.md): môi trường cô lập, dependency, lệnh chạy và các lỗi setup đã gặp.
3. [Gói prototype có thể tái lập](../../experiments/langconfig-opencode/README.md): overlay/patch lên LangConfig đã ghim, adapter, test và harness; không chứa bản cài LangConfig hay dữ liệu máy cá nhân.
4. [Báo cáo đánh giá 14/11](../adaptive-agent-flow/research-langconfig-vs-neomind-2026-11-14.md): bằng chứng và giới hạn của từng lượt thử trước khi đóng gói.
5. [Bàn giao LC live router 15/11](../adaptive-agent-flow/session-handoff-2026-11-15-langconfig-live-router.md): lượt thêm được duyệt bị upstream rate limit; [resume trước đó](../adaptive-agent-flow/session-handoff-2026-11-15-langconfig-free-resume.md) và [đóng gói](../adaptive-agent-flow/session-handoff-2026-11-15-langconfig-package.md).

## Hiện đã chứng minh điều gì?

```text
LangConfig TOOL_NODE → adapter HTTP loopback → OpenCode 2.2.7 → model giả
```

- Đã có đường HTTP tới server OpenCode thật và nhận JSON review giả về graph.
- Graph thử dùng implementation `TOOL_NODE` thật, chưa phải toàn bộ backend HTTP/WorkflowExecutor hoặc canvas UI của LangConfig.
- LangConfig đọc fixture rồi truyền nội dung vào prompt; session OpenCode của prototype bị từ chối mọi tool. Đây không phải kiểm chứng OpenCode tự đọc/sửa file hay OS sandbox.
- Model giả chỉ kiểm tra đường thực thi, không chứng minh chất lượng AI. Benchmark A/B trước đó cũng dùng fake runner/model và chưa hoàn toàn đối xứng.
- **NeoMind LocalRun thật qua OpenRouter Free Router đã completed**, JSON phát hiện đúng hai sai lệch trong task inline. Không capture được model nền thực; findings không phải citations file đã xác minh. Ba lượt LC đầu bị quota; lượt LC router được duyệt thêm đã dispatch nhưng upstream rate limit, **chưa có LC live thành công hoặc A/B model thật**. Budget cuối sau cấp thêm quyền: **5/5 workflow, 5/40 reservations**; hai pause giữ khóa, không reset DB hay fallback trả phí.
- Harness đã kiểm quota nhiều process và retry qua OpenCode thật với upstream giả; factory thử nghiệm qua `RunnerRegistry` và LocalRun read-only kiểm journal/scope dừng. Không thay policy hoặc production runner; xem [harness và giới hạn](../../experiments/langconfig-opencode/live/README.md). Parent replay cuối: 21 test adapter (1 warning), 4 lifecycle, 14 Python support và fake-router LocalRun đạt.
- Đã kiểm cài sạch Python dependencies chọn lọc: venv 3.12 mới, cache riêng trống, `pip check`, 17 test adapter, 4 test lifecycle và wire đều đạt. Điều này không bao phủ full backend/UI hoặc Windows; dependency transitive chưa được khóa.

## Những gì không nằm trong Git

Environment Python/Node, toàn bộ clone upstream, DB, worktree đã chạy, cache, credentials và log thô vẫn là dữ liệu lab ngoài checkout. Gói trong `experiments/` giữ code và cấu hình giả cần thiết; không phụ thuộc vào việc thư mục lab cũ còn tồn tại. Những thí nghiệm lịch sử chưa có harness portable được báo riêng, không mặc định tái lập được từ một lệnh.

Các quan sát bất thường về approval, skill sau restart và trạng thái lỗi của LangConfig có điều kiện môi trường; xem báo cáo, không coi đó là kết luận mọi bản LangConfig đều lỗi. Phần runtime NeoMind hiện tại không bị thay thế bởi nhánh này.
