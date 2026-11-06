# Bàn giao nâng cấp NeoMind (Gói 1–5) — 06/11/2026

Branch `feat/neomind-upgrade` (worktree `test_workflow_worktrees/upgrade`), từ `4250645`. Làm theo [plan đã duyệt](plan-upgrade-2026-11-06.md) và [định hướng 06/11](direction-2026-11-06.md). Không merge, không push, không cài extension, không chạy run thật. Chi tiết từng gói và quyết định nhỏ: [implementation-status.md](implementation-status.md) (mục "Nâng cấp NeoMind · Gói N").

## Đã làm

| Gói | Nội dung | Commit |
| --- | --- | --- |
| 1 · AI tạo/chọn flow | `flow-authoring.ts`, `flow-diff.ts`, tác giả phiên bản, `ai.flowPublish`, tool `flow_*`/`assess` (session Codex trước) | `c1a00a0`, `6fbfa85`, `a67b046`, `d05df5c` |
| 2 · Skills và profile | Danh mục skill + trạng thái `ok/changed/missing`, đọc phiên bản profile cũ, chuyển draft flow sang phiên bản profile, `profile_*`/`skills`, nhãn skill trong prompt, SkillPicker | `ad491e4`, `7e4e9c0`, `266bc41`, `c24e4a8` |
| 3 · Chương trình nhiều giai đoạn | `programs.ts`, `program_*`, trạng thái suy từ run + `merge-base --is-ancestor`, bài học giữa giai đoạn, `planStepCriteria`, nhóm Chương trình ở Runs | `eb5714b`, `5b5d59a`, `42e3263`, `a218f1b` |
| 4 · Rules | `neomind/rules.md` → ghim vào run, prompt mọi agent, tiêu chí `Rule R1` cho mọi review, preview/flow_blocks/CLI/API, UI Run mới + Kiểm tra | `8393b20`, `4f9f20f`, `812bf0a`, `c195e8f` |
| 5 · Chi phí và quota | `limits.maxTokens` + gia hạn token, `run-stats.ts` (CLI `run stats`, API, tool `stats`), `pricing.json` tùy chọn, ước tính ≥ 3 run, `assess` dùng thống kê, UI | `10b92cb`, `e6dcf3c`, `e33cc11`, `b88559c`, docs cuối |

## Kiểm chứng (Windows)

| Lần chạy `npm test` đầy đủ | Kết quả |
| --- | --- |
| Cuối Gói 2 (`266bc41`) | 244 test: 242 pass, 2 skip, 0 fail |
| Cuối Gói 3 (`42e3263`) | 247 test: 245 pass, 2 skip, 0 fail |
| Cuối Gói 4 (`812bf0a`) | 251 test: 249 pass, 2 skip, 0 fail |
| Cuối Gói 5 (`e33cc11`; `b88559c` sau đó chỉ sửa UI Flow Studio) | 254 test: 252 pass, 2 skip, 0 fail |

Mỗi gói: `npx tsc -p tsconfig.ui.json --noEmit`, `npm run build:ui`, build extension đạt. `parallel writers run concurrently` không lỗi lần nào. `claude-capabilities` gọi Claude CLI thật (~$0.002/lần). UI kiểm bằng gallery dữ liệu giả qua Edge headless (CDP): Profiles › Skills/migrate, Runs (chương trình, rules, ngân sách token, ước tính), Flow Studio (ngân sách token).

## Lệch plan và lý do

- **Đánh dấu giao thủ công** (`program_deliver`, `confirmed: true`, ghi chú): plan nhắc "ghi chú người dùng khi đánh dấu giao" nhưng không có thao tác; cần thêm vì squash/rebase làm `--is-ancestor` không thấy commit. Lưu ở state, không ở file chương trình. Chưa có nút trong UI (tool/CLI/API có).
- **Trạng thái giai đoạn**: run hủy → `failed` và được chạy lại; run research không đổi file → `delivered`. Bài học "review đã sửa" chỉ lấy vòng sửa gần nhất của mỗi review group (`priorReviewerOutputs`).
- **`planStepCriteria`** chỉ bật cho flow mới tạo từ mẫu Dev (editor, `draftFlow`), không bật trong template Dev có sẵn để run Dev chưa lưu thành flow project giữ tiêu chí cũ. Flow Studio có checkbox.
- **Rules trong `configurationHash`** chỉ khi project có rule (preview cũ vẫn khớp).
- **Ngân sách token** kiểm **giữa các bước** (lượt agent đang chạy được ghi xong; một bước dài có thể vượt). Sự kiện journal mới `runtime_tokens_extended`; `extend_time` nhận `seconds` và/hoặc `tokens`.
- **`assess` + thống kê**: chỉ xếp hạng các phương án khác và thêm lý do; không tự đổi flow đã chọn theo quy tắc. CLI `assess` vẫn chỉ dùng quy tắc (không mở RunManager để tránh tạo state cho thư mục bất kỳ); tool/API có thống kê.
- **Chi phí**: giá theo model của binding đã chạy từng session; thiếu giá một model thì cả run không có chi phí. Token ghi cache (Claude) chưa tính giá riêng.
- **README** bị chuẩn hóa line ending CRLF/LF lẫn lộn sang LF trong `c24e4a8` (diff lớn nhưng nội dung chỉ thêm mục mới). Các file CRLF khác giữ nguyên.
- Gói 1: `diffFlows` so cả khóa `limits` có/không có (`maxTokens`), `after` có thể `null`.

## Việc còn lại / cần người dùng quyết

1. Có tắt việc Codex tự đọc `AGENTS.md` để hai runner chỉ nhận `rules.md` tường minh? (Câu hỏi cũ từ [định hướng 11/2026 §1.1](direction-2026-11.md), chưa chốt; hiện giữ nguyên.)
2. `assess` có nên tự chọn flow có tỷ lệ giao cao hơn khi đủ thống kê, hay chỉ gợi ý như hiện tại?
3. Chưa cài extension và kiểm panel thật trong Nimbalyst với các tool mới (`skills`, `profile_*`, `program_*`, `stats`, `extend_time.tokens`); chưa chạy run thật nào cho các tính năng Gói 2–5.
4. UI: nút "Đánh dấu đã giao" cho giai đoạn chương trình; tạo chương trình từ giao diện (hiện chỉ tool/CLI/API); màn thống kê riêng (hiện dùng CLI/tool, UI chỉ dùng cho ước tính).
5. Lệnh `/neomind:run` (`extensions/nimbalyst/claude-plugin/commands/run.md`) chưa hướng dẫn dùng `program_*`/`stats`.
6. Gộp branch `feat/neomind-upgrade` vào `hieu/adaptive-agent-flow` hoặc `main`: người dùng quyết.

## Bài học kỹ thuật

- Trên Windows, sửa file bằng Python phải đọc/ghi với `newline=''`; `open()` mặc định đổi CRLF → LF. `sed -i` của Git Bash cũng đổi file CRLF thành LF. Kiểm bằng `git ls-files --eol`.
- Python heredoc: `'\\n'` trong chuỗi thường thành ký tự xuống dòng trong file đích khi đi qua nhiều lớp quote; dùng `chr(92)` hoặc Edit tool.
- Edge headless `--screenshot` hay chụp sớm hoặc ghi file trễ; script CDP chờ đến khi trang có đoạn chữ cần thấy rồi mới chụp (`Runtime.evaluate` + `Page.captureScreenshot`) ổn định hơn.
- FakeRunner báo usage cộng dồn theo session dùng chung giữa các runner của cùng factory (plan và implement chung session group), giống runner thật; nếu đếm theo từng runner, recovery coi là usage reset.
