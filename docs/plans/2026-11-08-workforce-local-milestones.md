# WorkForce Local milestones và checklist nghiệm thu

Ngày: **08/11/2026**. Nhánh: `codex/workforce-vscode-native`. Baseline: `ad7744a8dcc67ceacaf8d95d875cc1f8d4b289f4`.

[Kế hoạch đầy đủ](2026-11-08-workforce-local-final-plan.md) là nguồn phạm vi và quyết định. Tài liệu này chia công việc thành milestones để triển khai, quan sát kết quả và kiểm chứng từng bước. Trạng thái milestone không phải trạng thái `draft/accepted` của records trong project người dùng.

## Kết quả hiện hành — đối chiếu 09/11/2026

- **WF-R0022 đã accepted bằng continuation giữ nguyên hồ sơ.** Bản `b8e8a858…` dùng host evidence thật và một Tester mới để đối soát finding môi trường; giữ ba sản phẩm, hai báo cáo findings cũ và `repair_attempts: 1`. Bốn host checks exit 0. Oracle độc lập ngoài workspace giữ nguyên 31 file request/sản phẩm, chạy hai baseline đạt và từ chối bốn mutants đúng nguyên nhân.
- **WF-R0025 đã accepted từ đúng prompt LeetCode gốc trên cùng bản `b8e8a858…`.** Một native request, **0 lời gọi continuation/control**; có một automatic implementation repair được lưu. Reviewer và Tester độc lập đều pass, bốn host checks exit 0. Chỉ thêm năm file đúng phạm vi: Cornell note, C11, C++17 và hai executable; không có file mới ngoài dự kiến. Toàn bộ **181 file workspace cũ và 287 file lịch sử** khớp baseline; ba sản phẩm cùng hai findings cũ của R0022 cũng giữ nguyên hashes.
- **Năm direct roles và concurrency đã có proof Local:** hai full software workflows R0033/R0034 có actual FnD chạy đồng thời, sáu native actors tách biệt, checks exit 0 và cả hai đóng accepted sau khi panel đã đóng. Audit đạt 8/8 tổng thể và 8/8 mỗi request. Proof scoped R0031/R0032 vẫn chỉ là role completion; R0029/R0030 vẫn được giữ là nối tiếp. Model freeze A→B-next và Stop R0024 có bằng chứng riêng. Reopen/reload lúc idle giữ 711 file, 63 entry files và 11 closed states, không tạo tool/check call mới; reload/crash giữa model hoặc checker đang chạy và gói cài cuối vẫn cần nghiệm thu riêng.
- **Panel V-model có proof native và Pin/Unpin khi SQL đang chạy:** selection/artifact/evidence links giữ đúng request; ghim R0026 trong lúc R0027 chạy, rồi Unpin tự chuyển sang R0027 từ snapshot hiện có, không Refresh hoặc tạo model call. Lượt Unpin trước đó ở R0026 vẫn được giữ là chưa kết luận vì role đã hoàn tất trước lúc Refresh.
- **M6 đã có ba capability scopes dùng skill thật:** R0026 dùng `context-map` với audit 14/14; R0027 dùng `sql-code-review`, review → strong repair → independent review/test và đóng accepted với ba host checks exit 0, audit 15/15. Mới nhất, trên build `f804a07e…`, WF-R0028 tra catalog cache, inspect và install `java-docs` đúng một lần mỗi action, rồi một WF.Reviewer đọc skill thật và hoàn thành báo cáo; audit độc lập **17/17**. Đây là scoped review có Manager bổ sung hints, **không phải blind discovery hoặc full software accepted**. Lifecycle giữa requests của hai skills trước giữ closure/history với audit 10/10 trên 607 files. Marketplace/MCP support tổng quát, active-invocation lifecycle và shipping vẫn mở.
- **Regressions hiện hành:** bản portable-layout mới có current-dist **49/49**, parser source **11/11** và service source **20/20** theo các suite riêng; hai suite **100/100** và **35/35** thuộc build `87a29959…` trước lỗi layout, không chứng minh bản sửa mới hoặc cộng thành tổng coverage. Các proof runner/history 29/29 và lifecycle/freshness/receipts 86/86 trước đó giữ nguyên ledger; actual preparation 730/282 ms phụ thuộc tải, không phải SLA. Full suite lịch sử có 2.133 tests: 2.119 pass, 6 fail, 8 skip; các nguyên nhân đã được sửa/kiểm tra có phạm vi riêng. Một lượt startup/cancel OpenCode cũ chạy cô lập đạt 1/1 trong 14,35 giây với authenticated process-tree closure; lỗi admission 15 giây vẫn **chưa tái hiện/chưa xác định nguyên nhân**, không được coi đã sửa bằng lượt pass này (`engine-admission-isolated-27e80709-20261109.json`).
- **M7 mới chuẩn bị nghiên cứu read-only** về REA/9router; actual REA analysis và managed gateway chưa nghiệm thu. M8 vẫn pending, chưa release.

Bằng chứng chính nằm trong `artifacts/workforce-native-local-proof/c3f40d36/evidence/`: `leetcode-11-accepted-native-summary-20261109.json`, `independent-oracle-11/summary-20261109.json`, `fresh-original-leetcode-724-native-accepted-20261109.json`, `workspace-before-fresh-native-20261109.json` và `history-before-native-final-20261109.json`. Các JSON acceptance, hashes sản phẩm/báo cáo và hai baseline đã được đọc, đối chiếu trước khi cập nhật checklist. Đây là proof Local trên checkout/fixture, chưa phải nghiệm thu gói cài cuối, nâng cấp NeoLearning hoặc release.

## Thứ tự thực hiện

**Thứ tự đã chốt:** M1 được làm trước vì GUI V-model là thay đổi dễ thấy và ít phụ thuộc nhất. Proof native, model controls và request đầu-cuối sau đó được kiểm tra riêng ở M2–M4. Tiếp tục M6 từ core đã kiểm tra; M7/M8 chỉ chuyển trạng thái khi có bằng chứng đúng phạm vi.

| Mốc | Kết quả người dùng nhìn thấy | Phụ thuộc | Trạng thái |
| --- | --- | --- | --- |
| M0 | Kế hoạch được lưu, có phạm vi và checklist thống nhất | Không | Hoàn tất tài liệu |
| **M1** | **Panel V-model gọn, đọc request/stage/artifact hiện có** | M0 | Đã mở cạnh chat, đổi request, mở file/evidence, Pin/Unpin khi SQL chạy và reopen/reload idle không side effects; theme/reduced motion và đầy đủ keyboard matrix còn pending |
| M2 | Local WF.PM gọi specialist thật; inventory models và hook contract được xác nhận | M0; chạy sau M1 | Native calls/tools và inventory đã quan sát; model A giữ nguyên/B áp dụng lượt sau, Stop thật đã đạt trong phạm vi M4; upstream model vẫn unknown |
| M3 | Một request native đơn giản chạy đầu-cuối và lưu đúng hồ sơ/evidence | M2 | WF-R0004 và prompt gốc fresh WF-R0025 đóng accepted; WF-R0022 continuation accepted giữ history; chưa nghiệm thu gói cài/nâng cấp cuối |
| M4 | V-model đồng bộ chat; đổi model theo role; giao việc trực tiếp từng role | M1, M2, M3 | Năm direct roles, model freeze A→B-next, Stop, Pin/Unpin, hai full workflows đồng thời accepted và đóng panel khi đang làm đều có proof; idle reload không side effects đã đạt, active reload/crash và package matrix còn pending |
| M5 | Chat mới tự tìm kinh nghiệm và chạy lại script đã đủ điều kiện | M3; nghiệm thu hiển thị cùng M4 | Chuỗi mới → qualification → chat sạch reuse → adapt → mismatch đã đạt trong fixture; còn chạy lại trên gói phân phối cuối |
| M6 | Manager khảo sát, chuẩn bị và giao capabilities khác nhau theo role | M3, M4; dùng cache M5 | Ba scopes có actual skill reads; R0028 cache→inspect→install→Reviewer đạt audit17/17; lifecycle hai skills trước audit10/10; generic marketplace/MCP plans, active-invocation lifecycle và shipping còn pending |
| M7a | REA phân tích 9router và cho ra điểm tích hợp có evidence | M2 và REA được cấu hình hợp lệ | [Nghiên cứu read-only đã chuẩn bị](../research/2026-11-09-managed-gateway-feasibility.md); actual REA analysis pending |
| M7b | Provider gateway tích hợp, quota/usage, RTK, combos và vision | M3, M4, M7a | Source/API seams đã nghiên cứu; actual managed gateway pending |
| M8 | Bộ nghiệm thu đầy đủ trên gói cài thật và GitHub release tương thích | M1–M7b | Chưa bắt đầu |

Nghiên cứu source và thiết kế index có thể chuẩn bị song song, nhưng không bỏ proof Local của M2 hoặc dời mọi nghiệm thu tới M8. Bản đang phục vụ người dùng được giữ cho tới khi đường thay thế đã được kiểm chứng.

## M0 — Lưu kế hoạch và chốt baseline

**Đầu ra:** kế hoạch đầy đủ, tài liệu milestones, index và liên kết kế hoạch lịch sử.

- [x] Tạo nhánh `codex/workforce-vscode-native` từ baseline nêu trên.
- [x] Lưu đủ năm yêu cầu gốc và các điều chỉnh Local/GUI/model/direct roles/storage.
- [x] Có bảng yêu cầu → milestone → bằng chứng.
- [x] Kế hoạch cũ được phân biệt rõ với nguồn quyết định hiện hành.

**Điều kiện hoàn tất:** các tài liệu đọc được, liên kết nội bộ hợp lệ và `git diff --check` đạt. M0 chỉ hoàn thành công việc tài liệu.

## M1 — Panel V-model tối thiểu dễ quan sát

**Mục tiêu:** người dùng có thể mở panel gọn cạnh chat và xem đúng dữ liệu hiện có, trước khi thay engine.

**Thực hiện:**

1. Tái sử dụng SVG/CSS hiện có trong `universe.js`; giữ chín stages, các cặp đặc tả–kiểm thử và Independent Review.
2. Tạo đường mở panel chỉ đọc: chọn/ghim request, xem stage, role, summary và artifact/evidence links.
3. Dùng snapshot chỉ đọc, không acknowledge admission, điều khiển lifecycle, chạy checker hoặc gọi model khi xem GUI.
4. Phân biệt nguồn dữ liệu cũ với native observations tương lai. Chưa nối native thì ghi rõ; không tạo animation giả hoặc suy ra pass từ role completed.
5. Giữ theme, keyboard navigation và reduced motion. Focus Space và đường quản lý request cũ tiếp tục dùng được trong giai đoạn chuyển đổi.

**Nghiệm thu:**

- [x] Panel mở cạnh chat; request selector và liên kết file hoạt động (quan sát Local 09/11, R0025/R0022; chưa thay cho gói cài cuối).
- [ ] SVG thể hiện riêng pending/running/repairing/completed/uncertain/N/A từ snapshot được cấp.
- [x] Chọn request khác không trộn stages, artifacts hoặc evidence trong lượt R0025 → R0022: bài 724 và bài 11 giữ riêng đúng hồ sơ.
- [x] Mở/đóng/mở lại view và reload editor lúc idle không tạo tool/check calls hoặc thay đổi sản phẩm/lịch sử/request: 711 files, 63 entry files và 11 closed states giữ nguyên (proof f804; không thay cho active reload/crash).
- [ ] Layout/theme/keyboard được kiểm tra trực tiếp; test renderer kiểm tra dữ liệu và trạng thái.
- [ ] Không có tuyên bố đã đồng bộ native chat hoặc đã hoàn thành request chỉ từ bằng chứng UI.

**Bằng chứng lưu:** ảnh panel, kết quả renderer/UI checks, snapshot đầu vào và đối chiếu không có side effects do mở view. Dữ liệu fixture được ghi rõ là fixture.

**Tiến độ quan sát 08/11:** lệnh `WorkForce: Open V-model` đã có trong extension; panel đã được quan sát trong VS Code 1.145.2 cạnh chat Local với hai request giả lập có nhãn rõ ràng. Tests kiểm tra việc chọn request và file scope, snapshot chỉ đọc và cold activation không chạy controller. Đây chưa phải bằng chứng workflow native đã hoàn thành. Gói VSIX trong `artifacts/workforce-native-m1` là ứng viên thử nghiệm, chưa phát hành.

**Thao tác native 09/11:** evidence `evidence/v-model-selector-native-observation-20261109.json` trong fixture `c3f40d36` ghi panel cạnh chat sau reload: R0025 accepted, unit/acceptance completed và system/integration N/A. Dropdown bằng bàn phím đổi sang R0022; heading/request và artifact bài 11 thay đúng phần bài 724 của R0025, Refresh vẫn giữ R0022. Bấm Cornell link mở preview `11_note.md` trong native editor; bấm C harness evidence mở log `9fa3f08e-5ac4-4b2a-8632-c7d97ac84d27.log`, hiển thị **Exit 0**, **State passed**, **21.850 checks** gồm 21.840 exhaustive arrays. Đây là mở evidence đã lưu, không phải chạy lại checker hoặc proof acceptance mới. Lượt quan sát ghi **0 model calls**. Theme, reduced motion và đầy đủ keyboard matrix vẫn cần proof riêng; view lifecycle lúc idle được kiểm tra riêng bên dưới.

**Pin/Unpin có request đang chạy:** `evidence/v-model-unpin-native-observation-20261109.json` ghi đúng lúc FnD R0027 còn chạy: chọn và ghim R0026, rồi Unpin; selector/heading lập tức trở lại R0027 với Coding/current requested-model đúng, không Refresh hoặc tạo model call mới. Resource script `61e1555c…` được nạp trước khi gửi SQL task; client/host regression đỏ→xanh 7/7. Lượt R0026 trước đó không chứng minh Unpin đang live vì role đã hoàn tất trước lúc Refresh; không sửa lại kết luận lịch sử đó.

**View lifecycle thực trên f804:** panel đã được đóng bằng tab Close khi hai workflow R0033/R0034 còn hoạt động; cả hai tiếp tục kiểm tra và đóng accepted, với proof riêng tại M4. Sau khi hoàn toàn idle, mở lại view rồi `Developer: Reload Window`: host nạp đúng `f804a07e…`, V-model khôi phục R0033 accepted, không còn owned call/Cancel giả và chat vẫn Allow all. So sánh trước/sau giữ nguyên **711 workspace files, 63 native entry files, 11 closed request states**, 0 native tool calls và 0 check runs mới. Evidence: `native-panel-close-live-observation-20261109.json`, `native-idle-view-lifecycle-before-20261109.json`, `native-idle-view-lifecycle-after-20261109.json`. Reload này được thực hiện lúc idle, không chứng minh phục hồi khi editor crash hoặc khi model/checker đang chạy.

## M2 — Proof native Local và discovery models

**Mục tiêu:** xác nhận khả năng thực tế của harness trước khi chuyển backend.

**Thực hiện:**

1. Dùng workspace nghiệm thu riêng; giữ nguyên phần sửa không liên quan trong project thật.
2. Liệt kê models qua API VS Code, giữ lựa chọn người dùng; không yêu cầu aliases/catalog/9router mới.
3. WF.PM gọi một named specialist bằng native Local; specialist đọc file và chạy một tool/check có kết quả quan sát được.
4. Thu fixtures của tool schema và Local hooks thật. Kiểm tra request correlation, native model selection, `updatedInput`, cancellation và giới hạn native liên quan.
5. Xác định rõ metadata nào quan sát được; thiếu dữ liệu thì giữ unknown, không đọc private transcript schema để bù.

**Nghiệm thu:**

- [x] Local chat hiện native delegation và tool calls thật (proof M2 và requests/direct roles ở M3–M4).
- [x] Inventory lấy models hiện có mà không sửa routing aliases của người dùng.
- [x] Model override được đối chiếu với native invocation thực, không chỉ file cấu hình (FnD A ở R0022 và lượt B ở R0023; alias không chứng minh upstream model).
- [ ] Sự kiện có correlation đáng tin được gắn đúng request; sự kiện thiếu correlation không bị đoán.
- [x] Các proof đã lưu giữ upstream model/native context thiếu quan sát là unknown; không suy ra actor chỉ từ thứ tự hook.

**Điều kiện hoàn tất:** có proof Local với phiên bản VS Code/model/tool schema cụ thể. Proof không đạt thì xử lý compatibility trước M3; không thay bằng hidden engine.

**Lượt thử đầu đã quan sát:** VS Code 1.145.2, chat extension 0.73.0; workspace riêng `artifacts/workforce-native-local-proof/c3f40d36/workspace`. Inventory được đọc qua `vscode.lm.selectChatModels`, không sửa User settings hoặc model aliases. Sau khi người dùng chỉnh lại endpoint, `top-models` đã gọi `WF.Tester Native Proof`, phát sinh `SubagentStart` và đọc fixture thật. Hook ghi nhận yêu cầu model override; native card báo model `customendpoint/9router/top-models`. Sau khi người dùng bấm Allow, script `node --test m2-fixture.test.cjs` đã chạy và trả **1 test pass, 0 fail** với marker `WORKFORCE_M2_NATIVE_CHECK_PASSED`. Hook `PostToolUse` của terminal có marker, `SubagentStop` và report về parent đã quan sát được; bản capture cuối có marker thật. Lượt cùng alias ở cha/con này chưa chứng minh chuyển A→B; phép thử riêng R0022/R0023 sau đó đã đạt trong phạm vi M4. Hook tool events hiện có session/tool-use correlation nhưng không có `agent_id` trên từng tool event; không suy diễn actor từ thứ tự thời gian.

Bằng chứng các lần thử được giữ riêng trong `artifacts/workforce-native-local-proof/c3f40d36/evidence`. Lượt `top-models` ban đầu trả provider 429; lượt Azure Luna trả 403. Lượt sau khi endpoint được chỉnh có tên `top-models-reconfigured`. Không tính các lần provider từ chối là đã chạy specialist hoặc kiểm chứng sản phẩm.

Ba `PreToolUse` delegation đầu của lượt thành công chưa nhắm đúng tên fixture; hook cũ không lưu tên/model đầu vào nên nguyên nhân cụ thể vẫn chưa được chứng minh. Driver mới chỉ bổ sung metadata đã lọc cho chẩn đoán tương lai; không sửa evidence cũ. Adapter M3 nhận handoff do backend tạo và gọi native tool trực tiếp, thay vì giao model tự điền payload điều phối. Tests adapter được phân biệt với các proof Local thật đã có ở M3–M4.

## M3 — Backend native và request đơn giản đầu-cuối

**Mục tiêu:** đóng thật ít nhất một request native trước khi thêm reuse/marketplace/gateway.

**Tiến độ 08/11:** đã có `native-local-contract.ts`, backend `native-request.ts`, adapter `local-delegation.cjs` và runner `local-request.cjs`. Gói đang phục vụ chưa đổi. Bộ kiểm thử focused mới nhất trên Windows đạt 30/30 (contract, domain, runner); có process kiểm tra thật, callback trùng, tách requests, cancellation/drain, checker/product/log thay đổi và phục hồi state-write mất response. Đây chưa phải nghiệm thu desktop.

Lượt desktop đầu phát hiện hai vấn đề trước khi dispatch sản phẩm: trùng tên WF.PM với plug-in WorkForce cũ và payload dùng absolute paths từ VS Code. Workspace thử đã tắt riêng agent plug-ins để dùng đúng profiles mới; backend đã có normalization cho absolute paths/file URIs trong workspace, không yêu cầu model đổi prompt. Hai lần bị từ chối trước dispatch được giữ nguyên evidence, không tính pass.

**Kết quả desktop:** WF-R0003 ban đầu tạo đúng files nhưng FnD trả findings vì gọi hash script không khả dụng và nhận nhầm trách nhiệm final acceptance của toàn request. Backend đã chuyển preservation hashing về host; role contract phân biệt nhiệm vụ chuyên môn với các bước review/check/acceptance tiếp theo. Continuation giữ nguyên báo cáo cũ và sản phẩm, sau đó gọi ba specialist độc lập và đóng thật. Bằng chứng preservation trước lần thử đầu vẫn không được khẳng định.

Để kiểm tra từ đầu sau thay đổi, **WF-R0004** tạo `subtract.mjs` và `subtract.test.mjs` từ một prompt mới, không dùng continuation. Local WF.PM gọi tool đúng một lần; adapter gọi thật WF.FnD → WF.Reviewer → WF.Tester. Ba kết quả độc lập pass, không findings; ba command thực exit 0, lượt tổng hợp **7 tests pass, 0 fail**. Backend đã lưu baseline trước dispatch, đối chiếu chín file cũ và hashes của sản phẩm/check logs, rồi đóng `accepted`. Thời gian owned execution `08:44:21.459Z–08:46:40.281Z` ngày 08/11/2026. Native chat trả sản phẩm accepted lúc 15:46 giờ Việt Nam.

Evidence: `artifacts/workforce-native-local-proof/c3f40d36/evidence/attempts/native-fresh-subtract/chat-observation.json`, `evidence/native-pilot/call-9f856469-340a-4ab8-9173-9daf0b57c5f2.json` và `.workforce/requests/WF-R0004--implement-and-accept-es-module-subtraction/native/execution.json` trong workspace fixture. Export đã lọc xác nhận cha và ba native cards dùng alias `customendpoint/9router/top-models`; model upstream thực tế vẫn unknown. Source backend chỉ lưu actual host call IDs, không giả native context IDs. Đây là nghiệm thu phần mềm nhỏ, chưa phải nghiệm thu LeetCode/Cornell hoặc gói phát hành.

**Thực hiện:**

1. Tách domain operations khỏi controller OpenCode; tạo contract `vscode-native/v1` và tool schemas/profiles/instructions thống nhất.
2. Backend tự cấp IDs, lưu plan/results và chạy kiểm tra; tools thông thường không chứa claim/token/CRUD/lifecycle recovery cũ.
3. Giữ layout `.workforce`, counters, IDs, record links, artifact destinations và lịch sử.
4. Chuyển task/result/check/review/acceptance theo bằng chứng hiện hành; kết nối native provenance mà không sửa signed history.
5. Chạy một request phần mềm nhỏ thật: plan ngắn → implementation → independent review/testing → artifacts → acceptance.

**Nghiệm thu:**

- [x] Request nhỏ có sản phẩm dùng được, command/check thực và trạng thái đóng nhất quán.
- [x] Record bắt buộc có trạng thái đúng; không sửa hàng loạt `draft` thành `accepted`.
- [x] Thay file sau kiểm chứng làm evidence cũ mất hiệu lực cho revision mới (domain/runner tests).
- [x] Duplicate/lost-response handling không nhân đôi công việc hoặc writes (domain/driver tests).
- [x] Đường thử mới gọi native runSubagent trực tiếp và runner kiểm tra thật; không gọi OpenCode.
- [x] Đối chiếu trước/sau giữ nguyên bytes, IDs và references của 287 file lịch sử, 181 file workspace cũ; riêng ba sản phẩm và hai findings cũ R0022 cũng còn nguyên hashes (phạm vi fixture/baselines 09/11, không suy ra mọi migration/package).

## M4 — Đồng bộ V-model, model theo role và direct-role jobs

**Mục tiêu:** người dùng thấy đường chạy thật và điều khiển lựa chọn role bằng UI tối thiểu.

**Lịch sử lượt selector đầu 09/11:** sáu selectors hiển thị được tách khỏi năm hidden workers; runtime đăng ký chín native tools. Các selectors WF.SWSD, WF.P-RES, WF.FnD, WF.Reviewer và WF.Tester đã gọi đúng worker tương ứng trong Local. WF-R0016–WF-R0019 tạo đủ report/design/code được yêu cầu; FnD thực chạy 7 Node tests pass. Reviewer giữ hai findings về coverage, không giả đạt toàn sản phẩm. FnD dùng `worker-models`, các roles còn lại quan sát alias `top-models`; upstream model chưa xác định. WF-R0020 ghi đúng rằng Tester chưa chạy được command do profile thiếu quyền execute; lượt đó không được tính đạt Tester. Lỗi được sửa và nghiệm thu lại thật ở WF-R0021 bên dưới. 254 file lịch sử cũ và hai file queue ban đầu giữ nguyên bytes. Evidence: `evidence/selector-desktop-batch-20261109.json` trong fixture `c3f40d36`.

**Lượt Tester sau sửa:** build `48434aeb…` đã được reload và đối chiếu fingerprint/adapters. WF-R0021 gọi đúng WF.Tester Worker, chạy actual terminal commands, đạt focused suite 7/7, original suite 4/4 và oracle FIFO độc lập ở capacities 1/2/3/5. Tám files được Tester hash trước/sau giữ nguyên; backend công bố report thay thế với intent/baselines được lưu. Report cũ WF-R0020 và toàn bộ 287 file lịch sử trước lượt này vẫn nguyên bytes. Đây là scoped role completion, `accepted:false`; không phải nghiệm thu toàn sản phẩm. Evidence: `evidence/selector-desktop-after-execute-20261109.json`. Như vậy đủ năm direct roles đã hoàn thành scope; prompt LeetCode sau đó được kiểm tra riêng ở R0022/R0025.

**Model và Stop thật:** trong lúc FnD của WF-R0022 dùng `worker-models`, đã đổi preference qua Quick Pick sang `top-models`; invocation cũ vẫn dùng model cũ. Direct FnD tiếp theo WF-R0023 dùng `top-models` và hoàn tất scope. Preference thử nghiệm sau đó được khôi phục. Lượt Stop ở WF-R0023 đến sau completion nên không tính proof cancellation. Lượt riêng WF-R0024 đã Stop khi Reviewer thực sự chạy: backend lưu `cancelled/incomplete`, artifact chưa tạo, không còn live call và không claim accepted. Sau reload sang `b8e8a858…`, R0024 vẫn `cancelled/incomplete`, `accepted:false` theo JSON R0022 accepted. Đây là proof cancelled state tồn tại qua reload, chưa phải proof reload giữa model/checker đang chạy hoặc trên gói cài cuối. Evidence: `model-switch-ui-20261109.jsonl`, `next-model-scope-result-20261109.json`, `native-cancellation-desktop-20261109.json`, `leetcode-11-accepted-native-summary-20261109.json`.

**Hai requests đầy đủ đã accepted nhưng không đồng thời:** trên build `f804a07e…`, một chat Local tạo riêng R0029 (sum) và R0030 (product). Mỗi request có FnD, Reviewer, Tester với host calls riêng, một direct Node check exit 0 với 4 tests pass và final delivery accepted; audit sản phẩm/evidence đạt 12/12. Tuy nhiên A trả về lúc `05:30:29.225Z`, B mới được gửi vào backend lúc `05:30:48.618Z`, cách **19,393 giây**. Lượt này chỉ chứng minh hai workflow nối tiếp, không được tính proof concurrency. Toàn bộ 633 file baseline được giữ ngoài ba metadata experience/index thay đổi dự kiến. Evidence: `native-two-requests-independent-audit-20261109.json`.

**Hai direct FnD jobs chạy đồng thời thật:** hai chat Local riêng, qua visible WF.FnD và prebound entry trên cùng build `f804a07e…`, tạo R0031 (square) và R0032 (absolute). Snapshot `v-model-native-1794202560693-26.json` lúc **`05:36:00.693Z`** ghi cả hai requests `live:true/working`, Coding running và actual WF.FnD owner; hai saved invocations có host call IDs khác nhau. Đây là actual owned calls, không chỉ hai jobs queued hoặc hai tool entries chưa dispatch. Hai report và bốn sản phẩm tách biệt, đúng hashes; cả hai `role-completed`, `accepted:false`, audit độc lập **11/11**. 665 file cũ giữ nguyên ngoài hai metadata index dự kiến. UI quan sát alias `worker-models`; upstream model/provider vẫn unknown. Không suy ra thời lượng overlap chính xác từ khoảng thời gian outer tool. Evidence: `native-two-local-fnd-independent-audit-20261109.json`.

**Kiểm chứng ngoài workspace cho hai sản phẩm direct FnD:** copied-project controls chạy syntax, delivered tests và oracle baseline đều exit 0; delivered suite có 5 tests pass, oracle có **326 assertions**. Hai mutants `wrong-square`/`wrong-absolute` vẫn syntax exit 0 nhưng delivered tests và oracle đều exit 1 đúng nguyên nhân. 679 file workspace giữ nguyên; lượt kiểm chứng dùng 0 model calls. Evidence: `native-two-local-fnd-independent-controls-20261109.json`. Đây là kiểm chứng độc lập sản phẩm của scoped jobs, không nâng chúng thành full software acceptance hoặc chứng minh hai full workflows chạy đồng thời.

**Hai full software workflows đồng thời đã accepted:** hai chat Local riêng trên `f804a07e…` tạo R0033 (full-sum) và R0034 (full-product), không thay thế hai hồ sơ trước. Snapshot `v-model-native-1794203126725-33.json` lúc **`05:45:26.725Z`** ghi cả hai actual FnD owners cùng `live:true/working`. Sau đó mỗi request có Reviewer và Tester độc lập, tổng cộng sáu host call IDs khác nhau; hai direct Node checks exit 0, mỗi suite 4 tests pass, log/product/input hashes hiện hành khớp. Hai final deliveries và current domain views đều accepted. Audit **8/8 tổng thể, 8/8 mỗi request**, giữ 679 file cũ ngoài ba metadata experience/index dự kiến; không trộn records hoặc products. Evidence: `native-two-local-software-independent-audit-20261109.json`. Đây là hai workflow phần mềm đơn giản độc lập trên Windows fixture; không suy ra thời lượng overlap chính xác, mọi shared-file conflict hoặc gói cài cuối.

**Đóng panel khi đang làm không hủy workflow:** native tab Close được quan sát lúc `05:47:03Z`, V-model tab biến mất nhưng chat vẫn hoạt động; VS Code không bị đóng. Host check logs của R0034/R0033 được ghi sau đó lúc `05:47:40Z`/`05:48:06Z`, và backend đóng accepted lúc `05:47:57Z`/`05:48:22Z`. Evidence UI `native-panel-close-live-observation-20261109.json` được đối chiếu với timestamps và hashes trong audit full-software nêu trên. Proof idle reopen/reload tại M1 giữ toàn bộ bytes và không sinh tool/check mới; chưa chạy active-model/checker reload hoặc crash recovery.

**Lịch sử lỗi finding môi trường ở WF-R0022:** request tạo bài 11 cùng note/C/C++; Tester độc lập build/run đạt 21.850 checks/ngôn ngữ với PATH compiler thích hợp. Controller lúc đó dừng trước host checks do coi khác biệt môi trường terminal là finding chặn toàn bộ verification. Evidence ban đầu vẫn giữ tại `leetcode-11-first-native-observation-20261109.json`; lượt dừng này không được sửa thành pass.

**R0022 continuation đã đóng thật:** trên build `b8e8a858…`, backend lưu host evidence thật rồi chỉ gọi WF.Tester Worker mới để đối soát finding môi trường. Tester mới pass, bốn host checks exit 0 và `execution.json` là accepted; `repair_attempts` giữ 1. Ba sản phẩm và hai report findings cũ còn nguyên hashes. Oracle riêng ngoài workspace chạy hai baseline pass và từ chối bốn compiled mutants; 31 file request/sản phẩm trước/sau oracle không đổi, accepted vẫn giữ. Evidence: `leetcode-11-accepted-native-summary-20261109.json` và `independent-oracle-11/summary-20261109.json`. Đây là continuation có đối soát bằng chứng, không phải fresh first-pass success.

**R0025 fresh trên cùng build đã đóng thật:** gửi đúng hash prompt gốc `e984bd90…` với attachment/context thật trong Local; tạo một native request, không gọi continuation/control. Manager tự chọn bài 724 chưa có. FnD đầu trả findings thật; backend dùng một lượt sửa tự động, sau đó Reviewer và Tester độc lập pass. Bốn host checks exit 0; C có 3.291 checks và C++ có 3.289 checks, mỗi harness gồm 3.279 exhaustive arrays với quadratic oracle. Request accepted; chỉ thêm note/C/C++ và hai executables, không có file mới ngoài dự kiến. Baseline 181 file workspace và 287 file lịch sử khớp nguyên bytes. Evidence: `fresh-original-leetcode-724-native-accepted-20261109.json`, `workspace-before-fresh-native-20261109.json`, `history-before-native-final-20261109.json`. Zero continuation không có nghĩa model không mắc lỗi; automatic repair và findings vẫn được giữ đúng lịch sử.

**Tiến độ 08/11:** native request projection đã được nối vào panel qua saved-file events và registry in-memory của đúng editor host. `issued` trên disk không tự thành `running` sau reload. Stage chỉ sáng theo actual owned call/check; Tester inspection không làm mọi test level cùng chạy. Các mức không được plan phân bổ có nhãn N/A và lý do. Model Quick Pick lấy inventory VS Code, mặc định inherit, policy riêng theo workspace/role, áp dụng invocation tiếp theo.

**Chi phí đọc view:** cùng fixture 13 requests, `requestListForMonitor` ban đầu mất 19.520/13.627 ms; sau gom inventory và hashes trùng trong một snapshot đồng bộ còn 1.489/1.001 ms. Không dùng cache này trong execution/acceptance và mỗi lượt view tạo snapshot mới. Regression 38/38 xác nhận context/product/checker/executable/log edits vẫn làm bằng chứng hiện hành mất hiệu lực. VS Code đã reload đúng build và V-model vẫn hiển thị WF-R0013 accepted. Số đo phụ thuộc tải máy, không phải SLA. Evidence: `evidence/monitor-snapshot-timing.json`; log `artifacts/workforce-native-local-proof/monitor-snapshot-regression-20261108.log`.

Lượt Local **WF-R0005** sửa validation cho `add.mjs`, gọi WF.FnD → WF.Reviewer → WF.Tester, ba checks exit 0 và đóng accepted lúc `09:01:52.180Z` (16:01 Việt Nam). FnD được chọn qua Quick Pick sang `worker-models`; safe native chat export xác nhận actual card dùng `customendpoint/9router/worker-models`, còn Reviewer/Tester kế thừa `customendpoint/9router/top-models`. Panel đã được quan sát trên desktop với Acceptance Testing running, sau đó completed/accepted. Các snapshot đọc bởi panel được giữ trong `evidence/v-model-native-*.json`; native export của lượt này nằm ở `evidence/attempts/native-bug-model-and-vmodel/chat-observation.json` trong fixture M3. Alias không chứng minh upstream model.

Regression tập trung trước lượt repair đạt **78/78** trên Windows. WF-R0006 đã chạy SWSD scope riêng, lưu báo cáo và trả `accepted:false`; WF-R0007 chạy Reviewer thật trên bản sao source, chỉ ra bốn lỗi về root context, directory membership, checker baseline và interruption giữa hai commands. Các lỗi này đã có regression và được sửa; bản sao/evidence review cũ được giữ nguyên. Chuyển default/package và bộ desktop đầy đủ vẫn chưa đạt.

**Lượt prompt LeetCode nguyên bản:** ngày 08/11, Local nhận nguyên văn prompt cùng folder attachment thật; Manager tự chọn bài 234 chưa có và tạo WF-R0008. FnD đầu dùng worker-models gặp compiler exit 1 không diagnostics; backend giữ report cũ, tự gọi FnD mới kế thừa top-models. Lượt sửa xác định MinGW thiếu DLL search PATH, hoàn thiện sản phẩm; Reviewer và Tester riêng đều pass. Runner cũ vẫn thiếu PATH nên hai lệnh build thất bại; chạy executable cũ không được coi là bằng chứng build thành công và request chưa accepted.

Parent đã thử tạo thêm WF-R0009 để sửa command bằng Node wrapper. Đây là hành vi thừa: wrapper còn khiến generated executable bị coi là source input thay đổi và kết quả uncertain. Không tính lượt này là nghiệm thu đạt. Source mới bổ sung compiler PATH riêng cho child process, dừng checks sau failure đầu để không chạy binary cũ, public request control để recheck đúng hồ sơ và instructions cấm tạo request thay thế cho retry. Recheck chỉ dùng lại independent inspections khi hashes/membership còn nguyên; regression xác nhận không gọi thêm model và giữ failed evidence cũ. Còn phải nghiệm thu lại trên Local trước khi coi lỗi đã đóng.

**Đã nghiệm thu tiếp:** tool request control thật trong Local đã recheck và đóng WF-R0008 lúc `11:12:13.372Z`, cả bốn checks exit 0, không gọi lại specialists và không sửa sản phẩm. WF-R0009 được giữ nguyên lịch sử rồi cancelled với reason `SUPERSEDED_BY_ACCEPTED_WF_R0008`, không giả accepted. Oracle riêng ngoài workspace sản phẩm kiểm tra 8.191 binary lists/ngôn ngữ, hai lần gọi và exact topology/value checks; cả hai sản phẩm pass, hai mutants trả false bị harness từ chối đúng bằng exit 1. Evidence tại `evidence/independent-oracle-234/result.json`.

**Fresh run:** sau sửa compiler runner, gửi lại nguyên văn prompt gốc và attachment thư mục thật, không continuation hoặc problem ID định trước. Manager chọn bài 209 chưa có, tạo riêng WF-R0010. Lượt owned execution `11:19:12.945Z–11:28:30.855Z` tự hoàn tất với Cornell note, C11/C++17, separate native Reviewer/Tester và bốn host checks exit 0; GUI hiển thị accepted và ba artifacts accepted. Harness có 75.417 oracle comparisons/ngôn ngữ cùng input immutability và maximum-size cases. Có một automatic FnD escalation: report đầu chứa một câu giải thích nối JSON bị parser cũ coi là incomplete. Source mới nhận một professional JSON object hợp lệ trong prose, không gọi model để sửa format; conflicting objects vẫn uncertain. Bốn regression parser mới đi từ red sang green. Không suy diễn rằng mọi request hoặc gói phát hành đã đạt.

Evidence fresh: `evidence/attempts/native-leetcode-fresh-after-toolchain-fix/chat-observation.json`, `evidence/native-pilot/call-1eb1da8f-41ed-45ef-987d-eb2a926f5068.json` và `workspace/.workforce/requests/WF-R0010--add-leetcode-209-sliding-window-cornell-exercise/native/execution.json` trong fixture `c3f40d36`. Expanded Windows regression trước parser change đạt 85/85; parser thêm 4/4; entry/manifest/extension shutdown đạt 40/40 trong lượt kiểm tra riêng.

**Product entry và cài đặt:** extension đã đăng ký bốn native entry tools cùng năm role-bound tools, lazy runtime theo đúng workspace, chung runner/model policy; không tự mở provider hoặc engine khi activate. Manifest sinh từ shared schemas và native profile tool references; test kiểm tra không trùng legacy refs. `init/update --local` tạo profiles và common instructions cùng `vscode-native/v1`, giữ history/IDs, MCP siblings và gitignore. Mở profile native bỏ qua legacy Bridge restoration. Entry thực trên desktop đã đạt các proof scoped roles, R0022 continuation và R0025 fresh nêu trên. Bản native mới chưa nghiệm thu cài vào NeoLearning, plugin upgrade/namespace migration hoặc phát hành.

**Thực hiện:**

1. Nối domain evidence và native observations đã correlate vào projection V-model. Thay đổi projection có revision; view chỉ subscribe/đọc snapshot.
2. Thể hiện nhiều active stages, review riêng, rework, N/A và mất quan sát; một Tester không làm mọi testing level cùng running.
3. Bấm role mở native Quick Pick. Một policy theo workspace/role điều khiển lượt delegation tiếp theo; không đổi model của task đang chạy.
4. Phân biệt Preferred/Requested/Observed. WF.PM và direct-role chat tiếp tục chọn parent model bằng native picker; không hứa đồng bộ hai chiều bằng private API.
5. Cho cả sáu roles `user-invocable`; direct-role job có scope và acceptance riêng, không tự nhận full workflow acceptance.
6. Sau khi đường native đạt, rút các UI nhập request/model/catalog/plugin/journal trùng lặp khỏi luồng mặc định; giữ Focus Space tùy chọn.

**Nghiệm thu:**

- [x] Hai direct FnD jobs từ hai chat Local chạy đồng thời, không nhầm owner/activity/stage/report/products (R0031/R0032, actual owned snapshot và audit 11/11; scoped role completion, không phải full software acceptance).
- [x] Hai software workflows độc lập có actual FnD cùng chạy rồi review/check/final acceptance riêng (R0033/R0034, sáu actors, hai checks exit 0 và audit 8/8 tổng thể + 8/8 mỗi request; R0029/R0030 vẫn là lượt nối tiếp).
- [ ] GUI và native chat khớp ở dispatch, tool call, report, review failure và rework.
- [x] FnD A đang chạy giữ A; lựa chọn B được áp dụng cho invocation tiếp theo thực sự (R0022/R0023, preference được khôi phục sau thử).
- [ ] Hook disabled/schema mismatch/model unavailable/cost-tier refusal không gây applied giả hoặc retry loop.
- [ ] Đổi native parent model ảnh hưởng role kế thừa ở lượt sau, không ghi đè explicit role preference.
- [x] Năm specialist direct roles nhận đúng worker/scope, lưu artifacts/report thật; scoped completion không tự thành full acceptance (R0016–R0019 và Tester R0021 sau sửa).
- [x] Stop khi Reviewer R0024 đang chạy lưu cancelled/incomplete, không tạo artifact hoặc claim accepted; trạng thái đó còn nguyên sau reload sang b8.
- [x] Ghim request đã hoàn tất khi SQL R0027 đang chạy; Unpin theo ngay current live request, không Refresh/model call (scoped desktop proof, không thay cho nhiều workflows cùng worker).
- [x] Đóng panel khi đang làm không dừng native work: R0033/R0034 tiếp tục host checks và đóng accepted sau tab Close, VS Code vẫn mở.
- [x] Reopen/reload Local khi idle không tạo call/check hoặc giả công việc cũ còn chạy; 711 files, 63 entry files và 11 closed states giữ nguyên.
- [ ] Reload/crash giữa model hoặc checker đang chạy: đối soát ownership, side effects và fresh evidence trước khi tiếp tục; proof idle không thay thế ca này.
- [x] Prompt LeetCode gốc fresh R0025 qua native entry đóng accepted trên checkout b8 với một request và không gọi control; chưa thay cho nghiệm thu gói cài cuối.

**Review entry và kiểm chứng lại (M4):** WF-R0011 gọi WF.Reviewer thật qua `workforce_native_role` của `native-entry.cjs`, trên snapshot source bất biến. Ba findings đã được tái hiện bằng tests đỏ rồi sửa: checker đổi hoặc mới xuất hiện giữa commands; executable bị thay sau build/check; dấu `{` trong prose che report JSON hợp lệ. Freshness/report tests đạt 9/9, tập request/repair/monitor tiếp theo đạt 30/30 trên Windows. Recheck tests xác nhận accepted evidence cũ giữ nguyên bytes và lời gọi lặp trên request đang accepted không chạy lại process.

Ngày 08/11 lúc `12:31:21.566Z–12:32:17.961Z`, chat Local gọi đúng `workforce_native_control` để recheck WF-R0010 trên runtime fingerprint `2b6cc0d9…`. Bốn build/run checks exit 0; Cornell note, C/C++ vẫn tồn tại; request đóng accepted với hashes của executable mới. Không gọi thêm specialist và không tạo request thay thế. Evidence: `evidence/native-pilot/entry-2f0eec0b-dded-4ac0-b726-6582096b9fcd.json`, `evidence/attempts/native-product-entry-recheck-209` trong fixture M3. Acceptance cũ của WF-R0008 vẫn là lịch sử; việc thêm bài 209 vào context chương rộng đã đổi membership, không được coi là current acceptance trên baseline mới.

Runner native đã có admission queue theo `max_workers` của project. Hai regression tái hiện lỗi cũ rồi đạt sau sửa: requests đồng thời giữ đúng giới hạn và không trộn reports; hủy request đang chờ không dispatch nó hoặc hủy owner khác. Tập adapter/entry/models/manifest đạt 36/36. Đây là regression domain; desktop sau đó đã chứng minh hai direct FnD jobs cùng chạy ở R0031/R0032, rồi hai full workflows R0033/R0034 có actual FnD overlap và acceptance riêng. Active editor reload/crash vẫn pending. Cancellation thật có proof R0024 với phạm vi nêu trên.

Recheck trùng khi request còn hoạt động đã có regression đỏ rồi xanh: control thứ hai theo dõi đúng owner thay vì mở lại state hoặc làm hỏng request đầu. Queue được project riêng theo request/assignment; GUI phân biệt queued với actual running, mất host observation sau reload vẫn không giả agent còn sống. Tập runner/monitor/direct roles/Local installer đạt 26/26 sau các thay đổi. Nút Universe chính của project native Local chuyển sang V-model gọn, bỏ connection/catalog UI khỏi entry mới; `Open Legacy Universe` giữ đường xem lịch sử. Tập UI/driver/manifest đạt 34/34; chưa tính là nghiệm thu cài/nâng cấp plugin đầy đủ.

Hai builder Agent Plugin (exact-project và Git-installable) đã dùng `nativeLocalProfile`/native client instructions cùng nguồn với installer. Sáu profile và request skill không còn gắn legacy intake hoặc aliases bắt buộc. Tập packaging/portable MCP đạt 6/6; MCP compatibility status vẫn riêng, không phải fallback cho native execution. Chưa publish plugin hoặc xác nhận actual host install/namespace migration. Guides `workforce.md` và `controlled-workflows.md` được đánh dấu phạm vi lịch sử, tránh trộn cơ chế với native Local.

## M5 — Request Experience và reuse được Manager tự nhận diện

**Mục tiêu:** request tương tự trong chat mới thực sự nhanh hơn vì dùng lại công cụ đúng.

**Lịch sử core 08/11, trước desktop reuse:** acceptance thật tự lưu experience SQLite/FTS5; plan tự chuẩn bị reuse brief trước FnD. Optional cache/registry lỗi trả ordinary implementation, không chặn giao việc. Backend có adapter gọi lại `runProcedure` hiện hữu cho procedure qualified, exact output set, current hashes/environment/scope; request reference do backend cấp là idempotency key. FnD được nhận outcome thật để kiểm tra delta, rồi vẫn cần review/check mới. Regression chạy ba local-process pilots với ít nhất hai bộ tham số nội dung, negative case và independent review trước qualification, sau đó đúng một native-host run; callback lặp không chạy lại generator. Core proof này sau đó được bổ sung bằng chuỗi desktop R0012–R0015 bên dưới; gói phân phối cuối vẫn chưa nghiệm thu lại M5.

Backend đã nối optional learning sau acceptance: chỉ nhận file `*.procedure.json` được giao và các generator/verifier/dependencies đã được cả Reviewer lẫn Tester inspect với hashes còn nguyên. Backend cấp registration identity, lưu reference vào experience, không bịa review/runs hoặc tự qualify. Manifest thiếu/sai không chặn sản phẩm accepted và không gây model retry. Bốn tests gồm hai lượt actual host checks xác nhận cả manifest hợp lệ và lỗi vẫn giao sản phẩm, cùng idempotence và stale/uninspected input rejection. Hướng dẫn chung: `resources/guides/native-reuse.md`. Các lượt tạo tooling, reuse từ chat sạch, adapt và mismatch được ghi theo evidence ở phần kế tiếp.

**Lượt tooling thật WF-R0012:** Local tạo generator/checker/tests/manifest và ví dụ Cornell. Reviewer đã bắt lỗi checker substring, multiline Markdown, packet tests và coverage; automatic escalation dùng native parent, giữ reports cũ. Lượt review sau vẫn có findings và dừng trong bound đã cấu hình. Probe độc lập dùng đúng `createProcedureInputPacket` xác nhận CLI exit 0 nhưng actual stdin exit 1 vì scripts nhầm `outputs` thành object/absolute path. Backend đã bổ sung hướng dẫn stdin sinh từ constructor thật vào handoff của các role làm tooling; không bắt scripts xác thực backend metadata. Public resume tiếp tục cùng request trên contract mới. Probe sau sửa đạt CLI 0/stdin 0. Lượt này có continuation sau sửa contract, không được coi là fresh first-pass success.

WF-R0012 đã đóng accepted: native Reviewer/Tester pass, ba nhóm host checks exit 0; hai permission tests và symlink coverage báo rõ chưa thực thi được trên Windows hiện tại. Candidate `native-8c1a427894224e5a41a89d49` tự được capture, Node minimum của runner được nâng cơ học lên 24 từ manifest hỗ trợ Node 18, không sửa product vì metadata này. Probe và execution evidence nằm trong fixture M3 dưới `evidence/procedure-contract`, `evidence/attempts/native-reuse-tool-contract-continuation` và `native-pilot/entry-e9a0379e-0475-46bb-9f1d-085eb50ba494.json`.

Sau actual acceptance, qualification harness đã liên kết passing native review `WF-99375C93-REV-0011`, chạy positive/negative checker thật và ba actual generator+verifier pilots với nội dung binary search/queue/stack khác nhau. Registry trả eligible; không bịa history hoặc bỏ chuẩn ba runs/hai non-destination variants. Qualification do acceptance harness thực hiện, chưa phải thao tác tự động của chat. Evidence: `evidence/note-qualification/result.json`.

**Chat sạch tự reuse đã đạt:** prompt circular-queues khác lời, chỉ đính kèm JSON và nêu destination, không nhắc script hoặc request cũ. Manager tìm đúng experience/procedure; backend thực sự chạy generator+verifier với source và output mới, run `1102fe5e-f5f3-4d51-9268-2ef539648e9b`. WF.FnD, WF.Reviewer và WF.Tester gọi native thật, host checker exit 0; WF-R0013 và final delivery `WF-99375C93-KNW-0048` accepted. Các hashes sản phẩm/công cụ WF-R0012 giữ nguyên; view hiện hành của R0012 vẫn thận trọng báo changed vì thư mục context có thêm note mới, lịch sử accepted không bị sửa. Chat mới cần một lần người dùng duyệt checker; không tuyên bố zero-interaction hoặc tỷ lệ tiết kiệm thời gian từ lượt có approval wait. Evidence: `evidence/reuse-desktop-summary.json` và `evidence/attempts/native-qualified-reuse-clean-chat` trong fixture `c3f40d36`. Các ca adapt/mismatch và invalidation được đối chiếu bên dưới; đây vẫn là một family note-rendering, chưa lặp trên gói cài cuối.

**Adapt đã chạy thật:** WF-R0014 dùng cùng generator/checker đã qualify cho note stacks mới, thêm riêng `study-checklist.md`. Backend chỉ tự chạy subset khi khác biệt duy nhất là các outputs bổ sung và exact eligibility của toàn procedure vẫn đạt. Run `f59ce9de-5886-4d4c-b54b-5c70c46f5130` tạo note; WF.FnD thực hiện phần checklist, sau đó Reviewer/Tester riêng và hai checks exit 0; final report `WF-99375C93-KNW-0053` accepted. Tất cả hashes công cụ và sản phẩm R0012 giữ nguyên. Đây là cùng chat tiếp sau ca fresh reuse, chưa phải mọi loại thay đổi semantic. Evidence: `evidence/reuse-adapt-desktop-summary.json` và `evidence/attempts/native-qualified-reuse-adapt-checklist`. Tests 28/28 gồm subset execution, mismatch/changed-script refusal và repair/runner.

**Mismatch đã chạy thật:** prompt nói rõ không tạo Cornell note, yêu cầu module circular queue và node:test. Dù có từ khóa Cornell/circular queue trùng lịch sử, WF-R0015 chọn ordinary, không chạy note procedure (registry vẫn có đúng 5 runs: 3 qualification, 1 exact, 1 adapt). FnD/Reviewer/Tester native riêng và cả ba checks exit 0; final report `WF-99375C93-KNW-0057` accepted. Hashes toàn bộ sản phẩm R0012/R0013/R0014 giữ nguyên. Evidence: `evidence/reuse-mismatch-desktop-summary.json` và `evidence/attempts/native-reuse-semantic-mismatch-queue`. Environment/scope/hash refusal có regression domain; chưa lặp cả chuỗi trên gói cài cuối hoặc Ubuntu.

**Freshness và số liệu:** regression applicability 3/3 kiểm tra actual script hash drift, platforms/tool versions, workflow mode, assurance và scope; native tests kiểm tra lại ngay trước execution, không spawn khi family/parameters/outputs/hash không phù hợp. Source script đổi sau selection bị skip, không ghi marker hoặc output mới. Các desktop requests R0012/R0013/R0014/R0015 ghi nhận lần lượt 7/3/3/3 native specialist calls; R0012 gồm những lần sửa được giữ lại, các requests khác mục tiêu nên không dùng số này để quảng cáo phần trăm tiết kiệm. Host entry/registry có timestamps, actual process runs và chat tool observations; token upstream không quan sát được thì giữ unknown. Logs: `native-adapt-green-20261108.log`, `native-reuse-mismatch-20261108.log`, `procedure-eligibility-regression-20261108.log` trong thư mục proof chung.

**Thực hiện:**

1. Mở rộng index từ procedure manifests/runs sang accepted request experiences và capability plans.
2. Truy hồi trước delegation; kiểm tra family, parameters, environment, scope, quyền, qualification và hashes/version.
3. Trả exact/adapt/new với execution brief đủ để FnD dùng công cụ, không khảo sát lại phần đã biết.
4. Backend tự lưu experience và cập nhật index sau acceptance; không bắt user/agent tự đăng ký metadata.
5. Giữ qualification hiện có với actual runs/inputs/checks/review. Candidate chưa đủ điều kiện tiếp tục được phân biệt rõ.

**Nghiệm thu liên hoàn:**

- [x] Request mới không có match: ra sản phẩm và lưu experience/tool references thật (WF-R0012).
- [x] Công cụ ứng viên được qualify bằng các inputs/checks/review thật; không tạo giả lịch sử để đủ số lượng (acceptance harness).
- [x] Mở chat Local sạch; prompt khác lời, input/output mới; không nhắc request cũ hoặc script (WF-R0013).
- [x] Manager tự tìm đúng experience, giao đúng script và thực sự chạy nó (WF-R0013).
- [x] Fresh verification đạt, request thứ hai đóng thật (WF-R0013).
- [x] Adapt chỉ triển khai delta; mismatch không chạy nhầm procedure (WF-R0014/R0015, phạm vi nêu trên).
- [x] Đổi hash/version/environment/scope làm mất eligibility hoặc yêu cầu kiểm chứng phù hợp (domain regression, không thay cho toàn bộ desktop matrix).
- [x] Có số liệu calls/tools/time/token quan sát được; không hứa sẵn tỷ lệ tiết kiệm (token upstream unknown).

## M6 — Marketplace discovery và capability plans theo role

**Mục tiêu:** Manager chọn công cụ từ hệ sinh thái mở và workers sử dụng được thật.

**Mới nhất — WF-R0028 trên build `f804a07e…`:** chat Local thực hiện đúng **ba capability actions**: một search từ verified catalog cache, một inspect toàn bộ 2.087 bytes `java-docs`, một install approved component; sau đó gọi đúng một **WF.Reviewer Worker / `customendpoint/9router/top-models`**. UI có card **Read skill java-docs**; exact source path/hash được kiểm tra bằng backend evidence riêng, không suy ra từ card. Kết quả `role-completed` là `role-reports/marketplace-java-docs-review.md`, chỉ ra ba sai lệch Javadoc đúng source và lưu review record. Audit độc lập **17/17** đối chiếu actual calls, pin/license/receipt, publication hashes và preservation: 618 file cũ giữ nguyên, bốn metadata files thay đổi đúng dự kiến, không có file thêm ngoài phạm vi. Manager đã bổ sung defect hints trước dispatch; scope này chứng minh lựa chọn/cài/binding và giao báo cáo, không chứng minh Reviewer tự phát hiện mù hoặc phần mềm đã accepted. Worker không chạy compile/doclint; các JDK controls trước đó là evidence riêng. Evidence: `marketplace-java-docs-v2-independent-audit-20261109.json` và `marketplace-java-docs-ui-observation-20261109.json` trong `c3f40d36/evidence`.

**Lỗi v1 được giữ nguyên và sửa theo format chung:** attempt trước trên `87a29959…` không tạo report hoặc dispatch worker; một search cộng 19 inspect lặp lại `UNSUPPORTED_SKILL_LAYOUT`, root dừng chat. Toàn bộ 619 file baseline giữ nguyên (`marketplace-java-docs-independent-incomplete-audit-20261109.json`). Nguyên nhân là service coi manifest không có field `skills` là thiếu layout, trong khi actual manifest 544 bytes khai báo canonical Agent Plugins 1.0.0: chuẩn quy định `skills/` cố định với immediate-child `SKILL.md`, không cần field đó. Parser nay nhận diện đúng schema, kiểm tra metadata cục bộ, giữ legacy declarations riêng và không cho unknown canonical fields đổi đường dẫn; service xác minh actual pinned tree và chỉ đọc header đúng tên được chọn. Unsupported optional calls trả `retryable:false` cùng hướng tiếp tục ordinary project tools, thay vì bảo model đoán path hoặc lặp nguyên input. Exact manifest, bốn skill headers và LICENSE từ pin thật đã thành fixtures độc lập với artifacts folder. [Quy tắc portable discovery](https://agent-plugins.org/specification#61-fixed-locations); [tên skill phải khớp thư mục](https://agentskills.io/specification#name-field).

**Source/policy và preflight:** host giữ repository/commit/catalog SHA/license SHA cùng quyền `allow_skills`; model chỉ chọn approved source/package/skill names. Nguồn mặc định dùng catalog pin đã review; cấu hình User có thể thay nguồn hoặc opt out bằng danh sách rỗng, workspace override không tự cấp trust. Cache fresh tránh đọc catalog qua network; expired/corrupt/nguồn không được duyệt, source drift, bounds, cancellation và late policy revocation có negative controls. Service read/install thật trong **owned TEMP project**, không phải workspace nghiệm thu, đã đạt với bảy public REST reads và 0 model calls: `artifacts/workforce-native-local-proof/native-capability-java-public-preflight-20261109.json`. Source review read-only ghi tại `evidence/native-capabilities-portable-review-20261109.json`. Proof R0028 mới là lượt Local dùng skill trong request; preflight hoặc installation riêng không chứng minh host sử dụng skill.

**Hai domains đã chạy thật trên build `1e796ba7…`:** Manager so sánh `context-map` với `sql-code-review` theo nhiệm vụ, không chỉ dùng một danh sách tên mặc định.

| Request | Selection và thực thi quan sát được | Đầu ra/kiểm chứng |
| --- | --- | --- |
| **WF-R0026 — queue analysis** | Chọn riêng `context-map`; WF.P-RES Worker có actual **Read skill: context-map** card. Backend pin path/hash độc lập; UI card không hiện exact path. | `role-reports/marketplace-queue-context-map.md`; role-completed với hai findings có cơ sở, **không full-product accepted**. Independent audit **14/14**; 574 file cũ giữ nguyên, chỉ hai runtime indexes thay đổi. |
| **WF-R0027 — SQLite security** | Plan bind `sql-code-review` cho Reviewer; actual Manager/Reviewer reads thấy `.github/skills/sql-code-review/SKILL.md`. FnD cũng đọc skill từ common context: đây **không phải quyền đọc độc quyền của Reviewer**. Năm native calls: FnD → Reviewer findings → strong FnD repair → Reviewer → Tester. | `skill-fixtures/sql/queries.mjs`, `queries.test.mjs`, `SECURITY.md`; ba host checks exit 0, current accepted. Independent audit **15/15**, giữ 580 file cũ cùng các thay đổi sản phẩm/index được phép. |

Evidence trong `c3f40d36/evidence`: `marketplace-context-map-independent-audit-final-20261109.json`, `marketplace-context-map-ui-observation-20261109.json`, `marketplace-sql-independent-audit-final-20261109.json`, `marketplace-sql-ui-observation-20261109.json`. SQL oracle riêng trên bản sao có 38 assertions: baseline syntax/tests/oracle **0/0/0**; hai mutants `unsafe-name-interpolation` và `bypassed-sort-allowlist` đều syntax **0**, delivered tests **1**, oracle **1**, đúng nguyên nhân. Toàn bộ 628 files của workspace thật giữ nguyên trong lượt oracle; `marketplace-sql-independent-controls-20261109.json` có `workspace_changes:[]`. Không suy ra safety/performance của SQL engine khác hoặc deployment thực.

**Nguồn và scope cài đặt ban đầu:** hai components từ `github/awesome-copilot` pin `02466d1eb70b841c90717b0fc2dc9457aa6f606f`, MIT notices/receipts/hashes đầy đủ; stage ban đầu giữ 569 files, 0 network/model calls và không đổi global settings (`marketplace-component-staging-20261109.json`). Proof R0026/R0027 là exact approved workspace skill components đã stage; proof Manager cài riêng component mới là R0028 ở trên. Cả ba chưa chứng minh full plugin installation hoặc Manager cài mọi marketplace package/MCP dependency. Discovery/receipt view không tự khẳng định loaded/used/verified; actual read và kiểm chứng sản phẩm là evidence riêng. Lifecycle giữa requests trên hai components đầu đã được kiểm tra ở phạm vi dưới đây; thao tác khi invocation đang chạy vẫn chưa nghiệm thu.

**Lifecycle giữa requests đã đạt trên build `27e80709…`:** sau reload editor, acceptance harness dùng runtime API để **disable `context-map` → cài lại selection gốc**, rồi **remove `sql-code-review` → cài lại selection gốc** trong workspace đã chạy R0026/R0027. Khi deactivated, harness xác nhận component không khả dụng; sau restore, R0026 trở lại `role-completed` với `accepted:false`, R0027 vẫn current `accepted:true`, không chạy lại model/checker. Receipt raw SHA thực sự thay đổi do lifecycle history; snapshot gốc được kiểm tra theo đúng SHA đã lưu, rồi đối chiếu source, files và license. Không thay SHA cũ trong evidence bằng hash hiện tại hoặc viết lại execution history. Audit read-only độc lập xác nhận **607 file ngoài component metadata** giữ nguyên, gồm **251 records và 49 check logs**; bytes cài lại khớp approved source selection. Evidence: `marketplace-native-lifecycle-20261109.json`, `check-marketplace-lifecycle-native-20261109.mjs` và `marketplace-native-lifecycle-independent-audit-20261109.json` trong `c3f40d36/evidence`. Audit độc lập chỉ đọc trạng thái restore và snapshots; không toggle lại hoặc giả nhận đã quan sát độc lập thời điểm deactivated.

**Regression lifecycle hiện hành:** cùng build `27e80709…` đạt **86/86**, 0 fail/cancel/skip, hashes trước–sau giữ nguyên (`native-lifecycle-current-dist-27e80709-20261109.json` và TAP log). Có positive restore cho state mới và v1 raw-bound, archive thiếu/corrupt, đổi license/assets, selected skill bị tắt và các checker thực sự phụ thuộc raw receipt qua argv/script/directory. Raw dependencies đó vẫn làm mất current evidence khi history thay đổi; semantic bridge không miễn kiểm tra chúng. Các ca unit/control dùng outcome giả lập tại ranh giới model và tiến trình checker thật, không thay thế proof Local ở hai request trên. Phạm vi actual lifecycle hiện chỉ **giữa requests qua runtime API**: chưa có proof UI cài/gỡ, active-invocation control lease/toolset freeze hoặc whole-plugin/MCP lifecycle. Lượt selected-skill installation R0028 không mở rộng phạm vi lifecycle này. Không quảng cáo cơ chế kiểm tra dependency hữu hạn là filesystem sandbox hay theo dõi mọi I/O động của binary.

**Core, hiệu năng và regressions:** giữ ledger các suite trước 55/55, receipt-view/preparation 33/33 và UI 41/41, không cộng chồng; evidence cũ vẫn ở `m6-current-dist-regression-20261109.log`, `m6-skill-view-bounds-fix-20261109.json` và `m6-ui-current-dist-independent-20261109T021454Z.log`. Tests bao phủ bounded traversal, exact-name ambiguity, pin/file changes, same-bytes junction, durable removal và legacy roots. Lỗi history lookup được tái hiện deterministic: một match gây 20 lần đọc file record, năm matches gây 100; nay mỗi synchronous prepare dùng một fresh `loadRecords` Map, vẫn đối chiếu accepted status/revision/hash, không cache xuyên operations hoặc cấp quyền chạy. `native-prepare-snapshot-red-20261109.log` → `native-prepare-snapshot-green-20261109.log` đạt **2/2**. Actual fixture preparation quan sát **730 ms/282 ms** sau sửa so với khoảng **17,8 giây/10,6 giây** trước đó; tải khác nhau nên không phải SLA. Current-dist sau I/O fix đạt **29/29**, 0 skips và unchanged source hashes: `evidence/native-changed-final-1e796ba7-20261109.json`. Timeout 60 giây của batch b9 và lỗi fixture filesystem cũ vẫn giữ nguyên hồ sơ; không dùng lượt pass mới để bịa nguyên nhân cũ.

**Regression của đường cài mới:** trên build `87a29959…`, capability core có **100/100** (`evidence/native-capabilities-current-dist-20261109.json`) và entry/plugin/profile có **35/35** (`native-capability-bindings-current-dist-20261109.log`); đó là hai suite riêng trước khi v1 lộ format mismatch. Sau sửa generic canonical layout, parser source **11/11**, service source **20/20** và current-dist **49/49**, 0 skips, với logs `m6-portable-layout-green-20261109.log`, `native-capabilities-convention-source-20261109.log`, `native-capabilities-portable-current-dist-20261109.log`. Các logs không cộng thành coverage tổng hoặc chứng minh whole regression suite xanh. Fixture byte checks xác nhận exact manifest, bốn headers và root LICENSE; Git tree trong fixture là projection có kiểm soát, không giả là toàn bộ response live.

**Learning và phần còn mở:** sau R0027, fresh preparation tìm đúng accepted experience/capability plan mà không sửa workspace hoặc tự execute (`marketplace-sql-fresh-history-advice-20261109.json`); đây là historical advice, current eligibility/load vẫn phải kiểm tra lại. Full Windows suite lịch sử có **2.133 total / 2.119 pass / 6 fail / 8 skip**; các nguyên nhân có targeted fixes giữ evidence riêng, còn admission deadline 15 giây chưa tái hiện và chưa đóng. `windows-regression-final-failures-20261109.json` và `engine-admission-preflight-measurement-20261109.json` ghi rõ giới hạn đó. M6 mới có một đường Manager cache→inspect→install portable skill chạy thật; marketplace/dependency support tổng quát, MCP capability plans, full client conformance, UI/active-invocation lifecycle và nghiệm thu package vẫn mở. M7/M8 pending; chưa shipping.

Nghiên cứu nền từ tài liệu chính thức đã lưu tại [native plugin capabilities](../research/2026-11-08-native-plugin-capabilities.md). Phải phân biệt Local với các harness khác, inventory UI với slash commands, cài với thực sự dùng, và public provider/MCP API với command/settings thử nghiệm. Đây chưa phải M6 đạt.

**Thực hiện:**

1. Tách registry mở rộng khỏi trust policy; giữ tương thích các providers đã có.
2. Manager tra cache trước; khảo sát nhiều nguồn khi thiếu capability, domain mới hoặc cache cũ.
3. So sánh actual contents, compatibility Local, license, dependencies, permissions và context cost.
4. Chuẩn bị/cài package được duyệt qua cơ chế host hỗ trợ; pin versions trước dispatch.
5. Nạp skill hoặc expose tool qua adapter tương thích; ghi nhận theo mức selected/installed/loaded/used/verified.
6. Lưu capability plans đã thành công vào experience; không giới hạn Humanizer/Ponytail hoặc bất kỳ danh sách tên cố định nào.

**Nghiệm thu:**

- [x] Hai request khác domain chọn capability khác nhau sau so sánh có lý do (R0026 context-map/P-RES và R0027 SQL/Reviewer; components đã được stage có kiểm soát).
- [x] Role nhận selected skill, có actual native read/tool evidence và artifact checks trong hai scopes trên; không claim automatic whole-plugin loading hoặc quyền đọc độc quyền.
- [x] Manager cache→inspect→install một portable skill mới rồi giao role sử dụng thật (R0028 `java-docs`, audit17/17); scope Reviewer có hints, không full software accepted.
- [x] Đường portable-skill dùng host-approved pins/User source policy, không sửa private installation cache; actual approved install và negative controls nguồn không được duyệt đã đạt trong phạm vi hỗ trợ.
- [ ] Dependency/plugin tùy chọn không khả dụng có phương án hợp lệ khác: core đã có ordinary-work/non-retryable fallback; còn nghiệm thu request native thực sự đi tiếp bằng công cụ khác khi nguồn bị từ chối.
- [x] Fresh catalog cache không quét lại catalog trong lượt search R0028; source tests giữ zero-fetch no-match, cache stale/partial/corrupt và nguồn bị thu hồi có controls riêng.
- [x] Giữa requests, disable/remove rồi cài lại đúng approved components đã dùng thật giữ sản phẩm, records/check logs và closure gốc; không chạy lại model/checker (R0026/R0027, build `27e80709…`, audit 607 files).
- [ ] Disable/uninstall qua UI và khi invocation đang chạy không làm thay đổi tập tools đã chốt; active-invocation control lease còn cần proof riêng.

## M7a — REA phân tích 9router và chuẩn bị tích hợp

**Mục tiêu:** REA được dùng cho một nhiệm vụ phân tích có evidence, không chỉ được bật trong cấu hình.

**Thực hiện:** WF.P-RES dùng REA MCP/skills phù hợp để lập feature/dependency map, kiểm tra license và đối chiếu source với behavior của upstream ở môi trường thử. Nghiên cứu source có thể chuẩn bị sớm; kết quả chỉ đạt milestone khi có actual REA evidence phù hợp.

**Đã chuẩn bị read-only 09/11:** [managed gateway feasibility](../research/2026-11-09-managed-gateway-feasibility.md) ghi source/API/provider seams, MIT notices và candidate `9router@0.5.116`/commit `1339107e…`; tách runtime REA 6.7.0 hiện pin khỏi source HEAD 6.8.0. Upstream skill không khuyên dùng REA cho source architecture thông thường: đề xuất actual REA trên shipped artifact subset đã kiểm tra inventory/hash, đối chiếu source bằng repository tools. Fixture hiện chưa bật/cài REA, native binding REA và actual artifact evidence chưa có; nghiên cứu này không tick các acceptance ở dưới hoặc M7b.

**Nghiệm thu:**

- [ ] Có feature map cho connections, discovery, quota/usage, RTK, combo và vision.
- [ ] Có ranh giới service/API, dependencies, candidate pin và compatibility evidence.
- [ ] Xác định lifecycle, credential ownership và update/rollback.
- [ ] Phân biệt REA analysis với router/auth; không coi source open hoặc tool enabled là chạy gateway thành công.

## M7b — Managed provider gateway tích hợp

**Mục tiêu:** native Local sử dụng các năng lực 9router mà không cài router rời hoặc tạo hai alias bắt buộc.

**Thực hiện:** đóng gói upstream service được pin, quản lý lifecycle, đăng ký provider qua VS Code Model Provider API; models native khác tiếp tục hoạt động trực tiếp. Tái sử dụng UI upstream khi cần kết nối/config thay vì viết dashboard mới.

**Nghiệm thu:**

- [ ] Một request Local thật có streaming và tool calls qua gateway.
- [ ] Provider connections phù hợp, gồm Codex/GitHub Copilot/Claude; trạng thái connector đã/chưa test thật được ghi rõ.
- [ ] Quota/reset/usage có nguồn và timestamp; không có số liệu thì unknown.
- [ ] Native requests ngoài gateway không bị cộng vào gateway usage.
- [ ] Auth failure/quota/outage/cancel được phân loại và xử lý đúng; fallback chỉ trong tập được phép.
- [ ] Combo giữ system/tool contracts; route thực tế được quan sát đúng mức.
- [ ] Vision test xác nhận ảnh đến model đủ khả năng; đổi model được công khai.
- [ ] RTK có before/after measurement và regression giữ compiler errors/assertions/nội dung nghiệm thu; raw evidence được bảo toàn.
- [ ] Upgrade/rollback không mất connections/settings/history hoặc đổi phiên đang chạy.

## M8 — Nghiệm thu tổng hợp, đóng gói và phát hành

**Mục tiêu:** cả năm yêu cầu gốc đạt trên bản cài thật, không chỉ từng module riêng lẻ.

**Thực hiện:** chạy toàn bộ các ca A–P trong kế hoạch đầy đủ; regression Windows/Ubuntu; install/uninstall/migration; chuẩn bị runtime, VSIX và Agent Plugin với compatibility manifest chung.

**Nghiệm thu:**

- [ ] Lặp prompt LeetCode nguyên bản trên gói cài cuối: checkout b8 đã đạt R0025 fresh với Cornell/C/C++, independent review/testing và bốn checks exit 0; chưa tick M8 từ proof checkout.
- [ ] Sửa bug có tests, research/docs và project mới chạy trọn.
- [ ] Request mới → qualification thật → chat sạch tự reuse đã đạt M5 và chạy lại trên gói cài cuối.
- [ ] Native inventory/no-aliases, model controls, direct roles, V-model sync, marketplace và managed gateway đều đạt.
- [ ] Cancel/reload/concurrency/user edits không có side effect trùng hoặc acceptance trên evidence cũ.
- [ ] Records/IDs/history còn nguyên; phần mềm mới không khởi động OpenCode.
- [ ] `init/update --local` bảo toàn `.git/info/exclude` và `.gitignore`.
- [ ] Package install trên môi trường sạch nhận đúng runtime/plugin/VSIX, không dựa source checkout.
- [ ] Release ghi rõ versions, tested models/providers, Preview/Experimental và giới hạn desktop Linux.
- [ ] Chỉ sau khi evidence đạt mới phát hành GitHub release; không coi screenshot, profile discovery hoặc CI xanh riêng lẻ là full acceptance.

## Cách ghi nhận tiến độ

Sau mỗi milestone, cập nhật trạng thái bằng kết quả thực: mã nguồn/commit liên quan, commands/tests, evidence paths, giới hạn còn lại và mốc kế tiếp. Không tick tiêu chí chỉ từ cấu hình hoặc lời agent tự khai.

Một milestone hoàn thành không đồng nghĩa cả WorkForce đã hoàn tất. Mỗi mốc được kiểm tra ngay; M8 đối soát tổng hợp trên gói phân phối cuối.
