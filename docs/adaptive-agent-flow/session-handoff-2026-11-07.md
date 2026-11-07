# Bàn giao đồng bộ bản copy và cài extension — 07/11/2026

## Đồng bộ Git

- Người dùng yêu cầu đưa bản NeoMind từ `H:/Learning/test_workflow/test_workflow` về repo hiện tại và cài lại extension.
- Branch `hieu/adaptive-agent-flow` được fast-forward từ `5404c63` đến `7445ef3`: giữ nguyên lịch sử 54 commit, không tạo merge commit và không push.
- Mốc trước cập nhật được giữ tại `backup/before-copy-import-2026-11-07`; ref nhập là `refs/remotes/copied-neomind/adaptive-agent-flow`.
- Không nhập hai file flow thử chưa được Git theo dõi trong bản copy (`neomind/flows/test/draft.json`, `metadata.json`).
- Git metadata của checkout này nằm ngoài workspace, dưới `.git/modules/NeoMind` của repo cha; fetch và fast-forward cần quyền ghi tại đó.

## Build và cài đặt

- `npm ci --no-audit --no-fund --fetch-retries=0`: thành công, cài 116 packages.
- `npm run build:ui`: thành công; có cảnh báo chunk lớn hơn 500 kB.
- Build extension qua `extension_build`: thành công; panel 1.387,43 kB (gzip 371,05 kB), backend 1.032,09 kB. Có cảnh báo sourcemap Tailwind và URL `dist-ui` được resolve lúc chạy.
- `extension_install` từ `extensions/nimbalyst`: thành công; `extension_get_status` báo `local.neomind` loaded.
- Log host xác nhận phát lệnh reload extension từ checkout hiện tại. Backend đang mở vẫn đăng ký 18 tool của bản cũ; cần đóng/mở lại workspace để chạy backend mới. Không tự restart ứng dụng.

## Kiểm chứng

- `npm test` trong sandbox gặp lỗi quyền/process và SQLite; đã dừng lượt này để kiểm tra lại ngoài sandbox.
- Lượt `npm test` ngoài sandbox: **254 tests, 247 pass, 3 fail, 1 cancelled, 3 skip**, exit code 1; thời gian 992.303 ms (khoảng 16 phút 32 giây). TypeScript core build thành công.
- Ba ca fail: `app-server-transport` không nhận `approval/request` theo thời điểm assertion; `claude-cli` báo scope không còn active tại assertion; `crash-recovery` timeout khi chờ worker readiness. Ca `claude-runner` Dev E2E bị cancelled do timeout 120 giây. Chưa chẩn đoán nguyên nhân gốc; không suy ra toàn bộ là lỗi sandbox hay tải máy, không nới timeout hoặc sửa test.
- Probe Claude thật bị skip vì môi trường test báo chưa đăng nhập; không có inference thật trong lượt này. Các skip khác theo điều kiện nền tảng/quyền của suite.
- Log kiểm tra ngoài sandbox nằm tại `%TEMP%/neomind-import-tests-native-2026-11-07.log`; lượt sandbox bị dừng ở `%TEMP%/neomind-import-tests-2026-11-07.log`. Log nằm trên máy, không commit.
- Không khởi chạy flow thật và không thay đổi source để xử lý các lỗi test trong đợt đồng bộ.

## Tiếp tục

- Sau khi mở lại workspace, kiểm panel và tool mới trong một session mới. Trạng thái loaded của extension chưa chứng minh backend mới đã khởi động hoặc flow thật chạy đạt.
- Chi tiết tính năng vừa nhập và giới hạn còn lại: [bàn giao nâng cấp 06/11](session-handoff-2026-11-06-upgrade.md).


## Bổ sung: Fast cho project mới

- Người dùng duyệt: bật hai quyền mặc định chỉ khi project chưa có `project.json`; giữ nguyên cấu hình riêng.
- `src/runtime/project.ts` khai báo `newProjectPolicy` bật `allowAutoApproval` và `allowHumanReview` trong fallback; authoring và API validate/import canvas dùng cùng policy, không buộc thư mục thiết kế flow phải là Git repo. Không ghi file hoặc migrate cấu hình hiện hữu.
- Regression trong `test/fast-flow.test.ts`: project chưa có cấu hình dùng Fast, không tự tạo file; API validate đồng nhất; cấu hình cũ thiếu trường và cấu hình đặt false đều bị chặn, bytes của file được giữ nguyên.
- Test Fast 4/4 đạt (cả trong suite cuối), TypeScript core và build extension đạt; đã cài lại extension qua skill extension-development. Cần đóng/mở lại workspace để backend mới có hiệu lực.
- Lượt suite đầu sau sửa API bị dừng khi phát hiện đường validate trong thư mục không có Git không nên dùng `readProject`; bản cuối dùng `authoringProject` với policy chung. Không tính lượt bị dừng là pass.
- Suite cuối: build rồi `node scripts/run-tests.mjs --test-concurrency=2 'dist/test/*.test.js'` (cùng build/test runner của npm test, giới hạn song song): **255 tests, 249 pass, 3 fail, 3 skip**, 1.001.240 ms. Probe Claude thật bị skip vì chưa đăng nhập. Log `%TEMP%/neomind-fast-default-final.log`.
- Hai lỗi review-impact là fixture materialize bằng policy cũ nhưng không lưu project.json, nên live policy dùng mặc định mới và bị core chặn đúng khi hash không khớp. Fixture nay ghi rõ policy dùng trong snapshot; không nới assertion hoặc bỏ gate. Ca nhiều reviewer ghi nhận peak 1 thay vì 2 trong suite; không sửa test này.
- Chạy lại ba ca tuần tự sau TypeScript build: **3/3 pass** (`node scripts/run-tests.mjs --test-concurrency=1 '--test-name-pattern=multiple required reviewers|a repair outside|a repair that changes shared' dist/test/local-run.test.js dist/test/review-impact-run.test.js`), gồm peak 2 reviewer. Log `%TEMP%/neomind-fast-default-recheck.log`. Chưa chạy lại toàn bộ suite sau sửa fixture; source bản extension không đổi sau lượt suite.
- Không tự chuyển policy của run đang dở sang mặc định mới: run không có cấu hình tường minh được tạo với policy mặc định cũ có thể dừng vì live policy hash đổi; guard này được giữ nguyên. Cấu hình tường minh cũ vẫn được đọc nguyên trạng.
- Không commit/push và không chạy flow thật trong đợt sửa Fast.


## Bổ sung: mặc định tắt sandbox Codex

- Người dùng chọn Agent + checks NeoMind và duyệt phương án triển khai trong widget. Không đổi sandbox của session chat Nimbalyst.
- Policy `codexSandbox` optional: enabled hoặc disabled. Run mới ghi mode mặc định disabled vào runtime context; run cũ thiếu trường dùng enabled. Không chèn default vào policy schema để tránh đổi hash/sửa ý nghĩa snapshot cũ. Cấu hình enabled tường minh được tôn trọng, thay đổi policy đang chạy vẫn bị kiểm hash.
- Reader/writer/check adapter dùng dangerFullAccess khi disabled; kiểm runtime trả đúng mode lúc start/resume. Không giả lập sandboxVerified=true: probe disabled chỉ kiểm stop, cache tách theo mode. Job Object/systemd, approval, lease, baseline và review gate được giữ. Vai trò chỉ đọc/phạm vi ghi không được OS bảo đảm khi disabled; preview và prompt nêu rõ.
- UI, tool preview và run summary có mode; nhãn checks không còn khẳng định luôn sandbox. README và hướng dẫn Windows đã cập nhật.
- Fixtures dựa trên scope OS cũ đặt enabled tường minh. Test mới kiểm cả hai mode, mismatch thực tế, check stop thất bại, admission và đọc context cũ. Có test resume journal dạng cũ; kết quả trong suite đầy đủ.
- TypeScript core, UI và extension build đạt; nhóm test adapter/check/admission 14/14 pass. Hai probe thật không inference: thread/start trả dangerFullAccess; node --version exit 0; stop worker confirmed. Probe capability disabled thực tế trả sandboxVerified=false, stopVerified=true.
- Suite đầy đủ sau build, chạy `node scripts/run-tests.mjs --test-concurrency=2 'dist/test/*.test.js'`: **262 test, 257 pass, 2 fail, 3 skip**, không cancelled, 1.724.210 ms. Test legacy journal giữ sandbox đã pass. Hai ca fail là scope Claude không active tại assertion và đỉnh reviewer đồng thời 1 thay vì 2.
- Chạy lại hai ca tuần tự với cùng assertion/timeout: **2/2 pass**, 43.565 ms. Chưa xác định nguyên nhân và chưa sửa; người dùng yêu cầu lưu để debug sau. Chi tiết, lệnh tái hiện và log: [các ca test chưa ổn định](known-test-failures-2026-11-07.md).
- Đã cài bản build mới qua extension_install, extension_get_status báo loaded. Backend mới cần mở lại workspace; run mới mặc định tắt sandbox, run cũ giữ mode đã ghi. Không restart app, không chạy inference, không commit/push. Linux chưa kiểm chứng thay đổi này.
- Ban đầu npm run build không tìm thấy tsc shim; npm rebuild typescript vite sửa lại bin links, không thay lockfile.
