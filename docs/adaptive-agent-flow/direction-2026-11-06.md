# Định hướng nâng cấp NeoMind — 06/11/2026

Bản này cập nhật thứ tự việc của [định hướng tháng 11](direction-2026-11.md) sau buổi brainstorm ngày 06/11. Tầm nhìn ba tầng (kỷ luật → AI điều phối → tự thích ứng) giữ nguyên; thay đổi là **AI được tự dựng flow** và thêm **hooks**, **skills/profile** làm nền cho việc đó. Trạng thái: **đã duyệt 06/11/2026** (bỏ sửa checks Windows và hooks). Plan chi tiết: [plan-upgrade-2026-11-06.md](plan-upgrade-2026-11-06.md).

## Vì sao

Đợt [thiết kế lại giao diện](../design/redesign-plan.md) (05–06/11) được làm thủ công đúng theo cách NeoMind muốn làm: một session điều phối chia 6 giai đoạn, giao từng giai đoạn cho agent khác nhau (Sonnet, Terra) trong worktree riêng, review bằng ảnh chụp, người dùng thử trong panel rồi mới merge, build, cài lại extension, dọn worktree. Những gì session điều phối phải làm tay cho thấy NeoMind còn thiếu gì:

| Việc làm tay | Thiếu trong NeoMind |
| --- | --- |
| Chia giai đoạn, viết brief cho từng agent | AI không tạo được flow; chỉ chọn flow có sẵn (`flows`, `preview`, `start`) |
| Nhắc lại bài học cũ trong brief mới | Phát hiện review không chuyển sang run sau |
| Bắt agent dừng giữa chừng, nhãn tiếng Anh quay lại, màu sai | Reviewer không đối chiếu từng mục plan; không review được giao diện |
| Merge, build, cài extension, gỡ worktree, xóa state tạm (5 lần) | Không có hook; bước giao kết quả chỉ commit local |
| Ngồi canh session con | Không báo khi run cần người |

Người dùng nêu thêm: flow không chỉ do người vẽ tay; **mọi session AI** dùng API của NeoMind để tự tạo, lưu và chọn flow; skills, agents và hooks cần quản lý tốt và hữu ích hơn.

## Quyết định (06/11/2026)

| Câu hỏi | Quyết định |
| --- | --- |
| AI làm gì với flow | **Tạo, publish và chạy tự do**, miễn thỏa policy sàn. Thay nguyên tắc cũ "thay đổi flow do AI đề xuất phải qua người duyệt". |
| Chuẩn skill | Định dạng `SKILL.md` của Claude Code; NeoMind chuyển nội dung cho runner không có skill gốc (Codex) |
| Thứ tự | AI tạo/lưu/chọn flow → skills/profile → chương trình nhiều giai đoạn → rules → chi phí |
| Bỏ khỏi đợt này | Sửa checks sandbox Windows (`WinError 5`) và hooks (giao kết quả tự động, thông báo, review hình ảnh). Ghi lại ở mục "Ngoài đợt này" |

**Rào chắn đi kèm việc AI tự publish** (vì bỏ cổng duyệt người):

- Policy sàn kiểm ở compiler, không ở prompt: có review độc lập nếu project yêu cầu; không tự duyệt plan nếu project không cho phép; không hook nào bỏ qua checks/review; giới hạn thời gian và số vòng sửa có trần.
- Flow do AI tạo ghi `author: ai`, session và lý do; mỗi lần publish là một phiên bản mới (không ghi đè), diff hiện trong Flow Studio, quay về phiên bản cũ một bước.
- Project có thể tắt quyền này: `neomind/project.json` thêm `ai.flowPublish: "allow" | "draft-only" | "deny"` (mặc định `allow` theo quyết định trên).
- Cổng duyệt **plan** của từng run vẫn là của người (trừ flow tự khai báo `approval.mode: auto` và project cho phép), như hiện nay.

## Các bước

### 1. AI tạo, lưu và chọn flow

Tool mới cho session (cùng `RunManager`, mỗi tool một lệnh CLI tương ứng):

| Tool | Làm gì |
| --- | --- |
| `flow_schema`, `flow_blocks` | Cấu trúc flow và các khối có sẵn (loại bước, template, profile, binding) dưới dạng gọn cho AI |
| `flow_get` | Định nghĩa flow (draft/phiên bản) |
| `flow_draft` | Tạo hoặc sửa flow từ spec (hoặc từ template + thay đổi); trả diagnostics của compiler và policy sàn |
| `flow_validate` | Kiểm và trả diff so với phiên bản trước, để AI trình bày cho người |
| `flow_publish` | Publish theo `ai.flowPublish` của project; ghi `author: ai` |
| `assess` | Nhận mô tả task, trả flow nên dùng, lý do, rule/checks nên thêm; ban đầu dựa trên quy tắc đơn giản + lịch sử run (bước 5 bổ sung số liệu) |

Lệnh `/neomind:run` đổi thành vòng: assess → (flow có sẵn hoặc `flow_draft` → `flow_validate` → `flow_publish`) → preview → start → wait → báo kết quả.

**Xong khi:** một session Claude và một session Codex mỗi bên tự dựng một flow mới (vd. "Dev + review hình ảnh"), publish, chạy tới duyệt plan; policy sàn chặn được flow cố bỏ review; Flow Studio hiện diff và tác giả.

### 2. Skills và profile

- **Skills:** quét `.claude/skills/*/SKILL.md` và `neomind/skills/*/SKILL.md`; tự tính hash, không nhập tay; báo lệch khi file đổi sau khi ghim, nút "Ghim lại"; gắn skill vào từng bước trong Flow Studio; Claude Code nhận skill gốc, Codex nhận nội dung trong prompt.
- **Profile (agent):** vai trò + hướng dẫn + skills + quyền + runner/model mặc định; xem nội dung phiên bản cũ và đề nghị chuyển các flow sang phiên bản mới (việc backend đã ghi ở [redesign-plan](../design/redesign-plan.md)); tool `profile_draft` cho AI theo cùng quyền như flow; số liệu theo profile (tỷ lệ review đạt, chi phí) khi có bước 5.

**Xong khi:** thêm một skill vào repo thì nó hiện trong Profiles và gắn được vào bước; run dùng skill đó ở cả Claude và Codex; sửa file skill thì UI báo lệch.

### 3. Chương trình nhiều giai đoạn (A1, A2, A3)

- **Chương trình:** plan có các giai đoạn, mỗi giai đoạn là một run (flow, model, branch riêng); theo dõi thứ tự, phụ thuộc, giai đoạn đã giao; phát hiện review của giai đoạn trước thành lesson cho brief giai đoạn sau (A2).
- **Kiểm đủ phạm vi (A3):** reviewer nhận danh sách mục của plan và chấm từng mục (đã làm / thiếu / lệch), thiếu mục thì `needs_changes`.

Không có hook nên việc đưa kết quả giai đoạn vào branch vẫn do người làm (`apply`/cherry-pick); giai đoạn sau chỉ bắt đầu khi commit của giai đoạn trước đã nằm trong HEAD.

**Xong khi:** một chương trình 3 giai đoạn trên repo thử chạy hết với người chỉ duyệt chương trình, duyệt plan từng giai đoạn và đưa kết quả vào branch.

### 4. Rules (C1)

Như [định hướng tháng 11 §1.1](direction-2026-11.md#11-bộ-rule-của-project): `neomind/rules.md`, reviewer chấm theo từng rule. Rule cũng là một phần của policy sàn khi AI tự dựng flow.

### 5. Chi phí và quota (B3)

Token và ước tính chi phí theo run, flow, profile; ngân sách theo token (không chỉ phút); `run stats`. Đây cũng là số liệu cho `assess` và tầng tự thích ứng.

## Ngoài đợt này

- Sửa checks sandbox Codex trên Windows (`WinError 5` khi tạo cây thư mục tạm; ba hướng xử lý ở [implementation-status](implementation-status.md)).
- Hooks theo mốc của run; giao kết quả tự động (merge, build, cài extension, dọn worktree); thông báo khi run cần người; review hình ảnh bằng ảnh chụp.

## Câu hỏi còn mở (đã chốt trong plan chi tiết)

1. `assess` dùng quy tắc tĩnh + số liệu run, chưa gọi model.
2. Chương trình nhiều giai đoạn là file riêng `neomind/programs/<id>.json` trỏ tới các flow, không phải loại flow mới.
