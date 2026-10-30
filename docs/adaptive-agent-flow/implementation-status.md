# NeoMind v1 — trạng thái implementation

Cập nhật: **29/10/2026**. Branch: `hieu/adaptive-agent-flow`. Baseline trước đợt này: `d19c998`. **V1 chưa hoàn tất.** Đọc [bàn giao hiện tại](session-handoff-2026-10-29.md) để tiếp tục; [design-v1](design-v1.md) là phạm vi mục tiêu.

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
