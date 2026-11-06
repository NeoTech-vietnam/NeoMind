# NeoMind v1 — trạng thái implementation

Cập nhật: **04/11/2026**. Branch: `codex/temporary-workflow-memory`. Baseline: `3d7aedf`.
Bàn giao hiện tại: [06/11/2026 Flow Studio](session-handoff-2026-11-06-flow-studio.md); trước đó [05/11/2026 Flow Studio](session-handoff-2026-11-05-flow-studio.md), [04/11/2026 Windows](session-handoff-2026-11-04-windows.md) và [Linux](session-handoff-2026-11-04.md). Phạm vi v1 rộng hơn tám việc vừa triển khai; đã có walkthrough browser cho Dev tuần tự bên dưới, các thao tác canvas nâng cao, Windows và host acceptance Nimbalyst vẫn cần kiểm chứng riêng.

## Thiết kế lại giao diện · GĐ 4 — 06/11/2026

Trên `ui/redesign-p4`, Profiles có danh sách profile có sẵn và project, chỉnh hướng dẫn/quyền/skills, nhân bản, lưu nháp và publish có `expectedRevision`; tab sử dụng lấy tham chiếu từ draft flow. Memory có trạng thái root, hàng đợi lesson (duyệt, sửa, từ chối), bảng và sheet chi tiết, sửa context/quyết định và policy. API `memory/preview` sẵn có được dùng để xem thử theo task với policy đã lưu. Không đổi backend.

| Kiểm chứng Windows | Kết quả |
| --- | --- |
| `npm test` | 222 test: 220 pass, 2 skip, 0 fail; test parallel writers đạt. Probe Claude CLI ước tính ~$0.0022. |
| TypeScript UI, build UI, build extension | Đạt; build extension còn cảnh báo sourcemap Tailwind và URL `dist-ui` resolve khi chạy. |
| Edge headless, gallery dữ liệu giả | Profiles và Memory ở tối/sáng, web 1440/panel 900; có dialog tạo profile, root chưa chọn, lesson, sheet chi tiết, policy, Skills và profile đã sửa. Chưa kiểm host Nimbalyst thật. |

Không hiển thị cảnh báo hash skill lệch, revision/cập nhật của toàn bộ root, cập nhật profile mới sang flow hoặc nội dung phiên bản profile cũ: API hiện có không cung cấp các thao tác/dữ liệu đó. Menu phiên bản chỉ liệt kê số phiên bản. `styles.css` còn 168 dòng vật lý, chủ yếu các rule shell và control cũ dùng chung/Flow Studio; class riêng Profiles/Memory đã bỏ. Xem lại bằng vite dev tại `/__gallery/profiles.html` và `/__gallery/memory.html`; hash `light`, `panel`, `create`, `edited`, `skills`, `usage`, `root`, `detail`, `policy` chọn trạng thái.

## Thiết kế lại giao diện · GĐ 3 — 05/11/2026

**Hoàn thiện 06/11:** Header dùng Button/DropdownMenu; inspector dùng Input, Textarea, Field và Select với portal chung. Tên bước sửa ở header; vòng sửa và join chọn bước bằng checkbox, vẫn hiển thị các ID cũ không còn phù hợp để có thể bỏ chọn. Đã xem gallery ở theme tối/sáng, 1440 và panel 900 với inspector, thêm bước, so sánh, lỗi, menu; CDP mở Select và chọn Opus 5.5, xác nhận chip `Claude Code · Opus 5.5`. TypeScript UI, build UI và build extension đạt; không chạy lại `npm test` theo yêu cầu. Chưa kiểm portal trong host Nimbalyst thật.

Flow Studio trên branch `ui/redesign-p3`: header một hàng, dải thêm bước và tìm bằng `/`, thẻ React Flow theo token, inspector và ngăn Vấn đề, so sánh phiên bản trong sheet. Inspector panel dùng `SheetContent`; gallery `/__gallery/flow.html` dùng transport giả và chỉ có ở vite dev. Không đổi backend, không chạy flow thật. Validate không phân biệt mức độ nên mọi diagnostic được trình bày là lỗi; mô phỏng flow và cảnh báo riêng không hiển thị. So sánh từng thuộc tính tiếp tục dùng diff JSON hiện có.

| Kiểm chứng Windows | Kết quả |
| --- | --- |
| `npm test` | 222 test: 219 pass, 1 fail, 2 skip. Test song song báo peak 1 thay vì 2; chạy riêng test đó đạt 1/1. Fixture có timeout 5 giây, chưa xác định chắc nguyên nhân lỗi trong suite. |
| `npm run build:ui`, build extension, `npx tsc -p tsconfig.ui.json --noEmit` | Đạt. Build extension có cảnh báo sourcemap của Tailwind và cảnh báo URL `dist-ui` resolve khi chạy. |
| Edge headless, gallery dữ liệu giả | Đã xem tối/sáng 1440 và panel 900, inspector, thêm bước, diagnostic và sheet so sánh. Chưa kiểm tương tác toàn bộ bằng CDP hoặc trong host Nimbalyst. |

Bàn giao GĐ 3: [05/11/2026](session-handoff-2026-11-05-flow-studio.md). Panel Nimbalyst và lần chạy lại suite đầy đủ để xác định test song song còn dành cho session điều phối.

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
