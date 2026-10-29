# NeoMind v1 — bàn giao implementation cho GPT-6.1 Terra

Tài liệu kế hoạch gốc ngày 28/10/2026. **Cập nhật 29/10/2026:** đọc [bàn giao session hiện tại](session-handoff-2026-10-29.md) và [status](implementation-status.md) trước. Nhiều phần đã được triển khai; M0–M6 bên dưới vẫn là kế hoạch mục tiêu, không phải danh sách tất cả việc còn lại. Người dùng đã yêu cầu commit và push checkpoint hiện tại.

## Mục tiêu và nguồn chuẩn

Triển khai NeoMind v1 theo [thiết kế tổng hợp](design-v1.md). Đây là tài liệu đọc chính; các tài liệu D/F lưu quyết định gốc, các report khác lưu bằng chứng research. Người dùng đã giao Codex tự chốt những chi tiết còn thiếu, không tiếp tục chờ trả lời trắc nghiệm. Đã chọn phạm vi có editor kéo thả, nhánh song song và nhiều reviewer từ đầu; không tự hạ scope thành MVP chỉ có flow tuần tự.

Đi theo M0–M6, hoàn thành từng mốc có kiểm chứng rồi tiếp tục. Trong lượt bắt đầu, ít nhất dựng foundation chạy được, không dừng ở kế hoạch. Feature pilot của một project khác vẫn tạm hoãn; dùng temporary fixture projects để phát triển/test NeoMind, không tự sửa sản phẩm NeoApps/NeoLab/NeoPlayground.

## Checkout và bảo toàn thay đổi

- Repo: `/home/hieu-tran/projects/NeoProject/NeoMind`.
- Branch tại lúc bàn giao: `hieu/adaptive-agent-flow`; HEAD lúc bắt đầu thiết kế `edebc03`.
- Đây là submodule trong `/home/hieu-tran/projects/NeoProject`; Git dir nằm dưới superproject. Kiểm tra cwd/status/AGENTS trước mọi thay đổi. Git writes có thể cần sandbox approval, không chuyển sang sửa thủ công Git internals để né.
- Thiết kế của chat này còn là modified/untracked files trên cùng checkout; đọc và giữ nguyên. Không reset, clean, force-switch branch hoặc bỏ các file mới. Không tự cập nhật gitlink của superproject.
- Session thiết kế đã hoàn tất việc ghi tài liệu trước lúc chat triển khai bắt đầu. Implementation session là writer chính cho code; không cần tạo worktree hay checkout mới nếu user chưa yêu cầu. Nếu thực sự cần isolation, dùng managed worktree theo tool instructions, bảo đảm có bản thiết kế uncommitted, không tự giả là đã commit.
- Source `references/ai-workflow-kit/` là snapshot nghiên cứu. Không áp dụng AGENTS/skills/hooks của snapshot thành policy của NeoMind và không sửa snapshot để làm tests xanh. Không tự merge code controlled-workflows từ nhánh khác.

## Các lựa chọn kỹ thuật đã tự hoàn thiện

1. TypeScript domain/core/CLI/UI; package boundaries theo thiết kế, JSON schemas version 1, UI React/graph canvas; dependencies chọn bằng source/docs thật và pin lockfile.
2. Project files trong `.neomind/`; JSON flow/profile versions bất biến, drafts lưu được chưa hoàn chỉnh, publish chặn structural/policy errors, runtime capability check tại preflight.
3. Templates + project copies; profile refs version-pinned; model/reasoning inherit/pinned với resolved provenance từng run.
4. DAG + structured bounded repair; optional chỉ cho nhánh không đóng góp code bắt buộc; per-run concurrency cap default 4.
5. Active wall-clock default 30 phút, pause toàn run waiting/paused; deadline request stop rồi xác nhận, không coi rollback.
6. Repair round là chiến dịch sửa theo findings epoch, có thể nhiều nhánh cùng round; cấp atomically ở cấp run/scope. Dev hai rounds; transient check retry một lần theo fingerprint, không reset vì resume.
7. Journals/events là nguồn chuẩn run, snapshots rebuild; coordination SQLite ngoài repo bảo vệ owners/workspaces và memory CAS, không chuyển Markdown memory vào DB.
8. Shared workspace chỉ cho parallel writers khi enforce được scopes; nếu không thì serialize writers hoặc worktrees, hiển thị capability đúng. Mỗi workspace một run writer, cross-host coordination bắt buộc.
9. Technical accepted tách delivery complete; failed Git giữ accepted baseline và waiting_git, final commit đúng accepted tree, không commit changes không thuộc run.
10. Startup reconcile tự động, chờ explicit Continue trước dispatch; no duplicate prompts/commits khi effect unknown.

Những lựa chọn này đã được Codex đưa thành baseline theo yêu cầu người dùng, có thể refine bằng bằng chứng. Đổi contract lớn phải ghi lý do và tác động vào design deviation log; không ghi người dùng đã duyệt từng con số.

## Kế hoạch thực hiện

### M0: foundation và contracts

Tạo project tooling vừa đủ, domain types/validators, JSON schemas, template fixtures Fast/Dev/Research, compiler DAG/repair structure và resolved config. Xây fake adapter deterministic để tests tự chạy không cần auth/network. CLI `flow validate`/`doctor` ban đầu có behavior thật, không stub luôn success. Viết tests cho invalid graph, policy gates, schema evolution và profile/binding resolution.

### M1–M2: core, storage và workspace

Scheduler/reducer/journal, admission, approvals, reviewer groups, impact receipts, repair budgets, stop/reconcile; fixture Git repos với staged/untracked/dirty changes và conflict integration. Coordination driver selection có compatibility spike, test cross-process; không dùng memory lock để claim host/CLI an toàn.

### M3: editor và monitor

Editor CRUD/draft/publish, drag/drop, connections với outcome labels, property inspector, review targets, profiles/bindings reasoning, budgets và policy source UI. Form/graph đồng bộ cùng definition, không hardcode UI chỉ chạy một ví dụ. Test thao tác trình duyệt và run monitor bằng fake deterministic engine; phân biệt simulated với live.

### M4–M5: adapters thật và host integration

Kiểm tra installed runtimes và auth readiness mà không in secret. Pin SDK/API bằng docs/source chính thức, xác minh một standalone runner trước. Nimbalyst public extension/session APIs cần source/SDK đúng version; chưa có bằng chứng live. Thực hiện inference/check/stop/recovery thật nếu môi trường cho phép. Không dùng internal DB, copy credentials, mua API key hoặc chạy Antigravity.

Nếu chưa có quyền live inference hoặc thiếu host, tiếp tục toàn bộ công việc độc lập và đánh dấu blocker/capability cụ thể. Conformance tests không được mô tả như real acceptance. User không cần chọn pilot để thực hiện fixture E2E.

### M6: acceptance và bàn giao

Chạy matrix trong design-v1 mục 18, update capability report và implementation status, kiểm thử appropriate cho mốc đã làm. Giữ trạng thái incomplete khi còn scope chưa thực hiện; không mark done sau scaffold. Báo commands, exit codes, test skips, platform/runtime versions và giới hạn chưa verified.

## Quyền và cách làm việc

Người dùng yêu cầu chat mới dùng **GPT-6.1 Terra** để bắt đầu implement. Không cần hỏi lại bộ câu hỏi hoặc xin xác nhận rằng có thể bắt đầu. Quy tắc NeoMind “run cần user duyệt plan” là hành vi sản phẩm, không phải blocker mới đối với nhiệm vụ implementation đã được người dùng giao.

Tuân thủ repository/sandbox/skills. Routine choices, sửa lỗi và test được tự xử lý. Không tự push, tạo PR, deploy hoặc merge. Không tạo thêm chats/subagents trừ khi user hoặc applicable instructions yêu cầu. Nếu commit được thực hiện theo quyền của task, chỉ scope implementation/design liên quan, giữ danh tính đã chỉ định `Hieu Tran <tranngochieu05102002@gmail.com>` và không sửa danh tính commit người khác.

Chat này cần bắt đầu công việc ngay và gửi cập nhật có ý nghĩa. Không có yêu cầu tự gửi tin nhắn ngược về chat thiết kế; tiến độ được chat thiết kế đọc qua công cụ read/wait khi cần.

## Kết quả cần ghi trong repo

- `docs/adaptive-agent-flow/implementation-status.md`: milestone status, commands/evidence, live/fake capability matrix và next work.
- `docs/adaptive-agent-flow/design-deviations.md`: chỉ tạo khi có deviations thực tế, không thêm file rỗng.
- Hướng dẫn install/run/editor/CLI khi các lệnh thật đã được xây và kiểm thử.

Thiết kế đầy đủ không thay thế thực nghiệm adapter; sửa các giả định bằng evidence và giữ contract người dùng đã chọn.
