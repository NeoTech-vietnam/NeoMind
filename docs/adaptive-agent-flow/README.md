# Bàn giao research và thiết kế Adaptive Agent Flow

Cập nhật ngày 28/10/2026. Nhánh làm việc: **`hieu/adaptive-agent-flow`** trong repository **NeoTech-vietnam/NeoMind**.

## Đọc trước trong session local

1. [Định hướng sản phẩm và quyết định của người dùng](product-direction.md).
2. [Kiến trúc, ranh giới host/runner và default flow đề xuất](architecture.md).
3. [So sánh với hướng Thạch và các phân biệt kỹ thuật](implementation-comparison.md).
4. [Probe CLI thực tế và những gì chưa kiểm chứng được](cli-invocation-probe.md).
5. [Nghiên cứu gốc: adaptive flow, project packs, memory, benchmark và repo năm 2026](../research/adaptive-project-workflows-2026.md).
6. [Antigravity: SDK/CLI đã xác minh nhưng tích hợp đang tạm hoãn](antigravity-research.md).

Đây là bộ bàn giao ý tưởng/research, không phải một sản phẩm đã chạy được. Nhánh bắt đầu từ baseline tài liệu `0cc5f56`; không chứa implementation controlled workflow của Thạch. Code ở nhánh Thạch là nguồn tham khảo; chưa quyết định kế thừa engine hay merge toàn bộ vào nhánh này.

## Những gì đã chốt với người dùng

- Tiếp tục phase research và thiết kế trước khi triển khai; cùng discuss để làm rõ nhu cầu và giảm sửa đi sửa lại.
- Người dùng làm việc trong Nimbalyst, muốn tận dụng session đa provider, task/Kanban và Dev Extension.
- Hai môi trường chạy độc lập: Nimbalyst và standalone. Dùng chung định nghĩa flow/logic core, không phụ thuộc việc nhìn thấy hay chuyển session qua lại.
- Nimbalyst dùng sessions do host quản lý; standalone nghiên cứu adapters tới SDK/runtime sẵn có.
- Trải nghiệm **Run rồi theo dõi, chỉ can thiệp khi cần**; không bắt bấm chuyển từng bước bình thường.
- Core quyết định chia việc và chuyển bước. Worker mặc định không tự tạo subagent hoặc session con; phân biệt instructions-only với chặn bằng runtime/tool đã kiểm chứng.
- Phiên bản đầu có một flow mặc định cho **phát triển tính năng / sửa lỗi code**, có visualization trong Nimbalyst và trạng thái chạy standalone.
- Memory Markdown trước, hướng tới SQLite sau; lưu feedback người dùng theo run/flow version.
- Ưu tiên tài khoản/subscription hiện có; không yêu cầu mua API key để đạt v1. Antigravity đang hoãn, không tự tiếp tục cài hoặc test runner này.

Flow/agent editor kéo thả, level 1–5, project-specific packs, bộ chọn adaptive và tự tối ưu là hướng dài hạn. Chưa có bằng chứng chất lượng tăng theo level/số agent. Chưa đưa tất cả các khả năng này vào v1.

## Trạng thái xác minh

| Nội dung | Trạng thái |
| --- | --- |
| Codex SDK và App Server, Claude Agent SDK, OpenCode SDK/server | Đã đọc tài liệu/source; chưa có SDK inference end-to-end thành công trong cloud này |
| Nimbalyst owned-session và panel API | Đã đọc SDK/type/source; chưa thử extension trên ứng dụng của người dùng |
| Caller chung khởi chạy ba CLI | Đã thực hiện, thu output và session IDs; không có lượt inference thành công |
| Blockers probe | Codex: cloud proxy 403; Claude: chưa đăng nhập; OpenCode: chưa resolve model và catalog bị chặn |
| Default flow, engine và adapters của nhánh mới | Chưa triển khai |
| SQLite migration, adaptive selector, benchmark chất lượng | Chưa triển khai/chưa chạy |

Các công cụ đã cài tạm vào `/tmp` của cloud và kết quả raw không được coi là thành phần có trên máy local. Không lưu credentials hoặc raw environment dumps trong Git. Session IDs trong output thử nghiệm không chứng minh resume hoặc persistence.

## Tiếp tục trong session local

Mở checkout NeoMind và kiểm tra branch/working tree trước khi làm việc. Nếu repo đã có thay đổi, giữ lại thay đổi đó; không reset hoặc đổi branch cưỡng chế. Các lệnh Git bên dưới chỉ áp dụng khi đã kiểm tra phù hợp trạng thái local:

```sh
git fetch origin
git switch hieu/adaptive-agent-flow
git pull --ff-only
```

Nếu local chưa có branch thì dùng `git switch --track origin/hieu/adaptive-agent-flow`. Không nhầm với nhánh cũ `hieu/adaptive-workflows` hoặc `test/thach-workflow`.

Thứ tự công việc đề xuất:

1. Cùng người dùng chọn **một task code cụ thể** làm pilot; nhóm công việc đã chốt, không hỏi lại nhóm đó.
2. Ghi phiên bản Nimbalyst, runner, hệ điều hành và cách đăng nhập hiện có. Chỉ kiểm tra status/tên bindings, không đọc hoặc in giá trị credential.
3. Kiểm chứng yêu cầu tối thiểu trên một runner dùng account hiện có; ưu tiên thử Codex SDK/App Server hoặc Claude Agent SDK trước. OpenCode còn phụ thuộc quyền truy cập provider thực tế.
4. Kiểm tra capability: session mới, kết quả/error, stream, hủy, resume và chặn delegation. Khả năng thiếu phải hiện rõ, không đoán model IDs hay đổi sang API tính phí.
5. Thử handoff giữa hai session độc lập trên task nhỏ trong phạm vi đã thống nhất. Không cần cùng lúc triển khai tất cả runners hoặc cả sản phẩm.
6. Chốt flow/schema/state và một thử nghiệm Nimbalyst panel nhỏ dựa trên kết quả research. Không mặc định đã được phép triển khai toàn bộ chỉ vì có tài liệu này.

Các chi tiết còn mở: task pilot, provider/model defaults, session reuse, quyền của Verifier, output/check contract, repair/token/time budgets, workspace isolation và lưu trữ run state. Mẫu flow trong kiến trúc là đề xuất, không phải mọi chi tiết đã được người dùng phê duyệt.

## Prompt bàn giao có thể dùng

> Tôi đang tiếp tục NeoMind trên nhánh `hieu/adaptive-agent-flow`. Đọc `docs/adaptive-agent-flow/README.md`, `product-direction.md` và `architecture.md` trước. Chúng ta đang research và thiết kế, chưa triển khai sản phẩm. Tôi muốn hai môi trường Nimbalyst và standalone độc lập, dùng chung flow; Run tự động, chỉ can thiệp khi cần; worker không tự delegation; memory Markdown và lưu feedback; ưu tiên account hiện có, Antigravity đang hoãn. Flow đầu tiên phục vụ phát triển tính năng/sửa lỗi code. Hãy kiểm tra trạng thái local, đọc kết quả probe rồi cùng tôi chọn task pilot và xác minh khả năng SDK/session bằng runtime đã đăng nhập, thay vì giả định các adapter đã hoạt động.

Danh tính Git người dùng đã yêu cầu trong cuộc trao đổi: `Hieu Tran <tranngochieu05102002@gmail.com>`. Khi được yêu cầu commit, dùng danh tính này cho Author và Committer; không tự sửa danh tính các commit của người khác.

## Cách đọc bằng chứng và tài liệu cũ

Quyết định mới trong `product-direction.md` và `architecture.md` được ưu tiên khi khác report lịch sử. Metadata repo, SDK version và nhận xét source chỉ phản ánh lúc khảo sát; pin/recheck trước khi chọn dependency. Việc kiểm tra Markdown không thay thế build, inference, kiểm thử Nimbalyst hay benchmark chất lượng.
