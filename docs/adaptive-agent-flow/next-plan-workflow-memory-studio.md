# Kế hoạch tiếp theo: Workflow, Memory và Flow Studio

Cập nhật: 04/11/2026 · Baseline: `3d7aedf` · Trạng thái: các chức năng trong tám hạng mục đã triển khai, đang hoàn tất kiểm chứng; xem bảng tiến độ bên dưới, các mục chưa kiểm chứng hoặc chưa thực hiện vẫn để mở.

## Tiến độ thực tế 04/11/2026

| Phần | Đã làm | Còn lại |
| --- | --- | --- |
| P0 | Cleanup: ~~atomic retirement vào `.retained`~~ thay ngày 04/11 (Windows) bằng snapshot ref `refs/neomind/<run>/snapshot/...` rồi xóa hẳn, xem [bàn giao Windows](session-handoff-2026-11-04-windows.md); source evidence đúng baseline và policy gates | Thư mục `.retained` do bản cũ tạo không tự xóa; *Áp dụng vào checkout* từ snapshot sau khi đã dọn chưa hỗ trợ |
| P1 | Connector insertion, multi-copy/delete, keyboard/selectors, draft/undo/redo, diff từng thuộc tính có tải thêm | Browser acceptance và kiểm tra screen reader thực tế |
| P2 | Journal input/output theo attempt, hash/provenance và cạnh dữ liệu riêng, payload tải theo yêu cầu | Browser acceptance cho live/recovery; không tự tạo mapping thực thi từ cạnh dữ liệu quan sát |
| P3 | Proposal revisions + stale approval protection; path inference; local LSA/hybrid; dedup/expiry/supersession | Kiểm chứng tương tác frontend thực và corpus memory lớn; LSA không có kiến thức pretrained |
| P4 | Writer trước/sau fork, nhiều integration, branch review/repair; current/shared + staged attribution; conflict text/binary và Luna 6 thật tới commit. Windows: `npm test` 208 test (206 pass, 2 skip), UI/extension build | Windows UI và run thật, browser, host Nimbalyst acceptance chưa chạy; các mục v1 ngoài tám yêu cầu giữ trạng thái riêng |

Lịch sử cũ thiếu metadata memory được hiển thị bằng text snapshot cũ. Memory preview là dự kiến: khi bắt đầu run core mới ghim revision thực.

## Mục tiêu

Cho người dùng tạo, hiểu, chạy và theo dõi workflow agent trong một trải nghiệm liền mạch; project memory minh bạch và dùng chung giữa CLI, Flow Studio và Nimbalyst. Giữ model `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-luna`; không dùng Astra.

NeoMind đã có canvas React Flow, kéo thả, kết nối, undo/redo, draft/version, profiles, run monitor, transcript và memory CRUD/lesson proposal. Tài liệu acceptance 30/10 chưa theo kịp phần Claude và extension; cập nhật theo evidence, không đếm một tính năng đã tồn tại thành chưa làm.

## Tham khảo n8n

- [Executions](https://docs.n8n.io/workflows/executions/all-executions/): lọc lịch sử theo flow, trạng thái, thời gian và xem lại execution trên canvas. NeoMind giữ run snapshot khi flow bị sửa/xóa và phân biệt resume run cũ với tạo run mới; không tự retry một side effect chưa rõ.
- [Data mapping](https://docs.n8n.io/data/data-mapping/data-mapping-ui/): thể hiện dữ liệu đầu vào/đầu ra của bước và nguồn từ bước trước. Với NeoMind trước hết là xem plan, artifacts, checks, review và memory đã ghim; chỉ cho nối dữ liệu khi executor và schema thực sự hỗ trợ, không giả lập capability.
- [Focus panel của n8n](https://community.n8n.io/t/help-us-test-some-canvas-improvements/201703): chọn node để cấu hình bên cạnh canvas; bài viết mô tả một thử nghiệm. NeoMind đã có inspector, nên ưu tiên làm nó dễ hiểu, giữ nguyên graph khi chỉnh.

## P0 — An toàn và contract trước khi mở rộng

1. Sửa cleanup: so sánh trạng thái thực của từng branch worktree với tree đã lưu, từ chối tự dọn nếu có thay đổi mới; kiểm tra cả sau khi đã ghi cleanup intent. Regression có ref rồi sửa file trước dọn, và thay đổi xảy ra khi recovery. *(04/11, Windows: thay bằng snapshot ngay trước khi xóa; thay đổi mới, kể cả trong recovery, nằm trong snapshot thay vì làm cleanup từ chối.)*
2. Rà soát policy Fast: `requireApprovalBeforeWrite`/`requireIndependentReviewForCode` phải có nghĩa nhất quán với `allowAutoApproval`/`allowHumanReview`. Giữ khả năng cấu hình flow theo lựa chọn đang có, nhưng project gate bắt buộc không bị nới ngầm vì trường mới bị bỏ trống; có migration/diagnostic rõ cho cấu hình cũ. Không tự xóa Fast hay giả định user đã phê duyệt thay đổi policy.
3. Chuẩn hóa capability của từng graph: preview/canvas chỉ rõ node và cấu hình chạy được, chưa hỗ trợ, hoặc đang chặn; validate phía core là nguồn chuẩn. Cập nhật status/acceptance theo commit hiện tại (số test mới nhất: Linux 207 test, 196 pass, 11 skip; Windows 208 test, 206 pass, 2 skip, xem `implementation-status.md`).

**Xong khi:** test regression bảo vệ dữ liệu và policy đạt; preview giải thích blocker trước khi run; không thay đổi snapshot run cũ.

## P1 — Workflow canvas và inspector

1. Tổ chức một màn Flow Studio: thư viện bước có tìm kiếm và nhóm Agent/Approval/Review/Logic/Git; canvas trung tâm; inspector bên phải. Bắt đầu từ canvas, inspector, undo/redo và CRUD sẵn có, tránh viết lại engine.
2. Node hiển thị vai trò, runner/model/reasoning, inherit/pinned, trạng thái cấu hình và kết nối/outcome; reviewer bắt buộc/tư vấn và đối tượng được review nhìn thấy ngay. Inspector có các phần cơ bản/nâng cao, giải thích policy/provenance và lỗi ngay tại trường.
3. Nối node dễ hơn: thêm từ điểm nối, hiển thị loại outcome; chọn node/cạnh, pan/zoom/fit, multi-select, copy/paste và keyboard nếu chưa hỗ trợ. Các thao tác phải dùng cùng draft/undo/redo và không làm mất thay đổi. Cảnh báo tham chiếu bị ảnh hưởng trước khi xóa.
4. Đồng bộ canvas ↔ form ↔ draft; trạng thái chưa lưu, validate, publish/version, xem khác biệt version và xử lý conflict revision rõ ràng. Bảo toàn flow/profile đã có; migrate có kiểm thử nếu schema đổi.

**Xong khi:** tạo flow mới, đặt hai agent/reviewer, nối, chỉnh model, undo/redo, lưu, publish, reload và xem cấu hình giống nhau; keyboard cơ bản và test trình duyệt chạy trên desktop. Unsupported graph vẫn chỉnh được ở draft nhưng không publish/run nếu vi phạm contract.

## P2 — Run trực quan ngay trên graph

1. Tách rõ chế độ **Thiết kế** và **Run** cùng graph: run render snapshot bất biến, phủ trạng thái từng bước/nhánh; không dùng draft đang sửa làm sơ đồ lịch sử. Có lịch sử lọc theo flow, trạng thái, thời gian.
2. Chọn node xem tóm tắt đầu vào/đầu ra, plan, artifacts, checks, reviewer verdict, thời gian, tokens/unknown và link transcript. Hiển thị trạng thái stale/mất kết nối, đồng bộ lại từ journal; không suy diễn run đã kết thúc.
3. Approval/feedback, pause/resume/cancel, chờ Git và gia hạn hiển thị đúng trạng thái; phân biệt resume snapshot cũ và bắt đầu run mới từ version đã chọn. Không replay side effect khi kết quả chưa rõ.
4. Browser acceptance: approval thật trên fixture, repair, pause/recover, song song và lịch sử sau khi flow bị đổi/xóa. Test fake runner là mặc định; inference thật chỉ dùng fixture được phép và quota tối thiểu.

**Xong khi:** người dùng thấy node đang chạy, biết vì sao bị chặn, xem bằng chứng, duyệt plan và theo dõi tới completion; reload vẫn khớp journal.

## P3 — Memory minh bạch và dễ sử dụng

1. Cải thiện memory browser: tìm/lọc theo loại, scope, tag, trạng thái và nguồn; xem/sửa có revision conflict và audit; phân biệt context, quyết định xác nhận và lesson đã duyệt. Tái sử dụng Markdown store, CAS, registry và lesson proposals hiện có.
2. Hiển thị rõ memory nào được chọn cho từng run/bước, nguồn, revision/hash và lý do; snapshot trước run và trong lịch sử. Memory update sau khi run bắt đầu không âm thầm đổi context đã ghim.
3. Hàng đợi lesson proposals: xem trước, nguồn run/evidence, sửa/duyệt/từ chối khi contract hỗ trợ; approved mới vào retrieval chung. Xác nhận quyết định phải xuất phát từ người dùng; inference chưa xác nhận không tự thành fact/decision.
4. Cải thiện policy chọn memory theo scope/path/tag và ngân sách context; kiểm tra cách frontend/CLI/Nimbalyst dùng cùng registry, fail rõ khi root không khả dụng, không tự tạo root thay thế. Không phụ thuộc frontend.

**Xong khi:** tạo context/decision, xem và duyệt lesson từ run, tìm lại từ frontend khác, xem revision được dùng trong run; test CAS hai process, stale approval và root unavailable.

## P4 — Mở rộng workflow theo nhu cầu thực

- Nhiều writer trước/sau fork, nhiều integration và review từng nhánh; integration/conflict trong plan đã duyệt, kiểm thử sửa conflict thật trên fixture khi cần.
- Current checkout/shared workspace: dirty baseline, quyền ghi/lease, giữ index và attribution phải được enforce trước khi bật. Không mở tùy chọn chưa hỗ trợ chỉ bằng UI.
- Extension Nimbalyst thông báo tới session khi cần duyệt/hoàn tất; thử Dev/Fast, đóng/mở workspace và recovery. NeoMind standalone và Nimbalyst dùng cùng core/memory; host-owned session runner là hướng riêng khi contract host đủ.
- Kiểm chứng Dev/Fast/parallel/memory qua UI Linux và Windows; pilot Calculator sau khi người dùng duyệt plan sản phẩm.

## Thứ tự thực hiện

P0 → P1 → P2 → P3 → P4, chia thành các PR/commit nhỏ có thể kiểm tra. P1–P3 có thể chia lát dọc khi cần, nhưng P0 phải đi trước auto-clean và thay đổi gate. Mỗi lát gồm thay đổi core/UI phù hợp, test liên quan và cập nhật status/acceptance; không yêu cầu tất cả P4 trước khi giao P1–P3. Không tự chạy flow thật trên project của người dùng hoặc duyệt thay họ.

## Cấu hình chọn memory theo project

Có thể cấu hình tại Project memory → Chọn memory cho run. Ngoài ra, trong `neomind/project.json`, thêm tùy chọn `memorySelection` ở cùng cấp `policy`:

```json
{
  "memorySelection": {
    "scopes": ["project", "src/ui"],
    "tags": ["workflow"],
    "requireTaskMatch": true,
    "inferTaskPaths": true,
    "retrievalMode": "hybrid",
    "maxRecords": 20,
    "maxBodyBytes": 12000
  }
}
```

Đây là đoạn cấu hình cần ghép vào project JSON hiện có, không thay toàn bộ file. Scope khớp chính xác hoặc theo nhánh con phân tách `/`; record phải chứa **tất cả** tag được chỉ định. Mảng rỗng hoặc bỏ trường là không lọc theo trường đó. `requireTaskMatch` chỉ giữ record khớp ít nhất một từ khóa task trên 2 ký tự; với lexical mode là khớp từ khóa, còn semantic/hybrid dùng LSA cục bộ. `inferTaskPaths` suy ra đường dẫn từ task và tên file/thư mục trong repo; scope project vẫn được giữ. `retrievalMode` gồm lexical (mặc định), semantic và hybrid. LSA giới hạn 512 record sau scope/tag filtering, không gửi memory ra dịch vụ ngoài. `maxRecords` 0–30 và `maxBodyBytes` 0–16000; 0 là không chọn gì. Nếu bỏ cấu hình, mặc định tương thích cũ (30 record/16000 bytes, cho phép record không khớp). Context text còn trần 40000 ký tự và chỉ ghi metadata của record được đưa vào đầy đủ. Preview là dự kiến; lúc run bắt đầu ghi policy, text và revision đã chọn vào snapshot.
