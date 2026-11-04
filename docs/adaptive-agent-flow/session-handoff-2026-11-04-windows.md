# Bàn giao — 04/11/2026 (Windows)

Tiếp nối [bàn giao 04/11 trên Linux](session-handoff-2026-11-04.md). Branch `codex/temporary-workflow-memory`, base `be9e936`. Người dùng chép checkout từ Linux sang Windows 11 và yêu cầu chạy `npm test`, sửa lỗi, rồi đơn giản hóa phần dọn worktree. Không push, không chạy inference thật.

## Môi trường

- Windows 11, Node 24.18.0, Git 2.53.0, Codex CLI 0.166.0, Claude Code 2.1.312.
- Checkout chép từ Linux bị hỏng Git: thư mục là submodule, `.git` trỏ tới `../.git/modules/NeoMind` không có trên máy. Đã gắn lại bằng clone `--no-checkout` từ `NeoTech-vietnam/NeoMind` rồi `reset` (mixed) về `origin/codex/temporary-workflow-memory`; working tree khớp hoàn toàn. Đặt `core.autocrlf=false` cục bộ vì Git for Windows bật `true` toàn hệ thống. Ref cục bộ chỉ có trên máy Linux (`refs/neomind/*`, stash) không được mang sang.
- `node_modules` từ Linux không có shim `.cmd` trong `.bin`; chạy `npm ci` lại.

## Đã sửa

| Lỗi trên Windows | Nguyên nhân | Sửa |
| --- | --- | --- |
| Rename conflict với newline trong tên file | NTFS không cho newline trong tên | Test dùng tên non-ASCII trên Windows (Git cũng C-quote nếu không tách bằng NUL) |
| Cleanup giữ ghi muộn qua rename | Windows không đổi tên thư mục khi có handle bên trong; intent có thể kẹt | Đổi thiết kế cleanup, xem dưới |
| Session `wait` rồi `apply` bị từ chối | Phase `completed` được ghi trước `autoClean`; run vẫn `busy` | `wait` chờ run settle (`RunManager.settle`) khi phase không còn running |
| Ngắt Claude: process cháu còn `alive` | `ActiveProcesses` của job về 0 trước khi process được signal | Helper `stop` mở handle các thành viên job trước khi terminate, chỉ báo `stopped` khi tất cả đã signal |

## Thiết kế cleanup mới (người dùng duyệt)

Phân tích: trong 4 flow có sẵn, chỉ Fast chưa áp dụng và run bị hủy còn dữ liệu duy nhất trong worktree; Dev, Dev song song, Research đã có kết quả trong ref/journal. Cơ chế rename + baseline ba lần + fingerprint ignored chỉ bảo vệ hai trường hợp đó, không giải phóng dung lượng và hỏng trên Windows.

- `clean()` ghi intent (worktree, delivery refs, file chưa giao), rồi với mỗi worktree: `snapshotBeforeRemoval` chụp tracked + untracked (index riêng, `snapshotWorkspace`) vào `refs/neomind/<run>/snapshot/workspace` hoặc `.../snapshot/branch/<node>`; xóa bằng `fs.rm` (retry ngắn) và `git worktree prune`; ghi `workspace_cleaned { snapshots }`.
- Snapshot chụp lúc thực hiện, không lúc ghi intent; ref đã tồn tại thì không chụp lại, để lần xóa dở (Windows) không ghi đè bản đầy đủ.
- `--force` vẫn cần khi còn thay đổi chưa giao; ignored files không vào snapshot và bị xóa khi force.
- Journal cũ có `baselines`/`ignoredBaselines`/`retained` vẫn replay; UI vẫn hiện thư mục `.retained` của run cũ. Các thư mục `.retained` đã có không tự xóa.
- Đánh đổi chấp nhận: ghi từ chương trình ngoài trong khoảng giữa chụp và xóa sẽ mất.
- Khác kế hoạch đã duyệt: kế hoạch ghi xóa bằng `git worktree remove --force --force`; thực tế dùng `fs.rm` rồi `git worktree prune`, vì Git dừng giữa chừng khi gặp file bị khóa trên Windows và khó báo lỗi rõ. Tác dụng phụ: `prune` cũng gỡ đăng ký mọi worktree khác của repo có thư mục đã mất (worktree bị `lock` thì không), không chỉ worktree của NeoMind.
- Thay đổi được gộp thành một commit (`61670bc`) thay vì commit theo từng việc, vì công cụ commit của Nimbalyst yêu cầu đề xuất toàn bộ file đã sửa trong session.

## Kiểm chứng

- `npm test` trên Windows: 208 test, 206 pass, 0 fail, 2 skip. Lần đầu (trước khi sửa): 207 test, 201 pass, 4 fail, 2 skip. `build:ui` và build extension đạt.
- Chưa chạy run thật Codex/Claude trên Windows sau đợt này; chưa kiểm chứng host Nimbalyst; chưa chạy suite trên Linux với thiết kế cleanup mới.

## Việc tiếp theo gợi ý

- Chạy `npm test` trên Linux để xác nhận cleanup mới (test Windows-only bị skip ở đó).
- Cho phép *Áp dụng vào checkout* từ snapshot ref sau khi run Fast đã bị dọn (hiện vẫn từ chối).
- Cân nhắc lệnh xóa các thư mục `.retained` cũ.
