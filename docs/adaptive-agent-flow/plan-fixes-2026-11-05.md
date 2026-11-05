# Kế hoạch sửa sau lần dùng thật đầu tiên — 05/11/2026

Trạng thái: **đã duyệt và thực hiện 05/11/2026**; kết quả trong [implementation-status](implementation-status.md). Nguồn: run `run-0f7e84e0…` trên `leetcode-practice` (xem mục đầu [implementation-status](implementation-status.md)). Base: `a8773d3` trên `codex/temporary-workflow-memory`.

## Cách chia việc

Năm gói việc, chia theo **file code mà mỗi gói đụng tới**, để chạy song song trong năm session Nimbalyst, mỗi session một worktree và một nhánh riêng. Gói A và B cùng sửa `src/runtime/local-run.ts` nhưng ở hai vùng xa nhau (prompt ở khoảng dòng 495–535; vòng đời ở khoảng dòng 380–460), nên khi gộp dự kiến không xung đột; nếu có thì người tích hợp xử lý.

| Gói | Việc | File chính | Cần quota thật? |
| --- | --- | --- | --- |
| A | Vòng sửa thấy được lỗi của check; planner biết check không được ghi vào repo | `src/runtime/local-run.ts` (prompt writer/planner) | Không, fake runner |
| B | Dừng trước vòng sửa khi không đủ thời gian; tự dọn worktree khi hủy run chưa có thay đổi | `src/runtime/local-run.ts` (`stop`, scheduler) | Không |
| C | Check làm đổi baseline thì báo đúng file nào; giảm file rác do check sinh ra | `src/core/codex-check-dispatch.ts`, `src/adapters/codex-check.ts` | Không |
| D | CLI: `--task-file`, `--feedback-file`, xuất plan ra Markdown | `src/cli/run-command.ts`, `src/cli/main.ts`, README (mục CLI) | Không |
| E | Tái hiện lỗi sandbox Windows không tạo được thư mục con | `scripts/` (script mới), báo cáo | Không gọi model; chạy Codex app-server `command/exec` thật |

## Quy tắc chung cho mọi session

- Làm trong worktree riêng, từ base `a8773d3`. Chạy `npm ci` trước (worktree mới không có `node_modules`).
- Đọc `AGENTS.md`. Code, comment, commit message tiếng Anh; viết code giống code xung quanh.
- Không chạy run thật tốn quota model. Test dùng fake runner (`test/helpers/fake-runner.ts`, `fake-claude.ts`).
- **Không sửa tài liệu dùng chung**: `implementation-status.md`, các file bàn giao, `AGENTS.md`, `direction-2026-11.md`. Người tích hợp cập nhật chúng. Riêng gói D được sửa mục CLI trong README.
- Không sửa file ngoài phạm vi gói; cần sửa thì ghi rõ trong báo cáo cuối.
- Trước khi xong: test liên quan pass, rồi `npm test` toàn bộ một lần. Commit trên nhánh của mình (một hoặc vài commit nhỏ), **không push, không merge**.
- Báo cáo cuối: đã làm gì, file nào, kết quả test, việc chưa làm hoặc còn nghi ngờ.

## Gói A — vòng sửa thấy được lỗi

Vấn đề: `writeTurn` (khoảng `local-run.ts:530`) đưa vào prompt "Repair findings" chỉ các artifact `kind === 'agent'`; output check (`kind: 'check'`, ghi ở khoảng dòng 572) bị bỏ. Writer Claude không có shell nên không tự thấy lỗi và sửa mò.

1. Khi có vòng sửa, prompt writer có thêm output của các check **hỏng trong lượt review gần nhất**: lệnh, exit code và phần cuối output (giới hạn khoảng 200 dòng hoặc 20000 ký tự mỗi check, ghi rõ khi bị cắt). Không đưa output check đã pass.
2. Thêm hướng dẫn: nếu lỗi do môi trường (quyền, sandbox, thiếu công cụ) chứ không do code, không sửa code để lách; nói rõ trong tin nhắn cuối để reviewer và người dùng thấy.
3. Prompt planner (khoảng dòng 501, khi `outputContract === 'plan'`): check không được ghi file vào cây làm việc của repo (bytecode, build output); nếu cần file tạm thì dùng thư mục tạm của hệ thống hoặc đường dẫn đã bị ignore.
4. Test: fake runner, check hỏng ở vòng đầu, khẳng định prompt writer vòng sửa chứa output check hỏng và không chứa output check đã pass; output dài bị cắt có đánh dấu.

## Gói B — thời gian và hủy run

1. Trước khi bắt đầu một **vòng sửa** (writer sau review không đạt), nếu thời gian còn lại ít hơn ngưỡng (đề xuất: lớn hơn của 5 phút và thời gian vòng writer + review trước), dừng ở `paused` với lý do rõ ("không đủ thời gian cho vòng sửa; gia hạn rồi tiếp tục") thay vì chạy rồi bị cắt giữa chừng. Không đổi hành vi deadline hiện có (khoảng dòng 430).
2. Khi hủy run (`stop('cancel')`, khoảng dòng 382–398) với workspace isolated, nếu không còn thay đổi chưa giao (`unsavedChanges` rỗng) thì dọn worktree như `autoClean` (snapshot rồi xóa). Có thay đổi thì giữ nguyên như hiện nay. Lỗi khi dọn không được làm hỏng việc hủy.
3. Test: run hủy khi đang lập plan → worktree bị dọn; run hủy khi đã có thay đổi → giữ; vòng sửa không đủ thời gian → `paused` với lý do mới; resume sau `extend-time` chạy tiếp.

## Gói C — check làm đổi baseline

Vấn đề: `codex-check-dispatch.ts:46` chỉ báo "Check changed the reviewed baseline"; người dùng không biết file nào. Lần này là `tools/__pycache__/` do `py_compile` sinh ra.

1. Khi baseline đổi sau check, lỗi liệt kê các đường dẫn bị thêm, sửa, xóa (so `entries` của hai lần `captureBaseline`; tối đa khoảng 20 đường dẫn), kèm gợi ý ignore hoặc bỏ file do check sinh ra. Giữ nguyên ngữ nghĩa an toàn: vẫn chặn, vẫn cần đối chiếu.
2. Xem `command/exec` của Codex app-server có nhận biến môi trường không (đọc giao thức hoặc thử nhanh). Nếu có, đặt `PYTHONDONTWRITEBYTECODE=1` cho check. Nếu không, ghi lại trong báo cáo, không tự chế cách khác.
3. Test: check giả tạo một file untracked → lỗi chứa đúng đường dẫn đó.

## Gói D — CLI

1. `run start … --task-file <file>`: đọc task UTF-8 từ file (thay cho đối số task; không cho dùng cả hai). `run changes … --feedback-file <file>` tương tự. Lý do: truyền task nhiều dòng qua `cmd` của Windows bị cắt còn dòng đầu.
2. `run plan <project> <run-id> [--out <file>]`: in plan mới nhất (đang chờ duyệt hoặc đã duyệt) dạng Markdown gồm goal, approach, tiêu chí, checks, rủi ro, scope, phiên bản và `planHash`; `--out` ghi ra file. Dùng lại cho editor/extension sau này nếu tiện, nhưng không bắt buộc.
3. Cập nhật `runUsage`, README mục CLI.
4. Test: parse đối số (kể cả lỗi khi dùng cả hai cách nhập task), task nhiều dòng đọc nguyên vẹn, Markdown của plan có đủ các phần.

## Gói E — tái hiện lỗi sandbox (Windows)

Vấn đề: trong check, `selftest.py` gọi `os.makedirs(<thư mục vừa tạo>/templates)` và bị `WinError 5`; ngoài sandbox chạy được. Cấu hình hiện tại: `sandboxPolicy: { type: 'workspaceWrite', writableRoots: [workspace], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true }` (`src/adapters/codex-check.ts:30`).

1. Viết `scripts/probe-check-sandbox.mjs`: tạo một repo/worktree tạm, mở worker scope Windows và chạy `command/exec` với cùng `sandboxPolicy`, thử các biến thể: tạo `a` rồi `a/b`; `os.makedirs('a/b/c')`; `mkdir` của `cmd`; tạo thư mục rồi ghi file bên trong; chạy với `cwd` ở gốc và ở thư mục con; có và không `excludeTmpdirEnvVar`.
2. Báo cáo: biến thể nào hỏng, nguyên nhân khả dĩ (ví dụ ACL của thư mục do sandbox tạo ra), phiên bản Codex CLI. Đề xuất cách sửa kèm đánh đổi an toàn; **không sửa code sản phẩm** trong gói này, trừ khi cách sửa rõ ràng, nhỏ và không nới quyền.
3. Script không gọi model. Nếu cần gọi model để tái hiện thì dừng lại và báo.

## Tích hợp (session hiện tại)

1. Chờ cả năm gói báo xong; đọc báo cáo và diff từng nhánh.
2. Gộp lần lượt A, B, C, D vào `codex-temporary-workflow-memory`; E chỉ lấy script nếu hữu ích.
3. `npm test`, `cd extensions/nimbalyst && npm run build`; cài lại extension nếu backend đổi.
4. Cập nhật `implementation-status.md`, viết bàn giao mới, commit.
5. Tùy người dùng: chạy lại một task nhỏ trên `leetcode-practice` để xác nhận vòng sửa hết sửa mò.

## Rủi ro

- A và B cùng sửa `local-run.ts`: xung đột khi gộp là có thể; người tích hợp xử lý.
- Năm session chạy `npm test` (khoảng 5–6 phút) cùng lúc trên một máy sẽ chậm hơn.
- E có thể không tìm ra nguyên nhân gốc; khi đó kết quả là báo cáo và một script tái hiện cho người làm tiếp.
