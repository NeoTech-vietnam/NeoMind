# LangConfig × OpenCode — hồ sơ thử nghiệm

Nhánh nghiên cứu: `research/langconfig-opencode`, tách từ NeoMind `6306c8b`. Mục tiêu là xem có thể tận dụng LangConfig để dựng và điều phối nhiều loại workflow, còn OpenCode thực thi từng bước, thay vì tiếp tục tự xây mọi tầng trong NeoMind. **Chưa quyết định thay NeoMind hoặc đưa tích hợp vào production.**

## Đọc từ đâu

1. [Ý tưởng và lý do tích hợp](integration-rationale.md): nhu cầu, lựa chọn kiến trúc, trách nhiệm mỗi bên và tiêu chí ra quyết định.
2. [Setup và các tầng kiểm thử](setup-and-tests.md): môi trường cô lập, dependency, lệnh chạy và các lỗi setup đã gặp.
3. [Gói prototype có thể tái lập](../../experiments/langconfig-opencode/README.md): overlay/patch lên LangConfig đã ghim, adapter, test và harness; không chứa bản cài LangConfig hay dữ liệu máy cá nhân.
4. [Báo cáo đánh giá 14/11](../adaptive-agent-flow/research-langconfig-vs-neomind-2026-11-14.md): bằng chứng và giới hạn của từng lượt thử trước khi đóng gói.
5. [Bàn giao đóng gói 15/11](../adaptive-agent-flow/session-handoff-2026-11-15-langconfig-package.md): kiểm chứng mới và công việc tiếp theo.

## Hiện đã chứng minh điều gì?

```text
LangConfig TOOL_NODE → adapter HTTP loopback → OpenCode 2.2.7 → model giả
```

- Đã có đường HTTP tới server OpenCode thật và nhận JSON review giả về graph.
- Graph thử dùng implementation `TOOL_NODE` thật, chưa phải toàn bộ backend HTTP/WorkflowExecutor hoặc canvas UI của LangConfig.
- LangConfig đọc fixture rồi truyền nội dung vào prompt; session OpenCode của prototype bị từ chối mọi tool. Đây không phải kiểm chứng OpenCode tự đọc/sửa file hay OS sandbox.
- Model giả chỉ kiểm tra đường thực thi, không chứng minh chất lượng AI. Benchmark A/B trước đó cũng dùng fake runner/model và chưa hoàn toàn đối xứng.
- **Đã thử 1 workflow model free nhưng OpenCode trả `Free usage limit reached`; 0 lượt live hoàn thành.** Một reservation là cận trên 1 physical request, chưa có review AI thật hoặc số POST được đối chứng ở dịch vụ. Đã pause, giữ nguyên DB budget và không fallback trả phí. Trần được duyệt vẫn là 4 workflow/40 request, không reset DB để vượt giới hạn.
- Harness mới đã kiểm quota nhiều process và retry qua OpenCode thật với upstream giả; factory thử nghiệm qua `RunnerRegistry` và **LocalRun read-only hoàn chỉnh** của NeoMind đã chạy đạt, kiểm journal và scope dừng. Đây chưa phải bằng chứng LocalRun live hoặc production runner đã tích hợp guard; xem [harness và blocker](../../experiments/langconfig-opencode/live/README.md).
- Đã kiểm cài sạch Python dependencies chọn lọc: venv 3.12 mới, cache riêng trống, `pip check`, 17 test adapter, 4 test lifecycle và wire đều đạt. Điều này không bao phủ full backend/UI hoặc Windows; dependency transitive chưa được khóa.

## Những gì không nằm trong Git

Environment Python/Node, toàn bộ clone upstream, DB, worktree đã chạy, cache, credentials và log thô vẫn là dữ liệu lab ngoài checkout. Gói trong `experiments/` giữ code và cấu hình giả cần thiết; không phụ thuộc vào việc thư mục lab cũ còn tồn tại. Những thí nghiệm lịch sử chưa có harness portable được báo riêng, không mặc định tái lập được từ một lệnh.

Các quan sát bất thường về approval, skill sau restart và trạng thái lỗi của LangConfig có điều kiện môi trường; xem báo cáo, không coi đó là kết luận mọi bản LangConfig đều lỗi. Phần runtime NeoMind hiện tại không bị thay thế bởi nhánh này.
