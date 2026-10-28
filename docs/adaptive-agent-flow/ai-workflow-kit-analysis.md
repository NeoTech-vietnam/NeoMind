# Kế thừa ai-workflow-kit vào NeoMind

Ngày: 28/10/2026. Trạng thái: nghiên cứu ban đầu dựa trên snapshot và test local; các phương án dưới đây chưa phải đặc tả được duyệt.

Người dùng cung cấp kit đã dùng trong dự án khác và yêu cầu phát triển NeoMind dựa trên flow đó. Đây là nguồn thực tế để cụ thể hóa thiết kế Adaptive Agent Flow. Trải nghiệm sử dụng trước đây do người dùng xác nhận; phiên này chưa đo chất lượng hoặc chi phí thực tế của flow.

## 1. Phạm vi đã đọc và kiểm tra

- [README](../../references/ai-workflow-kit/README.md), [SETUP](../../references/ai-workflow-kit/SETUP.md), template entrypoints, config, memory và workflow.
- Skills cốt lõi `kb`, `handoff`, `comprehension-gate`; profiles reviewer, curator và auditor; agent sync và hooks.
- Code KB: index, trace, file lookup, coverage, proposal/review/apply và tính hợp lệ của journal.
- Bộ test có sẵn, chạy trong bản sao tại `/tmp`, giữ danh sách `BANNED` gốc từ ZIP. Khi kiểm tra cuối, file `tests/test_templates.py` của bản tham khảo có thay đổi local thành `BANNED = []`; thay đổi được giữ lại và ghi trong manifest, không thuộc kết quả test baseline này.

Các skill vendored chưa được audit toàn bộ. Không cài kit vào NeoMind và không kiểm thử trực tiếp với Claude/Codex/Nimbalyst trong lần nghiên cứu này. Các instructions của template là đối tượng nghiên cứu, chưa trở thành policy của NeoMind.

## 2. Flow thực tế trong kit

```text
Yêu cầu
  -> đọc rules + memory liên quan
  -> tra KB: yêu cầu / quyết định / lessons / file liên quan
  -> kế hoạch: Repo, Action, Mirror, Gotcha, Validate, Trace
  -> người dùng duyệt theo phạm vi và tier
  -> thực hiện
  -> kiểm chứng bằng lệnh, output, exit code và ca đối chứng
  -> đề xuất test/lesson; duyệt -> áp dụng vào KB
  -> cập nhật owner files và bàn giao ngắn
```

Nguồn: [workflow](../../references/ai-workflow-kit/template/.claude/memory/workflow.md), [KB skill](../../references/ai-workflow-kit/template/.claude/skills/kb/SKILL.md), [handoff](../../references/ai-workflow-kit/template/.claude/skills/handoff/SKILL.md).

Các nhánh bổ sung:

- N1: người dùng quyết định hướng, nghiệm thu, sign-off, commit và push.
- N2: AI thực hiện có checkpoints cho thiết kế, code vượt kế hoạch, thao tác thiết bị.
- N3: AI làm trọn tác vụ đã xác định như xử lý dữ liệu, scripts, tài liệu có nội dung đã chốt và memory.
- Comprehension gate hỏi để kiểm tra người dùng hiểu thay đổi; đây là hoạt động học tập, không thay thế kiểm thử kỹ thuật và không chặn task/commit theo skill nguồn.
- Audit chỉ chạy theo yêu cầu; bounded work ưu tiên làm trực tiếp; chỉ một session ghi code trong cùng vùng core.

## 3. Kit đã cung cấp gì bằng code?

| Thành phần | Cơ chế trong snapshot | Giá trị cho NeoMind |
| --- | --- | --- |
| Cài đặt / nâng cấp | `init.py`: engine có manifest hashes; template copy một lần; từ chối ghi đè engine đã sửa nếu không force | Tách framework khỏi cấu hình project và kiểm tra drift |
| Config | `engine/config.py`: defaults + project overrides, paths và validation | Điểm bắt đầu cho project pack; chưa có layered inheritance đầy đủ |
| KB nguồn tài liệu | Group read-only, expected IDs, copies/hashes và trạng thái unavailable | Tra cứu có nguồn và phát hiện dữ liệu lệch |
| KB store | Journal, propose/review/apply, hashes trước/sau, locking, export/restore | Lưu quyết định và lessons có lịch sử kiểm tra được |
| Retrieval | SQLite FTS5, scope/type/status filters, citation, trace và file lookup | Memory truy xuất theo nhu cầu |
| Context hooks | Nạp records liên quan trước edit; nhắc test/lesson khi kết thúc | Giảm bỏ sót bằng context đúng lúc |
| Action hooks | Regex rules và grants có thời hạn; bảo vệ một số đường dẫn | Guard chống thao tác nhầm; không phải sandbox |
| Agent sync | Claude Markdown -> Codex TOML, model tier theo config | Tham khảo adapter generation và parity checks |
| Competency | Scope theo Git, quiz records, learning map, lessons checker | Gói học tập riêng, có thể bật khi project cần |

`engine/kb/flow.py` thực hiện truy vấn liên kết/coverage/open items; tên file không có nghĩa là đã có scheduler điều phối agent. Kit chưa cung cấp flow graph executor hoặc host adapter Nimbalyst theo thiết kế NeoMind hiện tại.

SQLite trong kit là **chỉ mục có thể dựng lại**, không phải nguồn chuẩn memory duy nhất. Read-only groups lấy tài liệu làm nguồn; store groups lấy journal làm nguồn và Markdown là export. Thiết kế này đáng thử trước khi chuyển toàn bộ memory sang DB. Đây là đề xuất kế thừa, chưa thay quyết định Markdown-first hiện tại.

## 4. Những chỗ cần ánh xạ, không sao chép nguyên trạng

| Vấn đề | Quan sát | Hướng đề xuất |
| --- | --- | --- |
| Quyền người dùng | KB skill có bước owner OK và duyệt mọi TST; NeoMind muốn Run tự động qua bước bình thường | Giữ quyền N1; định nghĩa chính xác N2 checkpoints và N3 tự động; kết quả test có thể lưu như observation, tách khỏi record được duyệt |
| Agent authority | `.claude/agents` là nguồn; bản Codex không sinh quyền tools/read-only | Profiles trung lập với công cụ; adapter công bố quyền thực thi thực tế |
| Delegation | Kit cho phép delegation có điều kiện, NeoMind mặc định core sở hữu quyết định | Chuyển đề nghị delegation thành yêu cầu core, không để worker tự tạo session |
| Dữ liệu và run | Kit có records và journal, chưa có run/step/attempt/session lifecycle | Bổ sung run ID, flow version, baseline, attempt, check refs và feedback |
| Hooks | JSON payload và tool names gắn từng harness | Conformance theo host/version trước khi coi hook là enforcement |
| Review identity | Journal kiểm tra reviewer khác actor, nhưng tên reviewer do CLI truyền vào | Xem đây là record của quyết định; chưa phải xác thực con người đã duyệt; approval UI phải gắn đúng proposal/hash |
| Verification | Ca đối chứng là quy tắc trong skill; chưa tự kiểm tra mọi claim của agent | Output contract gắn command/output/exit code/control/baseline; core kiểm tra trước acceptance |
| Read-only verifier | Profile reviewer có Bash và chỉ dẫn read-only | Kiểm tra quyền runtime và bảo vệ workspace, không suy ra Bash là read-only |
| Các domain | Có agents viết report, email, tiếng Anh, competency | Tách thành packs tùy chọn; v1 code không cần tải toàn bộ |

Không mặc định thêm quiz hoặc reviewer/auditor vào mọi run. Quyền sửa của verifier, ngưỡng checkpoint và số vòng repair vẫn còn mở.

## 5. Kết quả kiểm tra local

Lệnh baseline: `python3 -m unittest discover -s tests -t . -v` tại bản sao kit. Xem [bằng chứng](evidence/ai-workflow-kit-tests.txt).

- Chạy 424 tests trong 28.300 giây, suite exit 1, báo `failures=5, skipped=8`. Các failure records có cả subtests, không diễn giải thành 5 test methods riêng.
- Generated hook command dùng `python`; máy hiện chỉ có `python3`. Chạy lại riêng `GeneratedCommandsRunTest` với symlink `python` -> interpreter hiện có trong PATH riêng của thử nghiệm: 1 test pass. Không đổi Python hệ thống hay source.
- Bốn failure records còn lại thuộc path validation: `C:/a.md`, `C:a.md`, `\\a.md` và plugin path `C:/outside.py`. `kb.inside()` dùng `Path` theo OS hiện tại nên Linux không từ chối một số dạng Windows như test mong đợi. Đây là khác biệt validation, chưa chứng minh có truy cập được file bên ngoài workspace trên Linux.
- Các test bị skip không phải bằng chứng tính năng đã chạy được. Chưa xác minh Windows hoặc live harness callbacks.

Trước khi tái sử dụng code, cần chuẩn hóa cách nhận dạng cả POSIX/Windows paths và chọn interpreter khi sinh hook commands. Chưa sửa các lỗi đó trong snapshot.

## 6. Lộ trình đề xuất dựa trên flow nguồn

### Bước 1: chốt một lát cắt của flow

Chọn một bug có cách tái hiện hoặc một tính năng nhỏ trong project thử nghiệm. Ghi lại: yêu cầu, phạm vi file, tier, điểm cần owner quyết định, test/control và đầu ra mong muốn. Dùng template kế hoạch của kit để tránh thiết kế flow chung quá sớm.

Đầu ra: một mô tả pilot đủ cụ thể để so sánh cách dùng kit hiện tại và NeoMind. Cần người dùng chọn task; chưa tự tạo task sản phẩm thay họ.

### Bước 2: cụ thể hóa contract tối thiểu

```text
Lookup/context -> Plan -> Implement -> Verify + control -> Handoff/feedback
                    |                         |
             chờ nếu cần quyết định    repair trong ngân sách / chờ blocker
```

Tách step result và observation khỏi accepted result; tách đề xuất memory khỏi memory được duyệt. Profile và quyền được core/adapter ánh xạ. Mỗi lần chạy giữ flow snapshot, baseline và session refs. Số session độc lập, format schema và budgets chốt sau pilot.

### Bước 3: thử một runner và một lần handoff

Dùng tài khoản hiện có để xác minh inference, output/errors, session isolation, cancellation/resume và delegation policy. Chỉ thử một runner trước. Sau đó thử verifier ở session riêng trên cùng artifact baseline. Chưa cần viết lại KB bằng ngôn ngữ khác; có thể khảo sát gọi Python CLI với output JSON như một ranh giới thử nghiệm.

### Bước 4: kết nối Nimbalyst

Dùng cùng contract/core qua owned-session API; panel hiển thị trạng thái, bằng chứng và điểm chờ. Kiểm tra đóng panel, reopen và reconcile trước khi mở rộng. Standalone vẫn có lifecycle riêng.

### Bước 5: đo và quyết định phần code tái sử dụng

So sánh một agent + kit với flow có verifier độc lập bằng cùng task, baseline và checks. Ghi kết quả, lỗi sót, số lần người dùng can thiệp, thời gian và usage quan sát được. Dữ liệu thiếu để unknown. Từ đó mới quyết định giữ Python KB, bọc qua adapter hay port module cụ thể.

## 7. Điểm cần thảo luận tiếp

1. Trong dự án cũ, phần nào của kit hiệu quả nhất và phần nào gây tốn thao tác? Snapshot là template nên chưa chứa đầy đủ lịch sử thực chiến đó.
2. Task pilot nào sẽ dùng; N1/N2/N3 áp dụng thế nào vào việc đó?
3. Với v1, người dùng muốn review từng test/lesson proposal hay review theo gói cuối run? Đây là lựa chọn UX và authority cần chốt.

Model bindings trong kit là cấu hình mẫu, chưa được xác minh khả dụng. Antigravity tiếp tục hoãn. Chưa commit/push hoặc triển khai runtime.
