# NeoMind v1 — trạng thái implementation

Cập nhật: **11/11/2026**. Branch: `hieu/adaptive-agent-flow`. Bàn giao: [11/11 khôi phục MCP, chạy lại flow, OpenCode](session-handoff-2026-11-11.md).

## Tự cài skill soạn flow, `neomind init` — 12/11/2026

Branch `feat/project-init` (worktree `../test_workflow_worktrees/project-init`).

- **Skill đóng gói:** nội dung `.claude/skills/neomind-flow-authoring/SKILL.md` được sinh thành hằng số `src/storage/project-guide-skill.ts` (`node scripts/sync-project-guide.mjs`), nên có trong `dist/` và bundle backend của extension mà không cần file ngoài. Test so khớp hai bản.
- **`installProjectGuide(root, { force })`** (`src/storage/project-guide.ts`): ghi `.claude/skills/neomind-flow-authoring/SKILL.md`, trả `created | up-to-date | modified-kept | replaced`. Không đi qua symlink; tạo mới bằng file tạm + hard link (không bao giờ đè file vừa xuất hiện), `force` thay bằng rename. Bản CRLF của cùng nội dung tính là `up-to-date`. Viết đồng bộ để dùng được cả ở đường memory đồng bộ.
- **Tự cài một lần:** `projectDirCreated` được gọi ở mọi chỗ ghi tạo `neomind/` (hoặc `.neomind/`): tạo flow, agent, skill, chương trình, cấu hình memory selection, `configureMemory` và memory mặc định (`resolveDefaultMemoryRoot(…, true)`). Chỉ cài khi chính lần ghi đó tạo thư mục metadata; đọc/preview không ghi gì; lỗi cài chỉ `console.warn`.
- **`neomind init <project> [--force]`** (`src/runtime/project-init.ts`): tạo thư mục metadata, `project.json` = giá trị `readProject` trả khi thiếu file (dưới cùng lock với `writeMemorySelection`), cài skill; in từng mục đã tạo/giữ nguyên. API `POST /api/project/init`, tool session `project_init` (`force` cần `confirmed: true`). Chưa thêm nút trong UI.

Kiểm chứng Windows (12/11/2026): `npm test` 295 test: 293 pass, 0 fail, 2 skip; `test/project-guide.test.ts` 6 test mới (bản đóng gói = bản trong repo; ghi flow đầu tiên cài một lần, đọc không cài, xóa rồi không cài lại; file đã có được giữ, CRLF; đường memory; `init` idempotent, `--force`, giữ `project.json` và `.neomind/` cũ; API, tool session, CLI). `tsc` UI, `npm run build:ui`, build extension đạt (bundle backend chứa skill và `project_init`). Chưa kiểm chứng: Linux, cài extension vào Nimbalyst.

## Memory đọc được và rút gọn lesson cũ — 12/11/2026

Branch `fix/memory-readable` (worktree `../test_workflow_worktrees/memory-readable`, từ `fbe4f4b`). Người dùng báo trên `leetcode-practice`: hàng đợi đề xuất và lesson đã duyệt hiện khối JSON thô hàng nghìn ký tự; ba lesson 6.8–8.7 KB chiếm gần hết ngân sách memory 16 KB của prompt; scope ghi project id.

- **Body ngắn** (`src/memory/lesson-body.ts`, thuần, UI dùng chung): lesson từ vòng sửa = `Giữ đúng tiêu chí review: <criterion>` / `Vấn đề: <explanation ≤ 400>` / `Đã sửa trong run <run> (bước <node>). File: path:line` (hoặc `Tham chiếu: kết quả bước …`), tối đa 800 ký tự, scope `project`, `origin: 'repair'` + `reason`. Finding lấy từ reviewer output đã yêu cầu vòng sửa (`repairedFinding`: output `needs_changes` cuối cùng trước `repair_round_started` có finding đó), nguồn `run:<id>/event:<seq>` trỏ đúng event. Đề xuất từ yêu cầu sửa plan, rule vi phạm, run bị chặn cũng thành dòng tiêu đề + vài dòng. `memory_propose` của AI session: tối đa 1500 ký tự (mô tả tool nói rõ). Bản ghi cũ scope project id vẫn được coi là toàn project khi chọn memory theo path/scope.
- **Rút gọn bản cũ:** `RunManager.compactMemory({ dryRun, target })`, CLI `neomind memory compact <project> [--dry-run]` (in trước/sau), API `POST /api/memory/compact`. Chỉ đụng body bắt đầu bằng `Review finding corrected in run …`; finding lấy từ JSON nhúng (kể cả JSON bị cắt giữa chừng), nếu bị cắt mất thì đọc journal của run nguồn. Bản ghi đã duyệt: revision mới qua `writeMemory` (file audit `memory-actions`), giữ sources + `compacted`, scope project id → `project`. Đề xuất chờ duyệt: revision mới của nội dung. Không khớp mẫu thì bỏ qua và báo lý do.
- **Giao diện:** `ui/src/MemoryBody.tsx` (tiêu đề = dòng đầu, 2–3 dòng xem trước, "Xem đầy đủ" chỉ hiện khi bị cắt thật, JSON gấp lại và in đẹp, thông báo mẫu cũ + **Rút gọn** có xem trước bản ngắn qua dry-run, link **Mở run nguồn**). Áp cho hàng đợi đề xuất, bảng bản ghi (cột tiêu đề, badge "Mẫu cũ · N ký tự"), sheet chi tiết, "Đề xuất memory" của run và "Memory đã dùng" (xem trước body đã ghim). "Mở run nguồn" mở chi tiết run trong sheet (`SourceRunSheet` dùng `RunMonitor`) vì không sửa `RunPanel` (session khác đang làm). Gallery: đề xuất/bản ghi kiểu cũ và kiểu mới, hash `full`, `compact`, `shortened`, `records`, `detail`.

Kiểm chứng Windows (fake runner, không run thật): `test/memory-compact.test.ts` 4 test mới (rút gọn từ JSON đủ/bị cắt/mất finding + journal, helper UI, compact qua API và manager với dry-run không ghi, giữ bản ghi khác, chạy lại không đổi gì, giới hạn đề xuất AI), test vòng sửa trong `local-run.test.ts` kiểm body/scope/sources mới, `memory-flow.test.ts` kiểm body ba nguồn khác. CLI `memory propose/approve/compact --dry-run/compact` trên repo tạm (state riêng qua `XDG_STATE_HOME`): 3662 → 650 byte, lần hai không còn gì. Hàm rút gọn chạy chỉ-đọc trên ba lesson của `leetcode-practice`: 7695 → 515 và 7695 → 292 ký tự từ JSON nhúng, 6004 → dưới 800 ký tự từ journal run nguồn (finding F2 nằm ngoài 5000 ký tự đã cắt). `tsc` core + UI, `npm run build:ui`, build extension đạt. `npm test` đầy đủ (khoảng 4 phút): **293 test, 291 pass, 0 fail, 2 skip**. Ảnh gallery tối/sáng × 1440/900 trang Memory trước/sau, dialog Rút gọn, sau khi rút gọn, sheet chi tiết, "Memory đã dùng". Chưa kiểm trong Nimbalyst thật; chưa chạy `memory compact` trên `leetcode-practice` (để người dùng tự chạy).

## Skills và Agents — 11/11/2026

Mảng A của [plan skills/agents/memory](plan-skills-agents-memory-2026-11-11.md), branch `feat/skills-agents`.

- **Thư viện skill** (`src/storage/skill-library.ts`): tạo/sửa/xóa `neomind/skills/<id>/SKILL.md` (frontmatter `name`, `description` + thân Markdown; giữ các khóa frontmatter khác như `allowed-tools`), sửa có `expectedSha256`, file phụ dạng text (tạo với `expectedSha256: null`, sửa theo sha, xóa và dọn thư mục rỗng), giới hạn 256 KiB, từ chối symlink/junction trên đường tới skill và đường dẫn ra ngoài thư mục skill. Skill `.claude/skills` chỉ đọc; ID trùng với skill Claude không tạo được (bước ghim skill theo ID). `skillUsage` liệt kê agent (draft + phiên bản mới nhất) và bước flow (draft + phiên bản mới nhất, theo `skillsOverride`) đang ghim, kèm cờ ghim cũ. `repinSkill` chỉ sửa draft agent/flow (compare-and-swap theo revision), không publish. `deleteSkill` từ chối skill đang được ghim (`SkillInUse` kèm usage; API trả 409) trừ khi `force`. `skillPromptText` tạo đúng đoạn `LocalRun.prompt` chèn vào prompt (test so khớp với prompt thật của fake runner).
- **Quyền**: `ai.skillEdit?: 'allow' | 'deny'` trong `project.json` (mặc định allow), áp cho request có `author: { kind: 'ai' }` (tool session). Editor và CLI là người dùng.
- **Tool**: `skill_get`, `skill_create`, `skill_update` (kèm `files`, `repin`), `skill_delete` (`confirmed`, `force`), `skill_usage`, `profile_archive`, `profile_delete` (`confirmed`; agent còn flow dùng bị từ chối kèm danh sách). CLI `neomind skill list|get|usage|repin|create|update|delete`, `profile templates|from-template|remove`. API: xem README.
- **Mẫu agent** (`src/domain/profile-templates.ts`): Implementer, Planner, Reviewer độc lập, Reviewer UI, Reviewer bảo mật, Research; mỗi mẫu có hướng dẫn, quyền, skill gợi ý (chỉ ghim skill project đã có cùng ID).
- **Giao diện**: thanh điều hướng Runs · Flows · Agents · Skills · Memory (view id vẫn là `profiles`). Màn Skills: danh sách theo nguồn với số nơi dùng và số ghim cũ, form tên/mô tả/thân, file phụ, nơi dùng, xem đoạn chèn vào prompt, callout "N agent/bước đang ghim bản cũ" + Ghim lại tất cả, xóa có liệt kê nơi dùng ("Vẫn xóa"), dialog Skill mới (mẫu Trống/Checklist review). Màn Agents: dialog mẫu, nút Lưu = lưu draft + publish (tác giả human), callout "Cập nhật các flow" dùng `migrateProfile`, Xóa agent kiểm tra nơi dùng và đề nghị lưu trữ; tab Skills có nút mở màn Skills; "Lưu nháp" chuyển vào menu. Flow Studio: mục Skills ở phần chính inspector cho agent task, từng reviewer, integration có agent, với "Theo agent" (chip mờ skill của phiên bản agent) và "Riêng cho bước này" (`skillsOverride`, bắt đầu từ danh sách của agent); thẻ bước có chip "N skill". Run mới: mỗi bước có dòng "Skill: …" lấy từ `profilesByStep` của preview.
- **Quyết định nhỏ**: thêm `skills` vào danh sách dấu hiệu của `neomind/` trong `project-dir.ts` (nếu không, project mới chỉ có `neomind/skills` sẽ bị coi là thư mục riêng của project và NeoMind chuyển sang `.neomind/`). Không sửa `local-run.ts` để tránh đụng mảng B: định dạng đoạn chèn được nhân bản trong `skillPromptText` và test khóa hai bên phải khớp. Route xóa/lưu trữ agent mới (`/remove`, `/set-archived`) đứng riêng; route cũ `/delete` (xác nhận bằng tên) giữ nguyên cho tương thích.

Kiểm chứng Windows (11/11/2026): `npm test` 281 test: 279 pass, 0 fail, 2 skip (symlink file cần quyền, SIGTERM trên Windows), trong đó `test/skill-library.test.ts` 6 test mới (tạo/sửa/xóa skill, file phụ, symlink, usage + repin + force, mẫu agent và xóa agent đang dùng, tool session theo `ai.skillEdit` và `confirmed`, prompt fake runner nhận skill riêng của bước thay vì skill của agent). `tsc` core + UI, `npm run build:ui`, build extension đạt. CLI `skill create|list|delete`, `profile templates` chạy thử trên project tạm. Ảnh gallery tối/sáng × 1440/900: màn Skills (ghim cũ, file phụ, đoạn prompt, xóa, skill Claude, tạo mới), Agents (dialog mẫu, sau khi Lưu có flow dùng bản cũ, xóa agent đang dùng), inspector agent task (theo agent / riêng) và reviewer, Run mới có skill từng bước. Chưa kiểm chứng: run thật, panel trong Nimbalyst (extension chỉ build, chưa cài), Linux.

## Memory — 11/11/2026

Gộp với mảng A (session điều phối, 11/11): rebase `feat/memory` lên `feat/skills-agents`, giải xung đột chuỗi Usage của CLI, gallery và tài liệu; gắn `StepMemoryField` vào inspector (agent task, từng reviewer, integration) ngay dưới mục Skills. `npm test` đầy đủ trên bản gộp: **289 test, 287 pass, 0 fail, 2 skip**; `tsc` UI đạt; ảnh inspector (agent task tối, reviewer sáng) đã kiểm.

Mảng B của [plan Skills/Agents và Memory](plan-skills-agents-memory-2026-11-11.md), branch `feat/memory` (worktree `../test_workflow_worktrees/memory`), commit `28b810c` (core), `e4d1dd1` (tool/CLI/API), `2297412` (UI) và commit tài liệu.

- **B1 · Bật sẵn:** chưa cấu hình root thì dùng `neomind/memory` trong repo (`resolveDefaultMemoryRoot(…, create)`, `openProjectMemory(…, create)`); đọc khi chưa có thư mục = rỗng, ghi đầu tiên tạo thư mục. Root đã cấu hình vẫn phải tồn tại như trước. `readMemory` trả thêm `location` (đường dẫn, có trong repo/commit cùng repo, đã tồn tại chưa), `stats`, `inactive`.
- **B2 · Tool:** `memory_search`, `memory_get`, `memory_propose`, `memory_pending`, `memory_approve`/`memory_reject` (bắt buộc `confirmed: true`). `LessonProposals` mở rộng cho context/decision/lesson, thêm `origin`, `reason`, `supersedes`, `runId` tùy chọn (đề xuất ngoài run nằm ở `<state>/memory-proposals`). Kiểm trùng theo loại + nội dung chuẩn hóa với bản ghi đã duyệt và đề xuất đang chờ. CLI `neomind memory list|pending|propose|approve|reject|note|expire|delete|feedback|remember`; API `/api/memory/search|records|note|expire|delete|proposals…`, `/api/runs/:id/remember|memory-feedback`.
- **B3 · Tự rút đề xuất** (`src/runtime/memory-proposals.ts`, gọi khi run xong hoặc bị hủy): quyết định từ yêu cầu sửa plan (tối đa 3), lesson cho mỗi rule bị reviewer báo vi phạm, lesson từ lý do run bị chặn (tối đa 2 lý do). Tối đa 8 đề xuất tự động mỗi run, 20 ghi chú "Ghi nhớ điều này" mỗi run; cùng nội dung chỉ đề xuất một lần; hàng đợi gộp đề xuất trùng giữa các run, duyệt/từ chối một bản thì đóng các bản trùng. Lesson từ vòng sửa giữ nguyên như trước.
- **B4 · Memory theo bước:** trường tùy chọn `memory: { types, tags, maxRecords, off }` trên `agent_task`, reviewer và `integration`; flow có `memoryDefaults: "role"` (chỉ `newFlowFromTemplate` đặt, như `planStepCriteria`) cho vai trò plan/read/write → context + decision + lesson (write lọc theo phạm vi plan), review → decision + lesson. Template dựng sẵn và flow cũ nhận khối memory chung như trước. Snapshot của run thêm `tags` và `text` (khối prompt) cho từng bản ghi để bước lọc trên tập đã ghim; run cũ thiếu hai trường này giữ khối chung. `node_input.sources` ghi đúng bản ghi có khối trong prompt của bước.
- **B5 · Đã dùng và đánh giá:** `RunManager.get` trả `memoryUse` (bản ghi mỗi lượt nhận, lý do, bộ lọc của bước, đánh giá). Event journal mới `memory_feedback` (không đổi graph, recovery chấp nhận ở mọi phase; journal cũ không có event này vẫn replay như trước). Tổng hợp trong SQLite điều phối (`memory_usage` theo run, `memory_feedback` theo event id): Hữu ích +1, Không liên quan −1, Sai −3; xếp hạng run sau cộng điểm giới hạn ±5 và không làm bản ghi qua được `requireTaskMatch`.
- **B6 · Trang Memory:** "+ Ghi chú" lưu thẳng (lesson đi qua đề xuất + duyệt ngay để vẫn có biên nhận), sheet sửa inline theo revision (lesson đã duyệt sửa được qua `MemoryStore.update`), Hết hạn, Thay thế bằng…, Xóa có xác nhận (`MemoryStore.remove` từ chối khi bản khác còn thay thế nó; mọi xóa có file audit trong `memory-actions`). Hàng đợi đề xuất Duyệt / Sửa rồi duyệt / Từ chối. Bảng có cột Dùng và Điểm.
- **UI:** `ui/src/MemoryPanel.tsx` viết lại; `ui/src/RunMemory.tsx` (mục "Memory đã dùng" + nút đánh giá + dialog sửa/hết hạn khi "Sai"; nút "Ghi nhớ điều này" ở đầu chi tiết run); `RunLessons` hiện loại, nguồn gốc và lý do của mọi đề xuất, hiện ở mọi phase. `ui/src/StepMemoryField.tsx` là field riêng cho inspector, **chưa gắn vào `App.tsx`** (mảng A sở hữu file đó; session điều phối gắn khi merge). Gallery: `/__gallery/memory.html` (hash `detail`, `edit`, `note`, `review`), `/__gallery/runs.html#completed,memory` và `#completed,remember`, mục "Memory theo bước" trong `/__gallery/`.

Lệch so với plan: lỗi trùng revision khi sửa memory trả HTTP 400 kèm "Memory revision conflict" như các lần ghi memory trước đây, không phải 409. Đề xuất từ run bị chặn chỉ tạo khi run xong hoặc bị hủy (không tạo mỗi lần chặn, để tránh đề xuất từ trạng thái tạm). Số lần dùng đếm theo run đã ghim bản ghi, không theo từng bước.

Kiểm chứng Windows (fake runner, không chạy run thật): `test/memory-flow.test.ts` 8/8 (root mặc định, propose → duyệt → search, gộp trùng, sửa/hết hạn/thay thế/xóa, bước review của flow mới chỉ nhận decision + lesson còn flow cũ nhận cả khối, `node_input.sources` và replay khớp, đề xuất từ yêu cầu sửa plan và "Ghi nhớ điều này", đánh giá đổi thứ tự xếp hạng, giới hạn đề xuất, CLI). `tsc` core và UI, `npm run build:ui`, build extension đạt. `npm test` đầy đủ (khoảng 4 phút 15 giây): **283 test, 281 pass, 0 fail, 2 skip**. Ảnh gallery tối/sáng × 1440/900 đã xem cho trang Memory (hàng đợi, bảng, sheet chi tiết/sửa, dialog ghi chú), "Memory đã dùng" + dialog "Ghi nhớ điều này" trong chi tiết run, và `StepMemoryField` bốn trạng thái. Chưa kiểm trong Nimbalyst thật.

## Xem hoạt động của OpenCode — 11/11/2026

Runner OpenCode có `observe()`: trong lúc chờ lượt chạy, NeoMind đọc `GET /session/:id/message` mỗi giây và ghi vào transcript các phần đã xong (suy luận, tin nhắn, `read`/`glob`/`grep`/`edit`/`write`/`bash` và kết quả của chúng), đọc lần cuối trước khi dừng server. Phần còn đang chạy chỉ hiện khi xong, nên trễ tới khoảng 1 giây. Nút "Session gốc" đọc lại lượt từ session OpenCode qua một server ngắn hạn (ánh xạ id logic → `ses_…` trong session map). Lựa chọn đọc lại theo chu kỳ thay vì luồng SSE `/event` để dùng chung một cách đổi định dạng cho cả xem trực tiếp và lịch sử.

Kiểm chứng Windows: test với server OpenCode giả 8/8 (đổi định dạng, chỉ báo phần đã xong, đọc lịch sử, bỏ tin nhắn kiểm tra `noReply`); test transcript/lịch sử/session tools hiện có 18/18. Đối chiếu OpenCode 1.19.5 thật bằng tin nhắn `noReply` (không gọi model): dạng `{ info: { id, role, time.created }, parts: [{ type: 'text', text }] }` khớp. Chưa xem với một lượt OpenCode thật có gọi tool: tên và tham số tool (`filePath`, `oldString`, `newString`, `command`) lấy từ đặc tả API và chưa đối chiếu bằng run thật.

## OpenCode: sửa vòng lặp ở bước plan/review — 11/11/2026

Hai run Fast thật trên `leetcode-practice` (OpenCode 1.19.5, GPT-6.1 Sol) không xong bước plan: agent lặp read/glob 37–49 lượt (khoảng 1 triệu token cộng dồn) tới khi bị hủy. Nguyên nhân: lượt có `format: json_schema` thì OpenCode thêm tool `StructuredOutput` và bắt gọi tool mỗi lượt, nhưng runner đặt quyền `*: deny` nên chặn luôn tool này; model không nộp được kết quả. Sửa:

- Cho phép `StructuredOutput` trong quyền cấu hình và quyền session.
- Giới hạn `OPENCODE_MAX_STEPS = 60` lượt model mỗi bước; vượt thì bước thất bại với lý do rõ, không tiêu tiếp quota.
- Hoạt động (đọc, tìm, sửa, lệnh, kết quả JSON) lấy từ luồng sự kiện `GET /event`, vì OpenCode 1.19.5 trả HTTP 400 khi liệt kê tin nhắn của session có yêu cầu JSON. Cùng lỗi đó khiến "Xem session gốc" không đọc lại được bước plan/review; giao diện báo rõ.

Kiểm chứng Windows: test OpenCode và runner/admission 14/14. Chạy thật OpenCode 1.19.5 + `gpt-6-luna` (reasoning low) trên repo tạm, một lượt plan có json_schema: xong sau 16,5 giây, kết quả JSON đúng; sự kiện glob → read → structured_output hiện theo thời gian thực.

## Khôi phục phần 07–08/11 — 11/11/2026

Source TypeScript của MCP standalone, chạy lại flow và OpenCode không được commit; bản copy mang về bị cắt ở 30 MiB nên mất `src/`, `test/`, `ui/`. Đã dựng lại từ JavaScript `tsc` biên dịch và `.d.ts` của bản build 08/11: so lại output biên dịch khớp bản gốc (khác thứ tự một khóa và comment). Nút "Chạy lại từ đầu" viết lại theo bundle UI đã minify. README phần MCP viết lại vì README gốc bị mất. `@modelcontextprotocol/sdk` nâng từ 1.29.0 lên 1.32.2 (bản vá cùng major) vì `npm audit` báo lỗ hổng ở HTTP/OAuth; `npm audit` sạch.

OpenCode giữ đúng như bản build theo quyết định người dùng 11/11: runner được đăng ký và bước sửa không cần bằng chứng sandbox.

Cũng 11/11: khôi phục phần chọn OpenCode/Provider ở Run mới và Flow Studio (commit `1aa8f3b`). Người dùng cho phép thêm OpenCode **1.19.5** (bản cài trên máy) bên cạnh 1.18.25; 1.19.5 chưa qua probe đối kháng như 08/11. Kiểm thật không inference trên Windows: `OpenCodeRunnerFactory.models()` với 1.19.5 qua kiểm cấu hình (không MCP, không plugin, quyền khớp, có agent `build`) và trả 53 model của provider `openai`, gồm cả `gpt-6-astra` (OpenCode không lọc theo allowlist model của NeoMind). Người dùng chọn giữ nguyên toàn bộ danh sách model của OpenCode (11/11); ràng buộc không dùng Astra trong `AGENTS.md` áp dụng cho việc chọn model, không phải bộ lọc của giao diện.

Kiểm chứng Windows: `tsc` core/UI, build UI và extension đạt; test khôi phục và test bị ảnh hưởng 24/24. `npm test` đầy đủ (khoảng 5 phút 46 giây): **270 test, 266 pass, 2 fail, 2 skip**. Hai ca lỗi là `after scheduler crash…` (worker giả không khởi động kịp) và `parallel writers run concurrently…` (đỉnh writer 1 thay vì 2); chạy riêng tuần tự đạt 2/2. Cùng nhóm chập chờn đã ghi ở [known-test-failures](known-test-failures-2026-11-07.md) và bàn giao 07/11; không sửa test.

## Chạy lại flow bị chặn — 08/11/2026

Run bị chặn có yêu cầu và flow được ghi nhận có nút **Chạy lại từ đầu**. Nút mở form run mới với yêu cầu và flow cũ; cấu hình được preview lại theo trạng thái hiện tại, không sửa run cũ và không tự duyệt kế hoạch. Các override của run cũ không tự sao chép. Build core, UI và test rerun đạt trên Windows; chi tiết kiểm chứng và khảo sát OpenCode trong [bàn giao 08/11](session-handoff-2026-11-08.md).
Bàn giao hiện tại: [07/11/2026 đồng bộ bản copy và cài extension](session-handoff-2026-11-07.md); [06/11/2026 nâng cấp Gói 1–5](session-handoff-2026-11-06-upgrade.md); [06/11/2026 thiết kế lại](session-handoff-2026-11-06.md); trước đó [04/11/2026 Windows](session-handoff-2026-11-04-windows.md) và [Linux](session-handoff-2026-11-04.md).

## MCP standalone — 07/11/2026

Thêm server MCP stdio theo project qua `neomind mcp <project>`, tái dùng session tools, giữ gate xác nhận và ghi nguồn duyệt là phiên MCP. Khi ngắt kết nối, server chờ các tool đang chạy trước khi đóng RunManager. Cấu hình Codex CLI/Claude Code trong README; không thay đổi quyền MCP của worker trong flow.

Windows: TypeScript build và test MCP stdio/lifecycle 2/2 đạt. Không chạy inference thật; chưa kiểm chứng kết nối trực tiếp từ session Codex/Claude hoặc Linux. `npm ci` chưa kiểm chứng: cache thiếu dependency và truy cập npm bị treo. Kết quả suite và chi tiết xem [bàn giao MCP](session-handoff-2026-11-07-mcp.md).

## Mặc định tắt sandbox Codex — 07/11/2026

Người dùng duyệt tắt cho cả agent Codex và checks. Policy tùy chọn `codexSandbox: "enabled" | "disabled"`; run mới mặc định disabled, ghi mode vào runtime context trước dispatch; run cũ thiếu mode giữ enabled. Adapter kiểm đúng sandbox thực tế ở start/resume; command/exec dùng đúng mode. Admission vẫn kiểm approval, lease, baseline và stop; chỉ bỏ yêu cầu sandbox proof trong mode disabled của Codex, không áp dụng cho Claude. Capability cache tách theo mode; disabled báo sandboxVerified=false, stopVerified=true. Preview UI/tool nêu rõ không còn bảo đảm phạm vi đọc/ghi của OS. Cấu hình không bị tự ghi/migrate.

Kiểm chứng Windows: TypeScript core, UI và extension build đạt; nhóm adapter/check/admission 14/14 pass. Probe thật chỉ metadata/lệnh node --version và dừng tiến trình con qua Job Object đạt, không inference thật. Suite đầy đủ: 262 test, 257 pass, 2 fail, 3 skip; chạy riêng lại hai ca đạt 2/2 nhưng chưa coi là đã sửa. Test resume journal cũ giữ sandbox đạt. Đã cài extension, host báo loaded; cần mở lại workspace. Lỗi được lưu để debug sau trong [tài liệu riêng](known-test-failures-2026-11-07.md). Linux chưa kiểm chứng chế độ mới.

## Fast mặc định cho project chưa cấu hình — 07/11/2026

Theo phương án người dùng đã duyệt, `readProject` mặc định bật `allowAutoApproval` và `allowHumanReview` khi chưa có `project.json`. Không tạo file cấu hình trong lúc đọc/preview, không bổ sung hoặc ghi đè policy của project đã có cấu hình (kể cả khi thiếu hai trường). API validate/canvas import dùng cùng policy với runtime. Compiler và policy nền của template vẫn yêu cầu opt-in cho cấu hình tường minh.

Kiểm chứng Windows: `npm test -- dist/test/fast-flow.test.js` đạt 4/4 (gồm regression project mới, cấu hình cũ và API validate), TypeScript core và build extension đạt. Đã cài lại `local.neomind`; cần mở lại workspace để backend mới có hiệu lực. Suite đầy đủ (build rồi chạy scripts/run-tests.mjs với --test-concurrency=2): 255 tests, 249 pass, 3 fail, 3 skip. Hai lỗi review-impact do fixture không lưu policy của snapshot; đã bổ sung cấu hình fixture, giữ assertions. Ca reviewer đồng thời đạt khi chạy riêng. Chạy lại cả ba ca tuần tự: 3/3 pass. Chưa lặp lại toàn bộ suite sau sửa fixture; source bản cài extension không đổi sau lượt suite. Chi tiết trong bàn giao 07/11.

## Đồng bộ bản copy và cài extension — 07/11/2026

Fast-forward branch hiện tại từ 5404c63 tới 7445ef3, giữ lịch sử 54 commit; có nhánh backup/before-copy-import-2026-11-07. npm ci, build UI và build extension thành công trên Windows. Đã cài lại local.neomind, host báo loaded; backend mới cần mở lại workspace. npm test ngoài sandbox: 254 tests, 247 pass, 3 fail, 1 cancelled do timeout, 3 skip; chưa đạt toàn bộ suite. Chi tiết và chẩn đoán trong [bàn giao](session-handoff-2026-11-07.md).

## Nâng cấp NeoMind · Gói 5 — 06/11/2026

Chi phí và quota. `RunManager.list()` có `tokens`. `src/runtime/run-stats.ts`: `runFacts` từ report (hoàn tất, giao = commit/áp dụng/không đổi file, token, thời gian hoạt động, số vòng sửa, review đạt lượt đầu = review được chấp nhận và không có vòng sửa, profile, runner/model, chi phí), `runStats` nhóm theo flow, profile, runner/model, flow + bộ runner; trung bình/trung vị token, thời gian, chi phí chỉ tính run đã xong. `neomind/pricing.json` tùy chọn (`schemaVersion: 1`, USD/triệu token theo model). `src/domain/estimate.ts` (dùng chung UI): ước tính chỉ khi ≥ 3 run đã xong cùng flow + bộ runner. Ngân sách token: `limits.maxTokens?` (schema flow, override khi start), kiểm ở đầu mỗi vòng `drive()` sau khi các nhánh đang chạy xong lượt, `paused` với lý do "Hết ngân sách token (đã dùng/ngân sách)"; `resume` từ chối khi còn vượt; sự kiện `runtime_tokens_extended` + `RecoveryReport.tokenExtensions`; `extendTime(seconds, tokens)` dùng chung cho tool `extend_time` (`tokens`), API (`{ seconds?, tokens? }`), CLI `run extend-time … [--tokens N]`. CLI `run stats [--flow] [--json|--csv]`, API `GET /api/stats`, tool `stats`. `assess` nhận thống kê (API/tool) để xếp hạng phương án. UI: thanh ngân sách token và gia hạn token trong run, ô ngân sách token ở Run mới › Nâng cao và Flow Studio, ước tính thời gian/token/chi phí ở Run mới; gallery `runs.html#budget`, `#new,price`. `diffFlows` so cả `maxTokens`.

Quyết định nhỏ: kiểm ngân sách giữa các bước (không ngắt lượt agent đang chạy, để kết quả luôn được ghi); `assess` không tự đổi flow theo thống kê, chỉ xếp hạng và thêm lý do; CLI `assess` giữ quy tắc tĩnh (không tạo state cho thư mục bất kỳ); thiếu giá một model thì run không có chi phí. Fake runner có `tokensPerTurn` (usage cộng dồn theo session như runner thật).

| Kiểm chứng Windows | Kết quả |
| --- | --- |
| `npm test` (commit `e33cc11`) | 254 test: 252 pass, 2 skip, 0 fail. `test/run-stats.test.ts`: vượt `maxTokens` → `paused`, `resume` bị từ chối, gia hạn token rồi hoàn tất; thống kê từ journal có `usage_observed` (3 run xong + 1 chờ duyệt), chi phí theo `pricing.json`, ước tính chỉ có khi đủ 3 run, CSV/CLI, tool `stats` và `assess` có thống kê. |
| TypeScript UI, build UI, build extension | Đạt (cả sau `b88559c`); kiểm UI bằng gallery qua Edge headless (CDP). |

## Nâng cấp NeoMind · Gói 4 — 06/11/2026

Rules của project. `src/domain/rules.ts` parse `neomind/rules.md` (`- [R1] …`, mã duy nhất; dòng `#`/trống bỏ qua, dòng khác dạng hoặc trùng mã bỏ kèm cảnh báo). `RunManager.create` ghim `{ hash, rules }` vào `runtimeContext.rules` (chỉ khi có rule); `LocalRun.prompt` đưa khối "Rules của project (bắt buộc…)" vào mọi agent, sau instructions/skills của profile và trước memory; prompt sources thêm loại `rules` (enum `dataSourceSchema`). `reviewRequirements(flow, node, plan, rules)` thêm `Rule R1: …` cho **mọi** review (cả review nhánh) ở cả `LocalRun` và `CodexReviewDispatch`. Preview và tool `preview` trả `rules`/`ruleWarnings`; `flowBlocks` trả `rules`; CLI `rules <project>`, API `GET /api/rules`. UI: mục "Rules của project" trong Run mới (cảnh báo màu hổ phách) và dòng Rules trong phần Kiểm tra của run (Đạt / Vi phạm / Chưa xác nhận / Chưa chấm), gallery `runs.html#completed`, `#new,rulewarn`.

Quyết định nhỏ: `configurationHash` của preview gồm hash rule **chỉ khi** project có rule (preview cũ vẫn khớp, sửa `rules.md` giữa preview và start bị phát hiện như đổi cấu hình). Không có tool sửa `rules.md` (rule do người dùng quyết qua Git). Codex vẫn tự đọc `AGENTS.md` (câu hỏi cũ, chưa chốt; ghi vào bàn giao).

| Kiểm chứng Windows | Kết quả |
| --- | --- |
| `npm test` (commit `812bf0a`) | 251 test: 249 pass, 2 skip, 0 fail. `test/rules.test.ts`: rule có trong prompt planner/writer/reviewer (fake runner), ghim lúc tạo run (sửa file sau đó không đổi run), evidence thiếu `Rule R2` không phủ tiêu chí, project không có `rules.md` chạy như trước. |
| TypeScript UI, build UI, build extension | Đạt; kiểm Run mới và chi tiết run bằng Edge headless (CDP). |

## Nâng cấp NeoMind · Gói 3 — 06/11/2026

Chương trình nhiều giai đoạn. `src/runtime/programs.ts`: file `neomind/programs/<id>.json` (schema `programSchema`, kiểm ID trùng, phụ thuộc không tồn tại, vòng lặp; mọi `flowId` phải là flow project đã publish và chưa lưu trữ hoặc template có sẵn không bị che). Run mang `runtimeContext.programId/phaseId` (tùy chọn) và `RunManager.list()` trả hai trường này. `programStatus` suy ra trạng thái từ run mới nhất của mỗi giai đoạn; `startPhase`/`programNext` chỉ chạy giai đoạn `ready` (hoặc `failed` khi phụ thuộc đã giao, để chạy lại) với task + khối bài học ≤ 4.000 ký tự. Tool `program_create|list|status|next|deliver`; CLI `program create|list|status|next|deliver`; API `/api/programs…`. A3: `review_group.planStepCriteria?` + `planSteps()` trong `review-requirements.ts`; `newFlowFromTemplate('dev')` bật cờ cho flow mới tạo từ editor/`draftFlow`. UI: nhóm "Chương trình" trong danh sách run và sheet chi tiết (`ui/src/RunPrograms.tsx`), gallery `runs.html#completed,programs`.

Quyết định nhỏ (tương thích ngược):
- Thêm trạng thái giao thủ công `program deliver` (tool cần `confirmed: true`) kèm ghi chú: plan nhắc "ghi chú người dùng khi đánh dấu giao" mà chưa có chỗ ghi, và squash/rebase làm `merge-base --is-ancestor` không thấy commit. Đánh dấu lưu ở state (`<state>/programs/<id>.marks.json`), không ở file chương trình, đúng nguyên tắc "trạng thái không lưu trong file".
- Run hoàn tất không có commit và không đổi file (research) được coi là đã giao; run bị hủy → `failed` và có thể chạy lại; run `blocked`/`paused`/`waiting_approval` → `waiting_user`.
- Bài học "review đã needs_changes rồi được sửa" lấy từ `priorReviewerOutputs` của run (vòng sửa gần nhất của mỗi review group), không phải mọi vòng.
- `planStepCriteria` không bật trong template Dev có sẵn (để run Dev chưa lưu thành flow project giữ tiêu chí cũ); chỉ bật khi tạo flow mới từ mẫu Dev.

| Kiểm chứng Windows | Kết quả |
| --- | --- |
| `npm test` (commit `42e3263`) | 247 test: 245 pass, 2 skip, 0 fail. `test/programs.test.ts`: chương trình 3 giai đoạn với fake runner (giai đoạn 2 `blocked_by_dependency` tới khi `git merge --ff-only` commit giai đoạn 1; task giai đoạn 2 chứa phát hiện review đã sửa), `planStepCriteria` thiếu một bước → evidence không phủ tiêu chí. |
| TypeScript UI, build UI, build extension | Đạt; kiểm sheet chương trình bằng Edge headless (sáng/tối). |

## Nâng cấp NeoMind · Gói 2 — 06/11/2026

Skills và profile. `src/storage/skill-catalog.ts` quét `.claude/skills/*/SKILL.md` và `neomind/skills/*/SKILL.md` (frontmatter đọc bằng `yaml`, không theo symlink ra ngoài project), `skillStatus` trả `ok | changed | missing`. `src/runtime/profile-authoring.ts`: đọc profile + phiên bản kèm tác giả, đọc nội dung một phiên bản cũ, tìm flow dùng profile (draft và bản publish mới nhất, kể cả template có sẵn), `migrateProfile` chỉ sửa draft các flow được chọn với compare-and-swap theo revision, `draftProfile`/`publishProfile` theo `ai.profilePublish`. Phiên bản profile thêm `author?` (không nằm trong `contentHash`, giống flow). Prompt dùng nhãn `Skill <name> (<id>):` và liệt kê file phụ của skill. Tool `skills`, `profile_get`, `profile_draft`, `profile_publish`; CLI `skills …`, `profile get|version|skills-status|usage|migrate|author-draft|author-publish`; API `/api/skills`, `/api/skills/status`, `/api/profile-draft`, `/api/profiles/:id/{authoring,skills-status,usage,migrate,versions/:n}`. UI: `SkillPicker` trong Profiles › Skills và inspector Flow Studio › Nâng cao (`skillsOverride`), xem phiên bản chỉ đọc, dialog chuyển flow.

Quyết định nhỏ: thêm dependency `yaml` (frontmatter nhiều dòng); CLI dùng `profile author-draft/author-publish` cho đường AI giống flow; `skillStatus` báo `missing` chỉ khi file không tồn tại, lỗi khác (symlink thoát project) vẫn ném lỗi.

| Kiểm chứng Windows | Kết quả |
| --- | --- |
| `npm test` (commit `266bc41`) | 244 test: 242 pass, 2 skip, 0 fail (~4 phút; `claude-capabilities` gọi Claude CLI ~$0.0019). |
| TypeScript UI, build UI, build extension | Đạt. Gallery `profiles.html#skills` / `#migrate` có trạng thái mẫu `changed`. Không cài extension, không chạy run thật. |

## Nâng cấp NeoMind · Gói 1 — 06/11/2026

Branch `feat/neomind-upgrade`: thêm core tạo/lấy/kiểm/publish flow, diff cấu trúc và `assess`; session tools, CLI và editor API dùng cùng core. Metadata phiên bản ghi tác giả AI/human (bản cũ coi là human); UI hiện badge AI và tác giả/lý do trong so sánh. Compiler giữ policy sàn và chặn thời gian AI vượt mức nhỏ hơn giữa Dev và `policy.maxActiveTimeSeconds?` của project. `ai.flowPublish` mặc định allow, hỗ trợ draft-only/deny; các trường mới đều tùy chọn.

Quyết định đã hỏi: trần project lưu tại `policy.maxActiveTimeSeconds?`. Diff thuần nằm ở `src/domain/flow-diff.ts` và core re-export để UI dùng cùng hàm mà không đưa Node vào browser. CLI dùng `flow author-draft/author-validate/author-publish` cho đường AI vì các lệnh `flow draft/validate/publish` cũ đã có nghĩa khác; `flow diff` và `assess` theo plan. `assess.available` báo flow bị che bởi draft chưa publish hoặc bị policy chặn; bản có sẵn vẫn có thể đọc và sao chép.

| Kiểm chứng Windows | Kết quả |
| --- | --- |
| `npm test` | Chạy đầy đủ một lần: 236 test, 234 pass, 2 skip, 0 fail. Lượt này hoàn tất **trước** sửa khóa cạnh tranh khi đổi tên draft. |
| Sau sửa khóa | Build core và 30 test liên quan (authoring, library, lock, editor API, session tools/fake runner) đều đạt; thêm test hai thao tác đổi tên cùng revision chỉ có một thao tác thắng. |
| Code cuối của Gói 1 (session điều phối chạy lại) | `npm test` đầy đủ: 237 test, 235 pass, 2 skip, 0 fail. |
| TypeScript UI, build UI, build extension | Đạt sau sửa khóa; không cài extension, không chạy flow thật. Gallery `flow.html#ai,compare` và panel sáng `#panel,light,ai,insp` đã kiểm bằng Edge. |

Session điều phối quyết định giữ ý nghĩa `contentHash` hiện tại: `author` là metadata như `createdAt`, không có hash xác thực riêng (lịch sử Git đủ để truy vết ai sửa file phiên bản).

## Thiết kế lại giao diện · GĐ 5 — 06/11/2026

`ui/redesign-p5`: bỏ `styles.css` và bridge biến cũ; bật Tailwind preflight, đổi `studio.css` thành `flow-studio.css`, `p4.css` thành `profiles-memory.css`, đổi tên gallery. Inspector Flow Studio chuyển sheet ở viewport dưới 1100px; khắc phục wrap runner và bo controls React Flow sau preflight.

| Kiểm chứng Windows | Kết quả |
| --- | --- |
| `npm test` | 222 test: 220 pass, 0 fail, 2 skip |
| TypeScript UI, build UI, build extension | Đạt; panel `dist/index.js` 1.356.324 bytes, gzip 364,84 kB theo Vite. |
| Edge headless | Gallery component/Runs/Flow Studio/Profiles/Memory, tối/sáng, web 1440/panel giả lập 900; kiểm Ctrl K, màn trống và portal trong shadow root giả lập. |
| Panel trong Nimbalyst | Đạt (người dùng kiểm 06/11, sau khi merge GĐ 3–5): Runs, Flows, Profiles, Memory |

Ảnh: `docs/design/redesign/after-*.png`; việc backend trong [kế hoạch](../design/redesign-plan.md). Cảnh báo build sourcemap Tailwind và URL `dist-ui` resolve khi chạy vẫn còn.

## Thiết kế lại giao diện · GĐ 4 — 06/11/2026

Trên `ui/redesign-p4`, Profiles có danh sách profile có sẵn và project, chỉnh hướng dẫn/quyền/skills, nhân bản, lưu nháp và publish có `expectedRevision`; tab sử dụng lấy tham chiếu từ draft flow. Memory có trạng thái root, hàng đợi lesson (duyệt, sửa, từ chối), bảng và sheet chi tiết, sửa context/quyết định và policy. API `memory/preview` sẵn có được dùng để xem thử theo task với policy đã lưu. Không đổi backend.

| Kiểm chứng Windows | Kết quả |
| --- | --- |
| `npm test` | 222 test: 220 pass, 2 skip, 0 fail; test parallel writers đạt. Probe Claude CLI ước tính ~$0.0022. |
| TypeScript UI, build UI, build extension | Đạt; build extension còn cảnh báo sourcemap Tailwind và URL `dist-ui` resolve khi chạy. |
| Edge headless, gallery dữ liệu giả | Profiles và Memory ở tối/sáng, web 1440/panel 900; có dialog tạo profile, root chưa chọn, lesson, sheet chi tiết, policy, Skills và profile đã sửa. Chưa kiểm host Nimbalyst thật. |

Không hiển thị cảnh báo hash skill lệch, revision/cập nhật của toàn bộ root, cập nhật profile mới sang flow hoặc nội dung phiên bản profile cũ: API hiện có không cung cấp các thao tác/dữ liệu đó. Menu phiên bản chỉ liệt kê số phiên bản. Kết thúc GĐ 4, `styles.css` còn 168 dòng vật lý; GĐ 5 đã xóa file này. Xem lại bằng vite dev tại `/__gallery/profiles.html` và `/__gallery/memory.html`; hash `light`, `panel`, `create`, `edited`, `skills`, `usage`, `root`, `detail`, `policy` chọn trạng thái.

## Thiết kế lại giao diện · GĐ 3 — 05/11/2026

**Hoàn thiện 06/11:** Header dùng Button/DropdownMenu; inspector dùng Input, Textarea, Field và Select với portal chung. Tên bước sửa ở header; vòng sửa và join chọn bước bằng checkbox, vẫn hiển thị các ID cũ không còn phù hợp để có thể bỏ chọn. Đã xem gallery ở theme tối/sáng, 1440 và panel 900 với inspector, thêm bước, so sánh, lỗi, menu; CDP mở Select và chọn Opus 5.5, xác nhận chip `Claude Code · Opus 5.5`. TypeScript UI, build UI và build extension đạt; không chạy lại `npm test` theo yêu cầu. Chưa kiểm portal trong host Nimbalyst thật.

Flow Studio trên branch `ui/redesign-p3`: header một hàng, dải thêm bước và tìm bằng `/`, thẻ React Flow theo token, inspector và ngăn Vấn đề, so sánh phiên bản trong sheet. Inspector panel dùng `SheetContent`; gallery `/__gallery/flow.html` dùng transport giả và chỉ có ở vite dev. Không đổi backend, không chạy flow thật. Validate không phân biệt mức độ nên mọi diagnostic được trình bày là lỗi; mô phỏng flow và cảnh báo riêng không hiển thị. So sánh từng thuộc tính tiếp tục dùng diff JSON hiện có.

| Kiểm chứng Windows | Kết quả |
| --- | --- |
| `npm test` | 222 test: 219 pass, 1 fail, 2 skip. Test song song báo peak 1 thay vì 2; chạy riêng test đó đạt 1/1. Fixture có timeout 5 giây, chưa xác định chắc nguyên nhân lỗi trong suite. |
| `npm run build:ui`, build extension, `npx tsc -p tsconfig.ui.json --noEmit` | Đạt. Build extension có cảnh báo sourcemap của Tailwind và cảnh báo URL `dist-ui` resolve khi chạy. |
| Edge headless, gallery dữ liệu giả | Đã xem tối/sáng 1440 và panel 900, inspector, thêm bước, diagnostic và sheet so sánh. Chưa kiểm tương tác toàn bộ bằng CDP hoặc trong host Nimbalyst. |

Bàn giao GĐ 3 đã gộp trong [bàn giao chung](session-handoff-2026-11-06.md). Suite đầy đủ GĐ 4 và GĐ 5 đạt; kiểm panel thật với bản GĐ 5 còn dành cho session điều phối.

## Thiết kế lại giao diện · GĐ 2 — 05/11/2026

Màn Runs làm lại theo mockup 10, 13–17 của [redesign-plan.md](../design/redesign-plan.md), branch `ui/redesign-p2` (từ `494b329`), không đổi backend: danh sách run (nhóm Cần bạn / Đang chạy / Gần đây, popover lọc), Run mới, chi tiết run với stepper và từng trạng thái (chờ duyệt, đang chạy, bị chặn/hết thời gian/commit lỗi, hoàn tất, handoff không commit, đã hủy), Xem session trong `SheetContent` với timeline 3 tầng. Đã xóa các class cũ của màn Runs khỏi `styles.css` (523 → 328 dòng); `/__gallery/runs.html` (chỉ có ở vite dev) dựng màn bằng dữ liệu giả cho mọi trạng thái, không chạy run thật.

| Kiểm chứng (Windows) | Kết quả |
| --- | --- |
| `npm test` | 222 test: 220 pass, 2 skip, 0 fail |
| `npm run build:ui`, build extension, `tsc -p tsconfig.ui.json` | Đạt; panel 1,35 MB chưa minify (GĐ 1: 1,25 MB), không có `require()` |
| Ảnh chụp Edge headless từ `/__gallery/runs.html` | Chờ duyệt, đang chạy (2 nhánh), bị chặn, hết thời gian, commit lỗi, hoàn tất, handoff, Run mới (có/không thay đổi chưa commit, flow chưa publish), popover lọc, Xem session; theme tối và sáng, rộng 1440 và 900 (panel) |
| Panel trong Nimbalyst | Đạt (người dùng kiểm 05/11): danh sách run, lọc, Run mới, chi tiết run, Xem session, đổi theme khi panel đang mở |


Theo [redesign-plan.md](../design/redesign-plan.md) (GĐ 0 thử kỹ thuật ở branch `spike/ui-shadcn`; GĐ 1 ở branch `ui/redesign-p1`). Tailwind v4 + component kiểu shadcn (Radix), token sáng/tối từ mockup v2, khung app web và panel, Ctrl K, màn chưa có flow, hộp thoại trong trang thay `window.confirm`/`prompt`. Màn Runs, Flow Studio, Profiles, Memory vẫn dùng `styles.css` cũ (GĐ 2–4) nhưng đã đổi theo theme.

| Kiểm chứng (Windows) | Kết quả |
| --- | --- |
| `npm test` | 222 test: 220 pass, 2 skip, 0 fail |
| `npm run build:ui`, build extension, `tsc -p tsconfig.ui.json` | Đạt |
| Editor web trên repo tạm, Edge headless + CDP | Runs, Flows (tự mở flow), Profiles, Memory, Ctrl K, theme sáng/tối, màn chưa có flow, hộp thoại tạo/đổi tên/xóa flow; không lỗi console |
| `/__gallery` (vite dev) | Mọi component ở cả hai theme |
| Panel trong Nimbalyst | Đạt (người dùng kiểm 05/11): thanh tab 40px, theme theo Nimbalyst khi đổi sáng/tối, chọn flow, hộp thoại đổi tên, Ctrl K, số run cần bạn |

## Sửa sau lần dùng thật — 05/11/2026 (5 session Nimbalyst song song)

Theo [kế hoạch](plan-fixes-2026-11-05.md) người dùng duyệt; mỗi gói một session Opus trong worktree riêng, session điều phối gộp bằng cherry-pick lên `codex/temporary-workflow-memory` (không xung đột). Sau khi gộp, Windows: `npm test` **222 test, 220 pass, 0 fail, 2 skip**; build extension đạt và đã cài lại.

| Gói | Kết quả |
| --- | --- |
| A | Vòng sửa đưa output các check hỏng của lượt review gần nhất vào prompt writer (phần cuối, tối đa 200 dòng/20000 ký tự, có đánh dấu cắt); writer được dặn không lách lỗi môi trường. Planner được dặn check không ghi file vào repo. Artifact check ghi `baselineHash` và giữ phần cuối output dài. Run cũ thiếu `baselineHash` không có output check trong prompt sửa |
| B | Trước vòng sửa, thiếu thời gian (dưới max(5 phút, thời lượng vòng trước)) thì `paused` với lý do rõ; `runtime-state` thêm `roundStartMs`/`lastRoundMs` (tùy chọn). Hủy run isolated không có thay đổi chưa giao thì `autoClean` (snapshot rồi xóa) |
| C | Check làm đổi baseline: lỗi liệt kê tối đa 20 đường dẫn thêm/sửa/xóa kèm gợi ý; vẫn chặn như cũ. `command/exec` nhận `env` (gộp vào môi trường của server, kiểm trong `codex app-server generate-ts`, Codex 0.166.0); check chạy với `PYTHONDONTWRITEBYTECODE=1` (không chặn được `py_compile`) |
| D | `run start --task-file`, `run changes --feedback-file`, `run plan <project> <run> [--out]` xuất plan Markdown (`src/domain/plan-markdown.ts`) |
| E | Tái hiện lỗi sandbox bằng `scripts/probe-check-sandbox.mjs` (chỉ `config/read` và `command/exec`, không gọi model). Nguyên nhân: Python ≥ 3.12.4 tạo thư mục `0o700` (mọi `tempfile.mkdtemp`) với DACL bảo vệ chỉ `SYSTEM`/`Administrators`/`OWNER RIGHTS`, bỏ ACE capability SID mà sandbox `unelevated` (restricted token) cần, nên ghi vào bên trong bị `WinError 5`. Không phải lỗi thư mục con nói chung; `TEMP` không ảnh hưởng. Chế độ `elevated` chưa thử (cần setup admin) |

Hướng xử lý lỗi sandbox còn chờ người dùng chọn: giải thích `WinError 5` trong output check (không nới quyền), thử sandbox `elevated` bằng probe, thư mục tạm riêng mỗi check. Chưa chạy lại run thật sau đợt sửa.

## Dùng thật đầu tiên: `leetcode-practice` — 04/11/2026

Repo luyện LeetCode của người dùng (`W:\projects\AI\leetcode-practice`), flow Dev, Claude Opus 5.5 / high cho planner, writer và reviewer; checks qua Codex. Task: script tạo bài, build/test harness, selftest. Run `run-0f7e84e0-b21e-47b8-badf-7e445d73d67c`.

- Plan sửa hai lần theo yêu cầu người dùng (tách `solution.c`/`test.c` để dán lên LeetCode; clang MSYS2 và `--sanitize`). Duyệt plan v3.
- Bị **blocked** lần đầu: check `python -m py_compile` ghi `tools/__pycache__`, repo chưa ignore nên baseline đổi. Gỡ bằng cách thêm `__pycache__/` vào `.gitignore` trong worktree rồi `run resume`.
- Checks trong **sandbox Codex trên Windows** chạy được `python`, nhưng `selftest.py` hỏng: process trong sandbox tạo được thư mục, nhưng **tạo thư mục con trong thư mục vừa tạo thì bị `WinError 5 Access is denied`**, kể cả trong worktree. Ngoài sandbox, selftest pass toàn bộ với MinGW GCC 6.3.
- Writer Claude không có shell và lúc đầu không thấy chỗ hỏng trong output check, nên hai vòng sửa là sửa mò (thêm cờ `-U__STRICT_ANSI__` ngoài plan; reviewer bắt được). Run hết ngân sách 30 phút và paused; người dùng chọn hủy.
- Chi phí: khoảng 30 phút chạy, ít nhất **3,36 triệu token** (journal ghi partial). Code lấy về checkout chưa commit sau khi gỡ cờ ngoài plan; selftest pass trên máy thật. Review độc lập **chưa pass** (chỉ vì selftest trong sandbox).

Việc cần làm cho NeoMind, xếp theo mức ảnh hưởng:
1. Checks Windows: cho phép tạo cây thư mục tạm (hoặc chỉ định thư mục tạm ghi được) trong sandbox Codex.
2. Vòng sửa phải đưa nguyên output lỗi của check cho writer; writer không có shell nên không tự chạy lại được.
3. Planner cần biết check không được ghi file vào worktree (hoặc NeoMind báo rõ file nào làm đổi baseline).
4. CLI: `--task-file` (task nhiều dòng qua `cmd` bị cắt còn dòng đầu) và xuất plan ra Markdown để đọc/duyệt.
5. Ngân sách 30 phút hết giữa lượt sửa: cảnh báo trước hoặc cho gia hạn khi đang chạy.

## Suite trên Windows sau đợt 04/11 — 04/11/2026

Windows 11, Node 24.18.0, Git 2.53.0, Codex CLI 0.166.0, Claude Code 2.1.312. Checkout chép từ Linux cần `npm ci` lại (`node_modules/.bin` của Linux không có shim `.cmd`). Lần đầu: 207 test, 201 pass, 4 fail, 2 skip. Sau khi sửa bốn lỗi và đổi thiết kế cleanup: **208 test, 206 pass, 0 fail, 2 skip** (symlink file không có trên máy, SIGTERM không gửi được tới process con trên Windows). `npm run build:ui` và build extension Nimbalyst đạt (cảnh báo bundle >500 kB như trước).

- Rename conflict với newline trong tên: NTFS không cho phép tên như vậy; trên Windows test dùng tên non-ASCII, mà Git cũng C-quote nếu không tách bằng NUL.
- Cleanup bằng rename: Windows không cho đổi tên thư mục khi có process mở file/cwd bên trong (`EPERM`), và intent có thể kẹt vĩnh viễn nếu worktree bị ghi sau đó. Người dùng duyệt **đổi thiết kế**: ngay trước khi xóa, mỗi worktree được chụp (tracked + untracked, trừ ignored) thành `refs/neomind/<run>/snapshot/workspace` hoặc `.../snapshot/branch/<node>`, rồi xóa hẳn và `git worktree prune`. Snapshot chụp lúc thực hiện, không lúc ghi intent, nên file ghi sau intent vẫn được giữ; ref đã có thì không chụp lại (lần xóa dở không ghi đè bản đầy đủ). Bỏ baseline/fingerprint ignored/`.retained`/`worktree repair`. `workspace_cleaned` mang danh sách snapshot; intent cũ có `baselines`/`retained` vẫn replay. Trên Windows, chương trình giữ thư mục làm việc xóa dừng sau ~3 giây retry, báo lỗi; dọn lại là xong. Đánh đổi: ghi từ bên ngoài trong khoảng giữa chụp và xóa sẽ mất (worker NeoMind đã dừng chắc chắn lúc đó).
- Tool `wait` của session trả kết quả khi phase vừa chuyển sang `completed`, trong khi run vẫn bận `autoClean`; vì vậy `apply` gọi ngay sau đó bị từ chối. `wait` nay chờ run settle trước khi trả về.
- Ngắt Claude: `ActiveProcesses` của job về 0 trong khi process cháu vẫn đang được kernel dọn và PID còn thấy `alive`. Lệnh `stop` của helper nay mở handle các process trong job trước khi terminate và chỉ báo `stopped` khi tất cả đã signal. Helper được biên dịch lại theo hash mới.

Chưa chạy lại run thật Codex/Claude trên Windows và chưa kiểm chứng host Nimbalyst sau đợt này.

## Walkthrough Flow Studio trên Linux — 04/11/2026

Đã thao tác giao diện thật: mở canvas và inspector model/reasoning, cấu hình run và memory preview, khởi động run, xem trạng thái và log trực tiếp, mở input/output theo attempt, checks, verdict, commit và cập nhật context có nguồn trong project memory. [Bộ review 10 ảnh](ui-review-2026-11-04/REVIEW.md), [gallery offline](ui-review-2026-11-04/index.html) và [báo cáo kết quả](ui-review-2026-11-04/report.json) được lưu cùng repo.

Project C11 dùng Luna 6 / low, flow demo tự khai báo auto approval trong project riêng cho phép. Run `run-c2403d71-d305-4feb-af4e-3f0c1945bbda` hoàn tất sau **42,25 giây**: `sh verify.sh` biên dịch với `-std=c11 -Wall -Wextra -Werror`, ba ca cộng/trừ/số âm đạt; reviewer độc lập đạt 8/8 tiêu chí; commit local `9e6fbbd010b06653525cc118f73a3726e2a10400` chỉ sửa `main.c` trong worktree demo. Usage run thành công **62125 tokens**, gồm **24192 cached input**; USD không được cung cấp. Server demo đã dừng.

Lần trước dùng `node verify.cjs` bị `spawnSync cc EPERM` trong sandbox dù check chạy trên host đạt. Flow giữ trạng thái blocked và chưa commit; script shell được kiểm tra đạt trong cùng sandbox trước khi chạy run mới. Chưa xác định nguyên nhân gốc lỗi Node subprocess; không coi thay script demo là đã sửa lỗi runtime NeoMind. Không chạy lại suite/build cho đợt lưu bằng chứng vì không đổi source. Walkthrough này chưa kiểm chứng kéo/thả, multi-copy/paste, screen reader, lesson revisions, mọi biến thể song song hoặc Windows/Nimbalyst host.

## Cập nhật 04/11/2026 — tám hạng mục workflow/workspace/Studio/memory

| Hạng mục | Đã triển khai | Bằng chứng / giới hạn |
| --- | --- | --- |
| Flow nhiều giai đoạn | Writer trước/sau fork, baseline nhánh theo thời điểm bắt đầu, nhiều integration, review và repair riêng từng nhánh; checks nhánh có thể cấu hình riêng, final review vẫn chạy checks/criteria toàn kế hoạch | Regression hai fork/hai integration và branch repair; các check riêng phải được liệt kê trong plan để duyệt. Fork lồng nhau/integration nằm trong nhánh chưa join vẫn bị preflight chặn; dùng các giai đoạn nối tiếp |
| Checkout/shared workspace | Chọn theo flow hoặc trước run trên UI/API/CLI; xác nhận dirty baseline; một writer lease mỗi workspace; shared writer chạy tuần tự; commit chỉ phần run và rebase staging của người dùng qua private index dưới index.lock | Regression giữ đồng thời staged, unstaged, untracked; không dọn hoặc áp patch lại vào checkout mượn |
| Race cleanup | ~~Dọn bằng atomic rename vào `workspaces/.retained/<run>`~~ — thay ngày 04/11 (Windows) bằng snapshot ref rồi xóa, xem mục đầu file | Journal cũ có `retained`/`baselines` vẫn replay; thư mục `.retained` đã tạo không tự xóa |
| Canvas | Thêm bước khi thả đầu nối ra pane hoặc nút thêm bước tiếp theo; multi-copy/paste giữ cạnh/tham chiếu, multi-delete, undo/redo, Ctrl/Cmd+A/S/C/V/Z, Escape, chọn node/cạnh bằng select và popup keyboard | Build UI đạt; chưa có browser acceptance cho các thao tác mới |
| Version diff | Diff từng thuộc tính lồng nhau, trước/sau; hiện thêm theo mỗi 200 thay đổi | Regression structural diff; so sánh version đã lưu với draft |
| Run graph | Ghi input/output theo attempt vào journal, hash và provenance task/memory/plan/artifact/check/code; API tải riêng payload; cạnh dữ liệu khác cạnh điều khiển | Regression input bị sửa hash bị từ chối; prompt/output trên 1 triệu ký tự được rút gọn có cờ rõ ràng; run cũ thiếu node data vẫn đọc được |
| Lesson revisions | Mỗi lần chỉnh tạo file revision bất biến, số version nằm trong proposal hash, edit CAS, approval cũ không duyệt revision mới kể cả nội dung quay lại như cũ | Regression stale edit/approval/revert; chỉ người dùng duyệt mới promote |
| Memory retrieval | Suy ra path từ đường dẫn và tên file/thư mục trong repo; lexical/LSA/hybrid; loại trùng nội dung cùng loại/scope/tags; `expiresAt`/`supersedes` và chặn chu trình thay thế | LSA chạy cục bộ theo corpus, tối đa 512 record sau lọc; không phải pretrained embeddings. Hết hạn/thay thế dựa vào metadata tường minh, không tự kết luận fact đã sai |

**Inference thật:** Luna 6 chạy fixture song song trên Linux: conflict cả `value.txt` và `value.bin` → resolution manifest → `node verify.cjs` pass → reviewer độc lập pass → commit `9251a0d7a867fc8e7364e3d2579283042486cd54`. Run `run-c2f7b2a1-eed4-4c7e-b5e8-821408370b75`, dữ liệu tại `demo/workflow-acceptance/real-1793708133433/` (bị ignore). Fixture tự khai báo auto approval và project fixture cho phép; không giả mạo người dùng duyệt. Đã recovery/resume qua hai lỗi thực: ghép lời dẫn cùng JSON manifest, và reviewer thiếu nguồn đối chiếu; core nay đọc message cuối và cung cấp source evidence từ đúng baseline. Tổng usage của fixture sau recovery: **195388 tokens**, trong đó **118016 cached input tokens**; không dùng Astra. Có script opt-in `node scripts/acceptance-conflicts.mjs --real` để tái hiện khi cần, không chạy trong `npm test`.

Kiểm chứng cuối trên Linux: `npm test` **207 tests, 196 pass, 11 skip, 0 fail**; UI và extension Nimbalyst build thành công. Code commit `1204e8f`. Chi tiết trong bàn giao 04/11. Các kiểm chứng lịch sử bên dưới phản ánh thời điểm ghi, không thay thế trạng thái mới nhất ở trên.

## Lịch sử 03/11/2026

- Bổ sung: lesson có thể chỉnh nội dung tạo revision bất biến; edit ràng buộc vào hash bản đang xem và approval cũ không duyệt nội dung mới. Việc đưa vào memory vẫn cần người dùng duyệt.
- Memory selection có cấu hình tùy chọn theo scope/tag, lexical task match, số record và ngân sách bytes. `inferTaskPaths` nhận diện đường dẫn có dấu `/` được nêu trong task, lọc scope tương ứng và scope `project`; khi không tìm thấy đường dẫn giữ hành vi cũ. Chưa có semantic search hoặc tự tìm đường dẫn không được nhắc đến.
- Canvas hỗ trợ copy/paste nhiều bước cùng cạnh và tham chiếu nội bộ; kéo đầu nối ra vùng trống để chọn bước mới; diff phiên bản có thuộc tính lồng nhau (tối đa 200 thay đổi). Graph run cho xem task, định nghĩa đã ghim, cạnh vào/ra và delivery; cạnh chỉ phản ánh luồng điều khiển, chưa chứng minh dữ liệu được truyền.
- Git conflict không có marker văn bản bị chặn để tránh nhận nhầm kết quả. Chưa hỗ trợ giải quyết đầy đủ conflict nhị phân, đổi tên/xóa phức tạp.
- Còn thiếu writer trước/sau fork, nhiều integration, review từng nhánh, current/shared workspace, race khi dọn worktree, semantic search và xử lý memory trùng/lỗi thời. Giữ các chặn preflight hiện có; chưa browser acceptance hoặc chạy model thật cho thay đổi mới.

- Bổ sung sau cập nhật ban đầu: canvas run từ snapshot; lọc lịch sử theo flow/trạng thái/ngày và báo mất kết nối; so sánh draft/version; palette theo nhóm, copy/paste một bước và keyboard undo/redo. Memory preview trước run và snapshot metadata (revision, nguồn, lý do), hàng đợi lesson cùng thao tác từ chối ghi receipt. Xem [plan](next-plan-workflow-memory-studio.md) để biết phần còn thiếu.
- Chưa có browser acceptance cho UI mới; P1–P4 chưa hoàn tất. Chưa bật shared workspace, current checkout, nhiều integration hoặc workflow graph tổng quát.

- Bắt đầu [kế hoạch ưu tiên mới](next-plan-workflow-memory-studio.md). Compiler yêu cầu opt-in tường minh `allowAutoApproval` / `allowHumanReview` khi project có gate tương ứng; Fast vẫn dùng được sau khi project cho phép. Snapshot và journal của run cũ được đọc theo quy tắc đã lưu; validate/publish và run mới dùng quy tắc mới.
- Cleanup kiểm tra branch worktree so với ref đã lưu, ghi baseline và đối chiếu lại trước khi dọn, gồm sau recovery. Intent cũ không có baseline không tự dọn worktree còn tồn tại; giữ lại để kiểm tra. Intent mới còn ghim hash nội dung file ignored để phát hiện thay đổi trước khi tiếp tục dọn bắt buộc. Có regression cho thay đổi sau intent và thay đổi nhánh sau ref. Việc kiểm tra baseline không khóa chỉnh sửa từ công cụ ngoài trong khoảng giữa đối chiếu và lệnh Git.
- Flow Studio: node thể hiện approval tự động hay người duyệt, binding kế thừa/ghim và reviewer target; có tìm bước. Memory lọc loại/phạm vi/tag trong tập kết quả tìm kiếm hiện tại. Đây là lát UI đầu tiên, P1–P4 chưa hoàn tất; chưa có browser acceptance cho thay đổi mới.
- Linux: bộ kiểm tra 190 test, 179 pass, 11 skip, 0 fail; UI build thành công. Các skip là test Windows/Claude scope. Chưa chạy inference thật hoặc kiểm thử Windows trong đợt này.

## Đã hoàn thành trong đợt hiện tại

- Codex app-server transport và dispatch thật cho plan, write, check, review; orchestrator nối flow mặc định tới commit local trong detached worktree. Cấu hình/model/reasoning/profile/skill và memory được ghim theo run; preview ràng buộc snapshot và source HEAD.
- Durable journal, scheduler owner/fencing, workspace leases và quarantine; recovery đối chiếu worker/session/code rồi chờ người dùng Continue. Pause/cancel ngừng giao việc, yêu cầu ngắt worker và giữ artifacts/code. Regression đã kiểm tra pause khi check đang giữ hàng đợi service.
- Worker/check dùng Linux user-systemd scopes và xác minh dừng trước khi giải phóng workspace; turn interrupted đơn lẻ không được coi là bằng chứng dừng shell con. External tools/delegation bị vô hiệu hóa và inventory được kiểm tra trước dispatch.
- Approval có plan hash, đổi kế hoạch tạo version mới; bounded repair giữ session thực hiện và từng reviewer. Nhiều reviewer độc lập chạy đồng thời theo cap; required/advisory verdict và evidence được tổng hợp. Source citations, check receipts và artifact references được đối chiếu với baseline; một lần retry validation trước khi chờ nếu evidence không hợp lệ.
- Checks, graph conditions và repair counters có trạng thái bền vững. Active-time budget bỏ thời gian toàn run chờ người dùng; gia hạn có journal. Fallback chỉ trong allowlist. Token usage cộng theo session; thiếu dữ liệu hiển thị unknown/partial, chi phí chưa đo được.
- Commit theo reviewed tree trong detached worktree; lỗi Git giữ technical acceptance và cho explicit retry khi baseline/intent đã đối chiếu. Git commands có timeout và AbortSignal; chưa chứng minh dừng toàn bộ cây tiến trình ký Git. Commit-tree không chạy hooks.
- Flow Studio: canvas/flow library, profile CRUD/draft/publish, binding/fallback và condition editors, run preview/monitor/approval/plan changes/pause/resume/cancel/retry Git/gia hạn. API localhost có origin/token checks. CLI có preview/start/list/show/approve/resume/pause/cancel cơ bản.
- Memory root theo Git common directory, Markdown CAS và audit receipts cho context/quyết định; shared memory được ghim theo run. Lessons sau repair chỉ là proposals; promotion cần duyệt đúng hash và revision. Memory UI đã thử bằng trình duyệt.
- Local Research tạo artifacts chỉ đọc và review chúng; đã test bằng transport deterministic. Chưa kiểm chứng inference thật cho Research hoặc nguồn web/connector.

## Kiểm chứng

- `npm test`: **101/101 pass**, 0 fail, 0 skip; gồm TypeScript build, integration fixtures, crash recovery, leases, evidence, repair, parallel reviewers, memory, lifecycle và Git.
- `npm run build:ui`: thành công; xem bàn giao cho bước xác minh cuối trước commit.
- Inference thật với **Luna 6** thực hiện và **Sol 6.1** review: fixture hoàn thành plan → duyệt giả lập → write → checks → review → commit. Không dùng Astra. Terra 6.1 có trong catalog, chưa claim đã inference trong đợt này.
- Headless Chromium: full fixture chạy qua UI tới commit sau recovery/review; profile được publish và quyết định memory có receipt. Đây là disposable fixture với approval giả lập, không phải người dùng duyệt task Calculator thật.
- Đã kiểm tra scope recovery sau scheduler crash. Node SQLite trên Node 22 vẫn experimental; chưa xác minh nền tảng khác Linux/user-systemd.

## Windows native (29/10/2026)

- Worker scope dùng Windows job object với kill-on-close thay cho user-systemd (`src/adapters/windows-job.ts`, `src/platform/windows-helper.ts`). Helper C# được biên dịch bằng `csc.exe` của .NET Framework khi chạy lần đầu. Identity được ghi vào journal dạng `neomind-run-<uuid>.job` / `windows-job:Global\…`. Recovery chấp nhận cả hai định dạng; identity của nền tảng khác không bao giờ được xác nhận là đã dừng.
- Capability probe trên Windows kiểm tra sandbox (ghi trong/ngoài thư mục) và stop proof của một lệnh sandbox đang chạy. Định danh scheduler dùng PID, creation time và `BootId`.
- Sửa lỗi portable: không fsync thư mục trên Windows; journal không mở append mode để truncate được; review evidence so khớp CRLF; checks phân giải PATHEXT (`npm` → `npm.cmd`).
- Kiểm chứng trên Windows 11, Node 24.18.0, Codex CLI 0.160.1: `npm test` **104 pass, 0 fail, 1 skip** (file symlink cần Developer Mode). Crash recovery chạy thật với Codex + job object. Probe `sandboxVerified/stopVerified` đạt. `run preview` và editor chạy được. Flow inference: xem mục kiểm chứng bên dưới.

## Lifecycle/CLI (29/10/2026, mục 1 của handoff)

- CLI có đủ các control của UI: `run changes`, `run retry-git`, `run extend-time`, ngoài preview/start/list/show/approve/resume/pause/cancel. Toàn bộ lệnh được kiểm tra trước khi mở state (`src/cli/run-command.ts`).
- SIGINT/SIGTERM/SIGHUP (Windows thêm SIGBREAK) cho `run …` và `editor`: tín hiệu đầu tạm dừng run thuộc process, chờ stop proof rồi thoát (130/143/129). Tín hiệu thứ hai thoát ngay; recovery xử lý worker còn sót. `RunManager.close()` idempotent và trả trạng thái từng run. Editor đóng cả kết nối keep-alive.
- Planner prompt nói rõ kế hoạch mô tả thay đổi của bước thực hiện. Trước đây planner Luna/low có thể viết kế hoạch "read-only, không sửa file" cho chính bước khảo sát; reviewer chấm theo kế hoạch đó nên mọi lần repair đều fail (quan sát trong run Windows đầu tiên).
- Tests: 110 (108 pass, 2 skip trên Windows: file symlink, SIGTERM tới editor con). Chưa kiểm chứng tạm dừng bằng Ctrl+C khi đang có lượt inference thật.

## Kiểm chứng inference trên Windows (29/10/2026)

Windows 11, Node 24.18.0, Codex CLI 0.160.1, Luna 6/low cho mọi vai trò, repo thử `demo/repo1` (Node, `npm test`, `core.autocrlf=true`). Chạy hoàn toàn bằng CLI.

| Kịch bản | Kết quả |
| --- | --- |
| Dev flow `subtract` | Plan v1 tách checks thành `npm` + `test` → `run changes` tạo v2 với `npm test` → approve → write → `npm test` trong job (qua `npm.cmd`) pass → review pass nhưng một trích dẫn sai dòng (13 thay vì 11), bị chặn sau 1 retry → `run resume` → review pass → commit `f9ca2a1` trên detached worktree. ~248k tokens. |
| Ctrl+C giữa Implement | CTRL_C_EVENT thật tới console của CLI: run `paused`, attempt `stopped`, job absent, không còn helper; `run resume` → hoàn tất, commit `07ef74e`, review pass lần đầu. ~160k tokens. |
| Ctrl+C rồi `run cancel` | CLI thoát 130 với tổng kết `paused`; `run cancel` → `cancelled`. |

Sửa sau các lần chạy: planner không được tách một lệnh thành nhiều checks; lần retry/resume của reviewer nhận danh sách tham chiếu bị từ chối kèm dòng đúng (`referenceProblems`); tổng kết khi tắt đọc trạng thái trước khi đóng journal. Commit dùng LF như baseline dù worktree là CRLF. Chưa chạy thật `retry-git` và `extend-time` (cần lỗi Git hoặc hết thời gian); service tương ứng có integration tests.

## Nhiều writer song song (29/10/2026, mục 2 của handoff)

Chi tiết trong [parallel-writers.md](parallel-writers.md). Template `parallel` chạy hai writer trong worktree riêng, gộp bằng `git merge-tree`, giao conflict/repair cho agent integration, review và commit kết quả tích hợp. Plan có `workPackets`; sandbox mỗi nhánh giới hạn theo scope của packet. Journal thêm `branch_workspace_intent/bound`, `integration_intent/applied`. Preview vẫn chặn: writer trước fork, nhiều integration, writer ngoài nhánh khi có nhánh, review/repair từng nhánh. Tests: 119 (117 pass, 2 skip trên Windows). Đã chạy thật với Codex tới commit (không conflict); đường conflict mới có test deterministic.

## Thay đổi chưa commit làm input (29/10/2026, mục 3 phần 1)

- Preview trả `dirtyImport`: các thay đổi chưa commit của checkout (sửa/thêm/xóa/untracked), mã xác nhận là baseline hash của checkout, và blocker (symlink; flow có bước ghi song song). `.neomind/` không bao giờ được mang vào.
- `run start … --import-dirty HASH` hoặc ô chọn trên UI: chép đúng trạng thái đã xác nhận vào worktree của run, kiểm tra nội dung từng file và kiểm tra checkout không đổi sau khi chép. Checkout, index và phần đã stage của người dùng không bị sửa. Runtime context lưu `imported` (tree sau import, danh sách path).
- Agent và reviewer được báo đâu là thay đổi có sẵn của người dùng. Lần ghi đầu bắt đầu từ baseline sau import (admission `start`); continuation chỉ xét phạm vi với thay đổi kể từ import.
- Commit chỉ chứa phần của run: diff từ tree import tới tree đã review, áp lên HEAD trong index riêng. Không tách được (run sửa đúng chỗ người dùng sửa) thì run chặn với lựa chọn `run include-imported` / nút "Commit kèm thay đổi có sẵn" (sự kiện `commit_scope_selected`). Intent commit lưu `workspaceTree` để đối chiếu sau crash khi worktree vẫn giữ thay đổi của người dùng.
- Kiểm chứng: tests 124 (122 pass, 2 skip trên Windows). Codex thật trên `demo/repo1` với 3 thay đổi giả lập của người dùng: commit `64026d5` chỉ có `divide` + test; worktree giữ nguyên thay đổi của người dùng; checkout không đổi. ~143k tokens. Chạy trực tiếp trên checkout hiện tại (phần 2) chưa làm.

## Storage concurrency và review impact (30/10/2026, mục 4)

- **Thư viện flow/profile:** mọi thao tác ghi (tạo, lưu draft, publish, đổi tên, archive, clone, xóa) đi qua `withLibraryLock`: hàng đợi trong process và giao dịch `BEGIN IMMEDIATE` của SQLite giữa các process (file khóa trong state dir, theo đường dẫn thư viện). Hệ điều hành nhả khóa khi process chết nên không có khóa mồ côi. Draft có revision (sha256 nội dung); lưu/publish với revision cũ bị từ chối (`RevisionConflict`, HTTP 409). UI giữ revision của draft đang mở. Trên Windows, thay file bị process khác đang đọc được thử lại ngắn (lỗi thật do test nhiều process phát hiện).
- **Review impact:** `repair_round_started` ghi tree đã review. Ở lượt review sau, core tính path đổi giữa tree cũ và mới; reviewer đã pass, không bị chọn theo scope và không có file dùng chung (lockfile, package.json, cấu hình build/tool, CI, `.neomind`) bị đổi thì được giữ verdict qua `review_carried_forward` kèm impact receipt (tree cũ/mới, path đổi, scope, rule version). Replay áp lại đúng luật. Bằng chứng của verdict được giữ đối chiếu với receipt check của baseline cũ; source nằm ngoài path đổi. Check được duyệt luôn chạy lại trên baseline mới. Không chắc chắn thì chạy lại mọi reviewer bắt buộc.
- Tests: 131 (129 pass, 2 skip trên Windows), gồm 4 process ghi đồng thời, khóa của process bị kill, 409 qua HTTP, và run có hai reviewer theo scope. Chưa chạy review impact với model thật (cần lượt repair có nhiều reviewer).

## Research với model thật (30/10/2026, mục 5 phần local)

- Lần chạy đầu: agent research (Luna/low) trả lời "không có công cụ đọc file", và reviewer vẫn pass vì tiêu chí chỉ là `sources`/`claims` (một báo cáo không có claim thì không vi phạm). Flow research cũng không có repair.
- Sửa: template `research` thêm tiêu chí `answers the task`, reviewer scope `.`, và repair scope cho bước research. Prompt research nói rõ thư mục hiện tại là workspace cần khảo sát, và vòng repair nhận findings. Reviewer được dặn: artifact không trả lời task hoặc có claim không được nguồn hỗ trợ thì fail.
- Lần chạy lại (`demo/repo1`): lượt đầu agent lại tự cho là chỉ có `clock.sleep`; reviewer đánh fail `answers the task`; vòng repair resume phiên, agent đọc file và trả lời đúng với số dòng; reviewer pass; không commit (~150k tokens). Lỗi lượt đầu không tái hiện ở planner (có structured output); nguyên nhân nằm ở hành vi model, review + repair là lưới an toàn.
- Nimbalyst adapter vẫn chưa làm: SDK public chưa có stop/interrupt có bằng chứng, chưa gán cwd/sandbox theo session và chưa xác minh được model/reasoning thực tế (xem handoff).

## Claude Code runner (30/10/2026)

- Runtime không còn gắn với Codex: dispatch đi qua `AgentRunner`, và registry chọn runner theo binding (`codex` | `claude-code`). Check vẫn chạy qua Codex `command/exec`, nên flow có review cần Codex trên máy. Preview và preflight báo khi thiếu Codex.
- Claude Code chạy mỗi dispatch một `claude -p`, trong Job Object (Windows) hoặc systemd scope (Linux, chưa chạy thật). Quyền giới hạn theo vai trò:
  - reader chỉ có Read/Glob/Grep;
  - writer thêm Write/Edit, chỉ trong writable roots, không có shell;
  - không có Task/MCP/web, và thư mục config của Claude bị deny.
  Đây là enforcement của Claude Code, không phải sandbox OS, nên capability probe phải chứng minh nó trên máy trước khi cho ghi. `system/init` được kiểm tra mỗi lượt. Model cho phép: `claude-sonnet-5-5` (mặc định), `claude-haiku-5-5`, `claude-opus-5-5`.
- UI chọn được runner và model cho từng binding, có `GET /api/runners`.
- Review: core đưa diff của run vào prompt cho mọi runner. Phản hồi retry nêu cả lỗi cấu trúc của evidence.
- Tests: 160 (158 pass, 2 skip trên Windows). Ba E2E thật đều tới commit: Claude viết + Codex review; toàn Claude; crash giữa lượt viết của Claude rồi resume. Chi tiết và các lỗi tìm được: [claude-code-runner.md](claude-code-runner.md).

## Thư mục dữ liệu project: `neomind/` (30/10/2026)

- Dữ liệu NeoMind trong project chuyển từ `.neomind/` sang `neomind/` để Obsidian (ẩn thư mục chấm) thấy flow và board `.canvas`. Mọi đường dẫn đi qua `projectDir()`; `.neomind/` cũ vẫn được đọc, `project migrate` đổi tên. Một thư mục `neomind/` không chứa dữ liệu NeoMind (không trống, không có project.json/flows/profiles/memory) được coi là của project, khi đó NeoMind dùng `.neomind/`. Cả hai tên đều bị loại khỏi import thay đổi chưa commit và tính là file dùng chung khi xét review impact.
- Flow xuất/nhập JSON Canvas (`neomind/flows/<flow>/flow.canvas`) để sửa trong Nimbalyst/Obsidian; cấu hình bước lấy theo draft khi nhập.

## Flow Fast mới (30/10/2026)

- Fast = Plan nhanh (binding `fast-planner`, suy luận `low`) → bước duyệt `mode: "auto"` (NeoMind ghi approval `source: "flow"`, chỉ hợp lệ cho node auto và khi policy cho phép; kế hoạch không hợp lệ thì dừng chờ người duyệt) → Implement → Finish. Flow khai báo `review: "human"`: không review gate, không được có commit.
- Policy project thêm `allowAutoApproval`, `allowHumanReview` (bỏ trống = cho phép); compiler báo `auto_approval_denied`, `human_review_denied`, `human_review_commit`.
- Giao kết quả: `run apply` / nút "Áp dụng vào checkout" chép patch của run (từ HEAD hoặc tree đã import) vào checkout, không stage. Journal ghi `checkout_apply_intent` trước và `checkout_applied` sau; thử lại sau khi gián đoạn nhận ra patch đã áp. Từ chối khi file run sửa đang có thay đổi trong checkout hoặc patch không áp sạch.
- Run thật trên `demo/claude-e2e1` (Claude Sonnet): plan → tự duyệt → implement, 26 giây, ~42k token, không dừng chờ; thay đổi `calc.js`, `test.js` chờ áp dụng. Tests 172 (170 pass, 2 skip).

## Transcript session và luồng hoạt động trực tiếp (30/10/2026)

- `src/core/transcript.ts`: định dạng transcript chung cho mọi runner (`prompt`, `message`, `reasoning`, `read`, `search`, `edit`, `command`, `output`, `result`, `structured_output`, `gap`, `end`), giới hạn kích thước (200 dòng output, 60 dòng đọc file, 400 dòng diff, 8 MB mỗi file), bộ ghi không bao giờ làm hỏng run. Mapper Claude (`stream-json` và file session) và Codex (notification `item/*`, delta output, `thread/items/list`).
- Runner có `observe?(listener)`; `CodexTurnEvents.observe` và `ClaudeTurnRequest.observe` chỉ quan sát, lỗi của observer bị bỏ qua. `LocalRun` mở transcript trước khi dispatch, ghi prompt, turn id và kết quả (`completed`, `failed`, `interrupted`, tokens) ở cả ba loại lượt: đọc/plan, viết, review.
- Lịch sử gốc (`src/runtime/session-history.ts`): Claude theo file `<config>/projects/*/<session>.jsonl`, ghép lượt theo prompt hoặc thứ tự attempt đã bắt đầu turn; Codex qua `thread/items/list` lọc theo turn id, worker ngắn hạn.
- API `GET /api/runs/:id/transcripts` và `/api/runs/:id/transcripts/:attemptId?after=N&source=neomind|runner`. UI: khung Hoạt động trực tiếp (2 cột, agent thứ 3+ thu gọn), dòng tóm tắt khi bước xong, link trên stepper, ngăn Xem session (tab lượt, chuyển nguồn, báo khoảng trống, chỉ đọc).
- Kiểm chứng thật trên `demo/claude-e2e1`: run Fast plan Claude + implement Codex, và run Fast toàn Claude, xem luồng trực tiếp và session trên Edge headless. Transcript ghi được cả lần Claude thử gọi Bash và bị chặn. Tests 177 (175 pass, 2 skip).
- Chưa làm: worker Codex của NeoMind vẫn nạp `~/.codex/AGENTS.md` và skills của người dùng (thấy trong transcript); cần tách cấu hình Codex riêng cho NeoMind.

## Dọn worktree của run (30/10/2026)

- Sự kiện journal `workspace_cleanup_intent` (worktree sẽ xóa, ref giữ commit, file chấp nhận bỏ) và `workspace_cleaned`; replay chỉ nhận khi run đã `completed`/`cancelled`, không còn attempt hay commit dở và không có lần áp dụng checkout dở. Dọn dở được làm tiếp theo kế hoạch đã ghi.
- `LocalRun.cleanWorkspaces(force)` (`src/workspace/run-cleanup.ts`): ghi `refs/neomind/<run>/delivery/<bước>` cho commit đã giao, xóa worktree của run và các nhánh song song qua `git worktree remove`, rồi nhả workspace lease. Từ chối khi worktree bị cách ly, hoặc khi còn thay đổi chỉ nằm trong worktree mà không có `force` (so với commit cuối, với tree đã áp dụng, hoặc với điểm bắt đầu; thay đổi người dùng mang vào không tính vì vẫn còn trong checkout).
- Tự dọn sau khi run Dev xong, sau khi Fast áp dụng vào checkout, và khi run chỉ đọc xong; không bao giờ bỏ thay đổi và không làm hỏng run. Policy `keepRunWorktrees` tắt việc tự dọn.
- Bề mặt: `run clean <project> <run>|--all [--force]`, `POST /api/runs/:id/clean` và `/api/runs/clean`, nút trong màn run và cột lịch sử. `RunManager` đọc file của commit từ repo chính, nên vẫn hiện được sau khi worktree đã xóa.
- Test chạy qua `scripts/run-tests.mjs` với TEMP/TMP/TMPDIR riêng và xóa thư mục đó khi xong. Tests 181 (179 pass, 2 skip). Chạy thật `run clean --all` trên `demo/claude-e2e1`: 6 run được ghi nhận đã dọn, 3 commit Dev được giữ lại bằng ref (trước đó đã mất tham chiếu do xóa worktree bằng tay).

## Extension Nimbalyst · spike (30/10/2026)

- `extensions/nimbalyst`: extension `local.neomind` (backend module trong utility-process, panel, lệnh `/neomind:run`), tool `neomind_status`, `neomind_start` và `probe` chỉ cho panel. Backend chạy `RunManager` hiện có.
- Đã cài và chạy thật trong Nimbalyst (Electron 43.7, Node 24.21): git, Claude Code, Codex, Job Object (dừng có xác nhận) và `node:sqlite` đều chạy; panel gọi được backend.
- Sửa core: Codex cài qua npm chạy bằng `node.exe` trên PATH khi ở trong Electron.
- Quyết định và việc tiếp theo: [nimbalyst-extension.md](nimbalyst-extension.md).

## Mốc còn lại

| Mốc | Đã có | Còn thiếu |
| --- | --- | --- |
| M0 foundation | Schemas/compiler/libraries/snapshots, khóa thư viện liên process + revision draft | Rà soát contracts toàn bộ |
| M1 core | Default orchestration, reviewer pool, repairs, lifecycle/recovery, writer song song + integration (template `parallel`) | Writer trước fork, nhiều integration, review từng nhánh; impact mapping chi tiết |
| M2 workspace/memory/CLI | Isolated worktree, reviewed commit, memory UI/audit, CLI cơ bản | Current checkout/dirty attribution/shared workspace/read leases; CLI control parity và graceful signals |
| M3 editor/monitor | Flow/profile/memory/run UI, browser verification | Cấu hình graph đầy đủ và accessibility/acceptance rộng hơn |
| M4 standalone | Codex E2E thật trên Linux và Windows (Dev, song song không conflict); Claude Code runner với E2E thật trên Windows | Graph branches tổng quát; Claude trên Linux; executor check độc lập runner |
| M5 Nimbalyst | Đã khảo sát public SDK 0.7.1 | Chưa adapter; thiếu public stop proof, workspace/sandbox và effective binding contracts |
| M6 acceptance | Đối chiếu từng mục ở [acceptance-matrix.md](acceptance-matrix.md); 5/10 mục đạt, 4 một phần | Mục 10 (browser tests, host acceptance), pilot Calculator thật |

Không thay scope thiết kế đã chọn bằng phạm vi executor hiện tại. Các trường hợp chưa hỗ trợ được chặn tại preview/preflight; không mô tả chúng là đã chạy được.
