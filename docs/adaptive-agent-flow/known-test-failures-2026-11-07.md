# Các ca test chưa ổn định trên Windows — 07/11/2026

Đã đưa vào backlog để debug sau theo yêu cầu người dùng. **Chưa xác định nguyên nhân, chưa sửa lỗi.** Hai ca dưới đây fail trong suite nhưng pass khi chạy riêng; việc chạy lại pass không chứng minh lỗi đã hết.

## Môi trường và kết quả

- Windows, Node 24.19.0; working tree sau commit `7445ef3` cùng các thay đổi Fast/sandbox chưa commit.
- Suite cuối sau thay đổi sandbox: **262 test, 257 pass, 2 fail, 3 skip**, không cancelled; thời gian khoảng 28 phút 44 giây. Giới hạn 2 nhóm test chạy đồng thời.
- Chạy lại đúng hai ca tuần tự, không đổi code/assertion/timeout: **2/2 pass**, khoảng 44 giây.
- Các ca này dùng fake CLI/runner. Không cần chạy inference thật để tái hiện.

## 1. Scope của lượt Claude không còn active tại assertion

Nguồn: [claude-cli.test.ts](../../test/claude-cli.test.ts), test `a Claude turn runs in a process scope, continues its session and returns verified output` (dòng 108 tại thời điểm ghi nhận).

- Assertion lỗi: `assert.ok(await first.scope.isActive())`.
- Kỳ vọng `true`, thực tế `false` trong suite; ca kết thúc sau khoảng 1.438 ms.
- Khi chạy riêng: pass sau khoảng 2.887 ms.
- Cần điều tra thứ tự nhận init/result/close của fake CLI và thời điểm truy vấn Job Object/process. Đây là hướng kiểm tra, chưa phải kết luận race hoặc lỗi Codex/Claude thật.

## 2. Đỉnh reviewer chạy đồng thời chỉ đạt 1 thay vì 2

Nguồn: [local-run.test.ts](../../test/local-run.test.ts), test `multiple required reviewers run concurrently within the per-run cap and all must pass` (dòng 209 tại thời điểm ghi nhận).

- Assertion lỗi: `assert.equal(f.peakReviews(), 2)`; thực tế `1`.
- Trong suite: khoảng 47.433 ms. Khi chạy riêng: pass sau khoảng 39.174 ms.
- Fixture dùng timer để hoàn tất lượt review. Cần đo thời gian chuẩn bị/dispatch, đoạn Git đồng bộ, timer và hàng đợi khi có tải; chưa có bằng chứng để quy nguyên nhân cho tải máy hay scheduler.

## Cách tái hiện

Từ gốc repo, dùng terminal Windows có quyền chạy Git/Job Object như app:

```powershell
npm run build
node scripts/run-tests.mjs --test-concurrency=2 'dist/test/*.test.js'
```

Đối chiếu khi chỉ chạy hai ca, tuần tự:

```powershell
node scripts/run-tests.mjs --test-concurrency=1 '--test-name-pattern=a Claude turn runs in a process scope|multiple required reviewers' dist/test/claude-cli.test.js dist/test/local-run.test.js
```

Đây là cùng test runner và cơ chế thư mục tạm của `npm test`. Không bỏ assertion, tăng timeout hoặc skip để làm suite xanh trước khi chứng minh nguyên nhân.

## Bằng chứng đang có

Log trên máy hiện tại (không commit, có thể mất khi dọn Temp):

- `%TEMP%/neomind-sandbox-full.log`: suite fail hai ca.
- `%TEMP%/neomind-sandbox-recheck.log`: chạy lại 2/2 pass.
- `%TEMP%/neomind-sandbox-targeted.log`: 14/14 ca adapter/check/admission đạt.

Các lỗi transport/crash recovery/timeout ở những lượt trước cùng ngày được giữ trong bàn giao 07/11; không tự coi chúng có cùng nguyên nhân với hai ca hiện tại.

## Khi tiếp tục

Thu thập timeline và PID/scope state khi chạy riêng lẫn trong suite; xác định assertion đang kiểm hành vi sản phẩm hay phụ thuộc timing của fixture. Sau khi sửa nguyên nhân, chạy lại ca riêng và suite với điều kiện ban đầu. Giữ riêng bằng chứng mode sandbox/stop và lỗi timing; không coi probe metadata/command là một flow inference thật.
