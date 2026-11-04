# Bàn giao — 04/11/2026

Branch `codex/temporary-workflow-memory`, baseline trước đợt này `3d7aedf`, code commit `1204e8f`. Người dùng yêu cầu triển khai tám việc còn lại: workflow nhiều giai đoạn, checkout/shared workspace, cleanup race, canvas, version diff, run input/output, lesson revisions và memory retrieval. Code của các phần này đã được nối vào core/UI; xem bảng mới nhất trong [implementation-status](implementation-status.md). Không dùng Astra; không push hoặc tạo PR trong đợt này.

## Cách review nhanh

```bash
npm test
npm run build:ui
npm run neomind -- editor /duong/dan/toi/repo
```

- Run mới có lựa chọn workspace: theo flow, isolated worktree, checkout hiện tại hoặc shared. Shared/current giữ một writer lease và chạy writer tuần tự; chọn dùng dirty baseline nếu checkout có thay đổi. Commit mặc định chỉ phần run; staging và untracked của người dùng được giữ. Nếu không tách được thay đổi chồng lên baseline, run vẫn chờ quyết định như trước.
- CLI: `run preview <repo> dev --workspace current`, sau đó `run start <repo> dev "task" --workspace current --import-dirty <baseline-hash>` khi dirty. API preview/create nhận `workspaceMode`. Đừng dùng hash từ preview của workspace mode khác.
- Isolated flow có writer trước/sau fork, nhiều giai đoạn integration, branch review và branch repair. Review nhánh dùng criteria của node và checks riêng; review sau tích hợp dùng thêm toàn bộ checks/criteria đã duyệt. Các checks riêng cũng phải nằm trong plan trước khi được duyệt. Fork lồng nhau hoặc integration trước join chưa có workspace contract đầy đủ nên vẫn bị preflight chặn; không quảng bá executor là DAG tùy ý.
- Canvas: thả đầu nối vào pane hoặc bấm “Thêm bước tiếp theo”; Ctrl/Cmd+C/V sao chép nhóm và cạnh nội bộ, Ctrl/Cmd+A/S/Z, Delete/Backspace, Escape; inspector có select node/cạnh cho bàn phím. Node start được giữ. Bản sao giữ vị trí tương đối cả khi template chưa lưu layout. Diff thuộc tính có nút hiện thêm mỗi 200 thay đổi.
- Run graph ghi prompt/output theo attempt, hash và nguồn task/memory/plan/artifact/check/code. Cạnh liền là điều khiển, cạnh đứt là provenance dữ liệu thực đã ghi. Payload tải qua `/api/runs/:id/node-data/:attemptId`; không tự biến cạnh dữ liệu thành mapping thực thi. Giới hạn một triệu ký tự có cờ truncated và hash gốc; run cũ không có payload vẫn đọc được.
- Lesson edit tạo revision file mới; proposal hash gồm version. Approval cũ không được dùng cho version mới, kể cả khi nội dung được đổi trở lại bản ban đầu. Sửa/duyệt/từ chối được serialize cùng library lock.
- Memory: chọn lexical/semantic/hybrid; LSA cục bộ học từ corpus project, tối đa 512 record sau scope/tag filtering, không dùng dịch vụ embeddings ngoài. Path inference dùng đường dẫn trong task và tên file/thư mục qua danh sách Git. Dedup theo nội dung chuẩn hóa cùng loại/scope/tags; `expiresAt`/`supersedes` loại record khỏi run context, không xóa Markdown. Supersession cycle bị chặn. Không tự coi fact là sai chỉ vì cũ theo thời gian.

## Cleanup giữ dữ liệu

`run clean` hiện chuyển nguyên thư mục vào `<state>/workspaces/.retained/<run>`, sửa lại Git registration và nhả lease của đường dẫn cũ. Không dùng `git worktree remove --force` hoặc recursive delete nữa: tiến trình ngoài vẫn mở file/cwd sẽ ghi vào bản được giữ thay vì làm mất dữ liệu giữa lần kiểm tra và lệnh xóa. UI hiển thị đường dẫn khôi phục. Các thư mục này vẫn chiếm dung lượng và vẫn có Git registration; chưa có auto-purge. `--force` cho phép chuyển các thay đổi chưa giao vào vùng lưu khôi phục, không còn mang nghĩa xóa sạch file. Checkout/shared workspace của người dùng không bao giờ được dọn bằng cơ chế này.

## Kiểm chứng

- Linux: bộ suite cuối 207 tests, 196 pass, 11 skip, 0 fail; các skip là Windows/Claude process-scope. UI build và extension Nimbalyst build thành công. Có cảnh báo UI bundle >500 kB và URL dist-ui được resolve ở runtime trong extension backend.
- Test mới gồm hai fork/hai integration và writer trước/sau, branch repair/check context, checkout/shared giữ staged+unstaged+untracked, index.lock fencing, late write qua file descriptor sau retirement, rename conflict với newline trong tên file, binary resolution manifest, input tampering, source evidence đúng baseline, proposal revision/revert và LSA/memory lifecycle.
- Luna 6 thật: run `run-c2f7b2a1-eed4-4c7e-b5e8-821408370b75`; fixture auto-approval opt-in riêng, không giả mạo approval người dùng. Hai nhánh tạo conflict text + binary, integration giải quyết, check `node verify.cjs` pass, review độc lập pass, commit `9251a0d7a867fc8e7364e3d2579283042486cd54`. Đã resume từ journal qua hai lỗi phát hiện thực tế: core ghép lời dẫn với JSON manifest, rồi reviewer không có source bytes trong context. Core nay lấy message cuối và cấp source evidence từ đúng baseline. Usage cuối: 195388 tokens, trong đó 118016 cached input tokens. Không cần chạy thêm inference chỉ để lặp lại kết quả.
- Evidence local bị ignore: `demo/workflow-acceptance/real-1793708133433/report-resumed.json`, journal/transcripts và worktrees bên cạnh. Script tái hiện có opt-in quota: `node scripts/acceptance-conflicts.mjs --real`.
- Chưa browser acceptance hoặc screen-reader acceptance cho UI mới; browser automation đã bị từ chối trước đó và không tìm cách vòng qua. Chưa chạy acceptance mới trên Windows hoặc host Nimbalyst. Build extension đạt không thay thế host acceptance. Những phần v1 ngoài tám yêu cầu này như host notifications/pilot Calculator giữ trạng thái riêng trong acceptance matrix.

## Điểm cần giữ khi làm tiếp

- Baseline nhánh và commit integration được giữ bằng refs riêng trước journal intent, để Git GC không mất snapshot đang chờ recovery.
- Shared commit giữ Git index.lock xuyên suốt cập nhật HEAD và atomic index replacement; khi outcome chưa rõ thì chờ đối chiếu, không tự replay.
- Không bỏ gate approval/independent review để làm fixture xanh. Các gói source evidence là dữ liệu tham khảo được kiểm tra hash/baseline, không tự là verdict.
- File TypeScript cũ dùng CRLF được giữ nguyên convention; kiểm whitespace bằng `git -c core.whitespace=cr-at-eol diff --check`.
