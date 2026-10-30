# NeoMind

NeoMind cấu hình và chạy agent flows, với kế hoạch cần duyệt, kiểm tra độc lập và memory dùng chung theo project.

Hiện đã chạy end-to-end trong worktree riêng (khảo sát → duyệt kế hoạch → thực hiện → checks → review → commit local) với **Codex và Claude Code**, trên Windows native (xem [Windows](START-HERE-WINDOWS.md)); trên Linux mới kiểm chứng đường Codex (29/10). Có flow Fast, Research, Dev song song, xem agent làm gì theo thời gian thực, và [extension Nimbalyst](docs/adaptive-agent-flow/nimbalyst-extension.md) để start flow từ mọi session. Đây là bản đang phát triển.

Người (hoặc agent) mới tiếp tục phát triển: đọc [AGENTS.md](AGENTS.md), rồi [bàn giao 30/10/2026](docs/adaptive-agent-flow/session-handoff-2026-10-30.md) và [tiến độ hiện tại](docs/adaptive-agent-flow/implementation-status.md). [Thiết kế v1](docs/adaptive-agent-flow/design-v1.md) vẫn là phạm vi mục tiêu.

## Chạy Flow Studio

Cần Node >=22.16, Codex CLI đã đăng nhập và một cơ chế worker scope: Linux user-systemd, hoặc Windows job objects (cần .NET Framework 4 có sẵn trên Windows 10/11 để biên dịch helper lần đầu). Runtime đã được thử với Node 22.22.1 và Codex CLI 0.165.0 trên Linux; Node 24.18.0 và Codex CLI 0.160.1 trên Windows 11.

```bash
npm ci
npm test
npm run build:ui
npm run neomind -- editor /absolute/path/to/project
```

Mở URL localhost được in ra. Editor hỗ trợ canvas kéo thả, flow/profile drafts và versions, model/reasoning, theo dõi run, duyệt kế hoạch, yêu cầu sửa kế hoạch, pause/resume/cancel, thử lại Git, memory và duyệt lessons. Publish flow trước khi chạy bản chỉnh sửa. Preview hiển thị cấu hình thực tế và chặn graph chưa được executor hỗ trợ.

Mặc định standalone dùng `gpt-6-luna` reasoning `low`; có thể chọn `gpt-6.1-sol` hoặc `gpt-6.1-terra` khi runner cung cấp. Không tự chuyển model ngoài danh sách fallback đã cấu hình. Chạy thật sử dụng quota tài khoản Codex.

## Dùng Claude Code làm runner

> Đã chạy thật trên Windows tới commit: Claude viết + Codex review, toàn Claude, crash giữa lượt viết rồi resume, và một run điều khiển hoàn toàn qua UI. Linux chưa chạy. Chi tiết: [claude-code-runner.md](docs/adaptive-agent-flow/claude-code-runner.md).

**Cần có**
- Claude Code CLI đã cài (`claude --version`) và đã đăng nhập: `claude auth status` báo logged in.
- Codex CLI vẫn cần: checks luôn chạy qua sandbox của Codex, kể cả khi mọi binding dùng Claude Code. Preview báo lỗi nếu thiếu Codex.

**Chọn runner và model**
- Khi chạy: trong *Xem cấu hình thực tế*, mỗi binding có ô *Runner* (Codex hoặc Claude Code). Đổi runner sẽ đặt model về mặc định của runner đó; bấm *Cập nhật cấu hình* trước khi bắt đầu.
- Trong flow editor: ô *Runner* của binding có *Kế thừa*, *Codex*, *Claude Code*. Khi provider/model đang ghim, đổi runner sẽ chuyển chúng sang giá trị của runner mới.
- Model cho phép: Codex `gpt-6-luna` (mặc định), `gpt-6.1-terra`, `gpt-6.1-sol`; Claude Code `claude-sonnet-5-5` (mặc định), `claude-haiku-5-5`, `claude-opus-5-5`. Mức suy luận: `low`, `medium`, `high`.
- Theo dõi run hiển thị runner và model thực tế của từng bước.

**Giới hạn được áp dụng**
- Writer chỉ có Read/Glob/Grep/Write/Edit; Write/Edit chỉ được phép trong các thư mục ghi đã duyệt. Writer **không có shell**.
- Planner, research và reviewer chỉ đọc.
- Không có sub-agent (Task), MCP, web; settings và CLAUDE.md của user/project bị bỏ qua.
- Model, công cụ và quyền thực tế được đối chiếu ở mỗi lượt; sai lệch thì lượt bị hủy.

Đây là giới hạn do Claude Code tự áp dụng, **không phải sandbox của hệ điều hành** như sandbox Codex. Process vẫn chạy trong worker scope (job object/systemd) để dừng được chắc chắn.

## Flow có sẵn

| Flow | Các bước | Kết quả |
| --- | --- | --- |
| **Dev** | Plan → bạn duyệt → Implement → checks + agent review độc lập (tối đa 2 vòng sửa) → commit local | Commit trong worktree của run; lấy về bằng `git cherry-pick` |
| **Fast** | Plan nhanh (suy luận thấp) → NeoMind tự duyệt → Implement | Không checks, không agent review, không commit. Bạn xem thay đổi rồi bấm **Áp dụng vào checkout** (hoặc `run apply <project> <run-id>`): file được chép vào checkout, chưa stage, chưa commit; từ chối nếu file đó trong checkout đang có thay đổi |
| **Dev song song** | Plan chia 2 gói → bạn duyệt → 2 agent code song song → ghép (agent tích hợp xử lý xung đột) → review → commit | Commit |
| **Research** | Agent chỉ đọc, viết báo cáo có nguồn → agent review nguồn | Báo cáo, không sửa file |

Fast dùng hai ngoại lệ do flow khai báo: bước duyệt tự động (`mode: "auto"`) và review do người (`review: "human"`). Project có thể cấm bằng `"allowAutoApproval": false` hoặc `"allowHumanReview": false` trong policy của `neomind/project.json`; khi đó Fast không qua kiểm tra flow. Preview ghi rõ các ngoại lệ trước khi chạy.

## Sửa flow bằng canvas (Nimbalyst, Obsidian)

Flow lưu theo schema của NeoMind; canvas trong Flow studio dùng React Flow. Để xem và sửa flow trên canvas của Nimbalyst hoặc Obsidian, xuất flow ra file JSON Canvas 1.0 rồi nhập lại:

- Flow studio › **Quản lý** › **Xuất ra .canvas** ghi `neomind/flows/<flow>/flow.canvas` (lưu nháp trước nếu còn thay đổi). **Nhập từ .canvas** áp board vào bản nháp.
- CLI: `npm run neomind -- flow canvas export <project>/neomind/flows <flow> [file.canvas]` và `... flow canvas import ...`.

Trên board, mỗi thẻ là một **bước** của flow, không phải một agent: dòng 1 là tên bước, dòng 2 là loại bước và ai làm (ví dụ `Agent task · Agent sửa code`, `Duyệt · Bạn duyệt`, `Vòng sửa · NeoMind điều phối sửa lại`), dòng 3 là runner/model thật mà bước dùng, tính theo `neomind/project.json`. Màu theo người làm: cam là agent, tím là agent review độc lập, vàng là bạn duyệt, xanh lá là NeoMind tự làm; có ô chú giải ở góc board. Mũi tên `↺` (Review chưa đạt quay lại bước viết code) chỉ để minh họa vòng sửa và bị bỏ qua khi nhập. Sửa được: kéo thẻ, đổi tên, đổi loại, xóa thẻ, thêm thẻ mới (dòng 2 ghi loại bước), nối mũi tên với nhãn là kết quả (`pass`, `needs_changes`, `blocked`, `true`, `false`; để trống là `completed`). Thẻ không ghi loại bước, nhóm, file và link là ghi chú và được bỏ qua.

Cấu hình chi tiết của bước (goal, quyền, reviewer, runner/model) vẫn sửa trong Flow studio. Board mang bản sao cấu hình trong khóa `x-neomind`, nhưng khi nhập, cấu hình lấy theo bản nháp hiện tại cho mọi bước còn tồn tại, nên editor canvas có bỏ khóa lạ cũng không mất dữ liệu. Nhập kiểm tra cấu trúc flow, từ chối board của flow khác, báo khi bản nháp đã đổi sau lần xuất, và chỉ ghi nếu bản nháp không bị sửa trong lúc nhập. Bước mới nhận cấu hình mặc định như khi thêm từ Flow studio.

## CLI cơ bản

Thay đường dẫn ví dụ bằng project Git thực tế:

```bash
npm run neomind -- run preview /absolute/path/to/project dev
npm run neomind -- run start /absolute/path/to/project dev "Mô tả task"
npm run neomind -- run list /absolute/path/to/project
npm run neomind -- run show /absolute/path/to/project RUN_ID
npm run neomind -- run approve /absolute/path/to/project RUN_ID --plan-hash PLAN_HASH
npm run neomind -- run resume /absolute/path/to/project RUN_ID
npm run neomind -- run changes /absolute/path/to/project RUN_ID --plan-hash PLAN_HASH "Yêu cầu sửa kế hoạch"
npm run neomind -- run retry-git /absolute/path/to/project RUN_ID
npm run neomind -- run extend-time /absolute/path/to/project RUN_ID 600
npm run neomind -- run start /absolute/path/to/project dev "Mô tả task" --import-dirty DIRTY_HASH
npm run neomind -- run include-imported /absolute/path/to/project RUN_ID
npm run neomind -- run clean /absolute/path/to/project RUN_ID [--force]
npm run neomind -- run clean /absolute/path/to/project --all [--force]
```

**Dọn worktree.** Mỗi run làm việc trong một Git worktree riêng dưới thư mục state. NeoMind tự xóa worktree khi kết quả đã nằm ở chỗ khác: run có commit (commit được giữ ở `refs/neomind/<run-id>/delivery/<bước>` trước khi xóa, nên `git cherry-pick` vẫn dùng được), run Fast sau khi **Áp dụng vào checkout**, và run chỉ đọc. Run còn thay đổi chưa áp dụng hoặc chưa commit (Fast chưa áp dụng, run bị hủy giữa chừng) thì giữ worktree; `run clean` từ chối và liệt kê các file đó, thêm `--force` để vẫn dọn. `--all` dọn mọi run đã xong và báo run nào được giữ lại (thoát mã 1 nếu có). Trong editor: nút **Dọn worktree** ở *Chi tiết kỹ thuật* của run (hỏi lại trước khi bỏ thay đổi) và **Dọn worktree run đã xong** trong cột lịch sử. Muốn giữ worktree sau khi run giao kết quả, đặt `"keepRunWorktrees": true` trong policy của `neomind/project.json`. Journal và transcript của run luôn được giữ.

`DIRTY_HASH` là `dirtyImport.baselineHash` trong `run preview`: các thay đổi chưa commit được chép vào worktree của run làm input, checkout của bạn không bị sửa, và commit chỉ chứa phần do run làm. Khi thay đổi của run không tách được khỏi thay đổi có sẵn, run dừng chờ `include-imported` (commit cả hai) hoặc bạn tự xử lý.

`PLAN_HASH` lấy từ `proposedPlanHash` của `run show`. Lệnh sai cú pháp thoát với mã 2 và không mở state. Chỉ một process được sở hữu scheduler của mỗi run; không điều khiển đồng thời run đang được editor sở hữu từ CLI.

Ctrl+C/SIGTERM (Windows: Ctrl+C, Ctrl+Break, đóng console) với `run …` hoặc `editor` sẽ tạm dừng các run mà process đó sở hữu và chỉ thoát sau khi xác nhận worker đã dừng; worker chưa xác nhận làm workspace bị quarantine. Nhấn lần nữa để thoát ngay; khi `run resume`, worker còn sót được dừng và đối chiếu trước khi chạy tiếp.

## Xem agent đang làm gì

Màn theo dõi run có khung **Hoạt động trực tiếp** khi agent đang chạy: tin nhắn, file đọc, file sửa (kèm diff), lệnh chạy (kèm exit code và output). Hai agent hiện cạnh nhau, agent thứ ba trở đi thu thành một dòng và mở ra khi cần. Khi bước xong, luồng thu lại thành một dòng tóm tắt (file đã sửa, số lệnh, tokens) trong khung **Session của agent**; bấm **Xem session** để mở toàn bộ lượt đó, kể cả các lượt trước của cùng bước.

NeoMind tự ghi transcript này trong lúc chạy, cho cả Codex và Claude Code, vào `runs/<run-id>/transcripts/<attempt-id>.jsonl` trong thư mục state của project. Mỗi mục bị giới hạn: output lệnh giữ 200 dòng cuối, nội dung file đọc giữ 60 dòng đầu, suy luận chỉ giữ phần tóm tắt, mỗi file transcript tối đa 8 MB. Trong ngăn **Xem session** có thể chuyển sang **Session gốc của runner** để đọc lại cùng lượt từ lịch sử của Codex (qua app-server) hoặc Claude Code (file session); run tạo trước khi có transcript chỉ xem được theo cách này. Chỗ thiếu dữ liệu được ghi rõ (lượt bị dừng, bản ghi cắt ngang, runner đã dọn session).

Chỉ xem: không gửi chỉ dẫn giữa lượt và không tiếp tục session từ UI, vì agent khi đó sẽ chạy ngoài journal và ngoài giới hạn quyền của run. Transcript có thể chứa nội dung file và output lệnh, nên chỉ được phục vụ qua editor local.

## Dữ liệu và giới hạn

Dữ liệu NeoMind của project nằm trong thư mục `neomind/` (không có dấu chấm, nên Obsidian và các công cụ ẩn thư mục chấm vẫn thấy): flow ở `neomind/flows`, profile ở `neomind/profiles`, cấu hình tùy chọn ở `neomind/project.json`, memory mặc định ở `neomind/memory`. Project cũ dùng `.neomind/` vẫn chạy; chuyển bằng `npm run neomind -- project migrate <project>` rồi commit (Git nhận là đổi tên). Nếu project đã có thư mục `neomind/` của riêng nó (ví dụ package tên neomind), NeoMind dùng `.neomind/` để không lẫn. Journal, coordination SQLite và worktrees nằm dưới `${XDG_STATE_HOME:-~/.local/state}/neomind/<project-key>` (Windows: `%LOCALAPPDATA%\neomind\<project-key>`, trừ khi đặt `XDG_STATE_HOME`). Các linked worktrees dùng identity Git common directory chung.

Memory Markdown độc lập với frontend. UI cho cấu hình root, ghi context/quyết định với receipt và duyệt lesson trước khi chia sẻ. Revision và nội dung memory được ghim trong từng run; root không khả dụng sẽ báo lỗi. Nimbalyst adapter chưa được triển khai.

Executor chạy trong worktree riêng: một writer, hoặc các writer trong nhánh fork (mỗi nhánh một worktree, gộp bởi bước integration). Reviewer và các nhánh chạy song song trong giới hạn cấu hình; commit nội bộ của nhánh nằm trên `refs/neomind/<run>/…`, không đụng nhánh của bạn. Commit local dùng `commit-tree` và cập nhật ref có kiểm tra baseline, **không chạy Git hooks**. Flow không tự push hoặc tạo PR. Xem bàn giao để biết giới hạn recovery, Git và acceptance còn lại.
