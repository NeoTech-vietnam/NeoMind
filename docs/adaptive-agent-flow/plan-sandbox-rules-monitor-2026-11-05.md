# Kế hoạch: sandbox tùy chọn, rule của project, giám sát flow — 05/11/2026

Trạng thái: **chờ người dùng duyệt**. Base: `45b88be` trên `codex/temporary-workflow-memory`.

## Quyết định của người dùng (05/11/2026)

- **Sandbox cho checks là tùy chọn, mặc định tắt**, luôn có cảnh báo khi tắt. Người dùng tự bật khi việc có rủi ro cao. Quyết định này thay đổi quyết định v1 "checks luôn chạy qua sandbox Codex".
- **Rule của project** (`neomind/rules.md`) ràng buộc agent và được reviewer chấm, để giảm rủi ro khi không có sandbox.
- **Giám sát flow**: khi không có sandbox, có thể bật một bộ giám sát chạy song song, kiểm tra theo chu kỳ các thao tác của toàn flow và dừng flow nếu vượt phạm vi.

Giới hạn đã nêu với người dùng và chấp nhận: rule nằm trong prompt nên chỉ giảm khả năng chứ không chặn được; giám sát thấy tool call và kết quả, nhưng không thấy bên trong một check (một process duy nhất); giám sát theo chu kỳ dừng được flow sau vi phạm, không hoàn tác được.

## Phạm vi

- Tùy chọn sandbox chỉ áp dụng cho **checks**. Writer Codex vẫn chạy trong sandbox `workspace-write` của Codex như hiện nay; writer Claude vẫn không có shell và chỉ ghi trong thư mục đã duyệt. Mở rộng tùy chọn cho writer là việc khác, chưa làm.
- Một người dùng; trường `actor` giữ như hiện có để chừa đường cho nhiều người.

## Chia việc

| Gói | Việc | File chính | Chạy |
| --- | --- | --- | --- |
| **F** | `policy.checkSandbox`, chạy check trực tiếp trên máy, cảnh báo, gợi ý lỗi `WinError 5` khi bật sandbox | `src/domain/schema.ts` (policy), `src/adapters/` (executor mới), `src/core/codex-check-dispatch.ts`, `src/runtime/local-run.ts` (`newCheckWorker`, khoảng dòng 632), `src/runtime/run-manager.ts` (preflight), UI cảnh báo | Song song với G |
| **G** | `neomind/rules.md`: ghim vào run, đưa vào prompt mọi agent, reviewer chấm từng rule | `src/domain/materialize.ts`/snapshot, `src/domain/review-requirements.ts`, `src/runtime/local-run.ts` (`prompt`, khoảng dòng 220), UI preview/kết quả review | Song song với F |
| **H** | Giám sát flow: bộ kiểm tra cố định (mặc định khi tắt sandbox) và agent giám sát tùy chọn | `src/runtime/monitor.ts` (mới), `src/runtime/local-run.ts` (vòng chạy), `src/domain/schema.ts` (policy) | **Sau khi F và G đã gộp**, vì cần cả hai |

F và G cùng sửa `schema.ts` (khác schema), `local-run.ts` (khác vùng) và có thể cùng sửa UI run; người tích hợp xử lý nếu xung đột.

## Gói F — sandbox tùy chọn cho checks

1. **Policy.** `projectPolicySchema` thêm `checkSandbox: "none" | "codex"`, bỏ trống nghĩa là `"none"`. Giá trị thực tế được ghim trong snapshot của run (kiểm tra policy đã nằm trong cấu hình được hash; nếu chưa thì thêm), để đổi policy giữa chừng không đổi run đang chạy.
2. **Executor không sandbox.** Một executor mới cùng giao diện với `CodexCheckExecutor` (`run(spec, workspace, lease, coordinator, scope) → { exitCode, stdout, stderr, outputHash }`), chạy lệnh check bằng `ProcessScope` có sẵn (`allocateProcessScope()`: `WindowsProcessScope` trên Windows, `SystemdProcessScope` trên Linux), để vẫn dừng được cả cây process và vẫn có timeout.
   - `cwd` là worktree; argv, không qua shell; giữ nguyên kiểm tra cwd, lease, scope như executor cũ.
   - Môi trường: dựa trên `workerEnvironment()`, **xóa các biến có dạng secret** (tên chứa `TOKEN`, `SECRET`, `KEY`, `PASSWORD`, `CREDENTIAL`, `AUTH`, các biến `CODEX_*`/`CLAUDE_*`/`ANTHROPIC_*`/`OPENAI_*`); `TEMP`/`TMP`/`TMPDIR` trỏ vào một thư mục riêng của check nằm **ngoài** worktree trong thư mục state, tạo mới mỗi check và xóa sau; `PYTHONDONTWRITEBYTECODE=1`.
   - Giới hạn output giống executor cũ (1 MB).
   - Journal ghi chế độ sandbox của từng check (`check_scope_bound` hoặc event tương đương), để UI và review biết check đã chạy thế nào.
3. **Chọn executor.** `newCheckWorker`/dispatch chọn theo `checkSandbox`. Với `"none"`, checks **không cần Codex CLI**; preflight (`run-manager.ts:59`) chỉ yêu cầu Codex khi `"codex"` hoặc khi có binding dùng Codex. Recovery với check chưa rõ kết quả xử lý như hiện nay cho cả hai loại scope.
4. **Cảnh báo.** Preview (`flowExceptions` hoặc mục riêng) ghi rõ: "Checks chạy trực tiếp trên máy, không có sandbox: code do agent viết chạy với quyền của bạn (ghi ngoài repo, đọc file cá nhân, gọi mạng). Bật `checkSandbox: "codex"` trong `neomind/project.json` cho việc có rủi ro cao." Màn hình run hiển thị cùng cảnh báo; CLI `run preview` in ra.
5. **Gợi ý `WinError 5`** (khi `"codex"`): output check trên Windows có `WinError 5`/`Access is denied` thì artifact check được ghi thêm một dòng giải thích (thư mục tạo bởi `tempfile.mkdtemp` hoặc `mode=0o700` trên Python ≥ 3.12.4 không ghi được trong sandbox; dùng `os.makedirs` quyền mặc định, hoặc tắt sandbox). Xem `scripts/probe-check-sandbox.mjs` và mục sửa 05/11 trong `implementation-status.md`.
6. **Test** (fake runner, không quota): policy parse và mặc định; executor không sandbox chạy lệnh trong job/scope, timeout dừng được process con, env không còn biến secret, TEMP nằm ngoài worktree và bị xóa; preview có cảnh báo khi `"none"` và không có khi `"codex"`; preflight không đòi Codex khi `"none"` và mọi binding là Claude; gợi ý `WinError 5` được thêm đúng lúc. Test chạy thật process trên Windows giống các test Windows hiện có (skip ngoài Windows/Linux).

## Gói G — rule của project

1. **Định dạng.** `neomind/rules.md` (hoặc `.neomind/rules.md` theo `projectDir`). Mỗi rule là một dòng `- [R<số>] <nội dung>`; dòng khác là chú thích, bị bỏ qua. Mã trùng hoặc sai dạng là lỗi validation, báo ở preview. Không có file thì không có rule.
2. **Ghim vào run.** Khi materialize, đọc rule, ghim danh sách và hash vào snapshot (giống memory), để replay và review dùng đúng bản lúc chạy. Rule đổi sau khi run bắt đầu không ảnh hưởng run đó.
3. **Prompt.** `LocalRun.prompt` đưa rule vào mọi agent (planner, writer, reviewer, research), đặt sau instructions của profile, nhãn là **bắt buộc**, khác memory (chỉ tham khảo).
4. **Review.** `reviewRequirements` thêm mỗi rule thành một tiêu chí bắt buộc dạng `Rule R1: <nội dung>` cho review của code và research (không cho review nhánh nếu thấy không hợp lý; ghi lý do). Vi phạm thì `needs_changes` qua cơ chế tiêu chí hiện có.
5. **Hiển thị.** Preview liệt kê rule sẽ áp dụng (và lỗi validation); màn hình run hiển thị kết quả chấm theo từng rule (đã có trong evidence criteria, chỉ cần nhóm/nhãn cho dễ thấy). CLI `run plan` (gói D) không cần đổi.
6. **Test**: parse (hợp lệ, trùng mã, sai dạng, không có file), rule được ghim và không đổi khi file đổi sau đó, prompt mọi vai có rule, reviewer thiếu tiêu chí rule thì review không được chấp nhận, rule `fail` dẫn tới vòng sửa.
7. **Không** tự tạo `rules.md` cho repo nào; người tích hợp viết bản cho `leetcode-practice` từ R1–R5 trong AGENTS.md của repo đó.

## Gói H — giám sát flow (sau khi gộp F và G)

1. **Policy.** `policy.monitor`: `{ mode: "off" | "rules" | "agent", intervalSeconds?: number }`. Mặc định: `"rules"` khi `checkSandbox` là `"none"`, `"off"` khi `"codex"`. Ghim vào snapshot.
2. **Bộ kiểm tra cố định (`"rules"`).** Chạy sau mỗi attempt/check và theo chu kỳ trong lúc run chạy. Không dùng model. Dừng flow (`blocked`, kèm lý do và bằng chứng) khi:
   - checkout chính của người dùng (và các worktree khác của repo) đổi trong lúc run đang chạy ở chế độ isolated;
   - transcript có đường dẫn ghi ngoài worktree/writable roots, hoặc lệnh (writer Codex) gọi mạng/công cụ nằm trong danh sách chặn (`curl`, `wget`, `Invoke-WebRequest`, `ssh`, `scp`, `git push`, `npm publish`…; danh sách cấu hình được);
   - check tạo file mới ngoài worktree trong các thư mục theo dõi được rẻ (thư mục tạm của check đã bị xóa; HOME ở mức thư mục cấp một, nếu chi phí chấp nhận được — nếu không thì ghi là chưa làm);
   - check chạy quá số process hoặc thời gian cho phép (dựa trên job/scope).
3. **Agent giám sát (`"agent"`, tùy chọn).** Theo chu kỳ `intervalSeconds` (mặc định 120), một agent chỉ đọc (model rẻ, ví dụ Haiku hoặc Luna/low) nhận phần transcript mới, rule đã ghim, plan đã duyệt; trả `ok` hoặc `stop` kèm lý do và tham chiếu. `stop` thì dừng flow ở `blocked`. Token tính vào usage của run. Agent giám sát không có quyền ghi và không duyệt hay sửa gì.
4. **Hiển thị.** Lý do dừng do giám sát có nhãn riêng trong UI và CLI; người dùng `resume` được sau khi xem.
5. **Test** với fake runner/fake transcript: mỗi điều kiện dừng ở mục 2; chu kỳ chạy và dừng đúng; agent giám sát (fake) trả `stop` thì run `blocked`; `"off"` không chạy gì.

## Quy tắc chung cho session thực hiện

Như [kế hoạch 05/11](plan-fixes-2026-11-05.md): worktree riêng từ base, `npm ci`, đọc `AGENTS.md`, dùng Bash (không PowerShell), không kill process theo tên, chỉ fake runner, không sửa tài liệu dùng chung (người tích hợp cập nhật `implementation-status.md`, `v1-design-decisions.md`, `AGENTS.md`, README), commit trên nhánh riêng, không push/merge, báo cáo cuối có file, test, việc còn mở, tên nhánh.

## Tích hợp (session điều phối)

1. F và G chạy song song; gộp, `npm test`, build UI (`npm run build:ui`) và extension, cài lại extension.
2. Ghi quyết định vào `v1-design-decisions.md`; sửa `AGENTS.md`/README chỗ ghi "Codex CLI luôn cần vì checks chạy qua sandbox Codex"; cập nhật `implementation-status.md`.
3. Viết `neomind/rules.md` cho `leetcode-practice` từ R1–R5 (commit ở repo đó).
4. Mở session H từ commit đã gộp; gộp, test, cập nhật tài liệu như trên.
5. Đề xuất người dùng một run thật nhỏ trên `leetcode-practice` để kiểm chứng cả ba phần.

## Rủi ro

- Mặc định tắt sandbox áp dụng cho mọi project, kể cả project cũ; cảnh báo ở preview là lớp bảo vệ chính, nên phải luôn hiện.
- Lọc biến secret theo tên không chắc chắn bắt hết.
- Bộ kiểm tra cố định có thể báo nhầm (đường dẫn trong transcript chỉ được đọc chứ không ghi); ưu tiên đúng hơn đủ, ghi rõ trong lý do dừng.
- Agent giám sát tốn token theo chu kỳ; mặc định không bật.
