# Định hướng: NeoMind như một con chip — 11/11/2026

Trạng thái: **ý tưởng, đang brainstorm**, chưa duyệt để lập plan. Ghi lại một góc nhìn người dùng nêu ngày 11/11: xây NeoMind ngày càng giống xây công cụ lập trình một con chip — flow là chương trình, các khối là tập lệnh, memory như RAM và Flash. Tài liệu dùng ẩn dụ này làm la bàn thiết kế: một máy tính tử tế có gì mà NeoMind còn thiếu, và con chip này nên được dùng ở đâu.

## 1. Bảng ẩn dụ

| Phần cứng / firmware | NeoMind hiện có |
| --- | --- |
| Chương trình / firmware | Flow |
| Tập lệnh (ISA) | Loại khối: agent task, approval, review, fork/join, repair, commit |
| Assembler + linker | `compileFlow`: kiểm graph, policy, gắn profile và binding |
| Nạp vào Flash, image có checksum | Publish phiên bản flow (bất biến, có hash) |
| CPU core / ISA khác nhau | Runner Codex, Claude Code, OpenCode |
| Xung nhịp / chế độ công suất | Model + mức suy luận |
| Đa nhân | Parallel writers |
| Thư viện ROM | Skills |
| Cấu hình core | Agent (profile) |
| Option bytes / MPU | Policy sàn, `rules.md`, quyền read/write |
| Thanh ghi / RAM | Context của lượt agent (prompt) |
| Flash / EEPROM | `neomind/memory` (lâu dài, ghi phải "verify" bằng duyệt) |
| Copy Flash → RAM lúc boot | Ghim snapshot memory khi tạo run |
| Watchdog | Giới hạn thời gian, ngân sách token, giới hạn lượt của OpenCode |
| Trace buffer (ETM) | Journal + transcript |
| Reset rồi chạy tiếp từ checkpoint | Recovery khi dừng/crash |
| Halt chờ debugger | Cổng duyệt plan |
| Lockstep / safety monitor | Review độc lập, checks |
| Bootloader nhiều giai đoạn | Chương trình nhiều giai đoạn |
| Performance counter | `run stats` |
| Bus ngoại vi | Session tools, MCP |

**Chỗ ẩn dụ gãy — và là lý do NeoMind tồn tại:** CPU thật chạy lệnh tất định; "CPU" của NeoMind chạy lệnh xác suất, cùng một lệnh có thể ra kết quả khác. Vì vậy review và checks không phải phụ kiện mà là phần lõi, giống lockstep và ECC trên chip an toàn.

## 2. Bốn hướng ưu tiên gợi ra từ ẩn dụ

### 2.1 Debugger cho flow + memory map

- **Breakpoint** trên bước: dừng trước bước, xem đúng "thanh ghi" bước sẽ nhận (prompt, skill, rule, memory, plan), sửa rồi cho chạy.
- **Chạy từng bước** thay vì chạy hết.
- **Time-travel:** từ journal mở lại trạng thái ở bước bất kỳ, chạy lại riêng bước đó với cấu hình khác (so model/skill/memory) — tạo run mới, không đổi run cũ.
- **Memory map** (như file `.map` của linker): mỗi bước hiện context bị chiếm bao nhiêu bởi hướng dẫn agent, skill, rule, memory, plan, task — biết vì sao tốn token và chỗ nào phình.

### 2.2 RAM của run và promote sang Flash

- **Scratchpad của run:** các bước ghi chú cho nhau trong một run (planner để lại "file X nhạy cảm" cho reviewer). Ghim vào journal để replay đúng; hết run thì không còn hiệu lực.
- **Promote RAM → Flash:** cuối run, ghi chú đáng giữ thành đề xuất memory (qua duyệt như hiện nay). Tự nhiên hơn việc đoán lesson từ review.
- Hệ phân cấp rõ ràng: thanh ghi (prompt một lượt) → RAM (scratchpad run) → Flash (memory project), mỗi tầng có giới hạn dung lượng hiển thị được.

### 2.3 Chương trình con (CALL/RET)

- Một khối trong flow gọi một flow đã publish khác, như gọi hàm: có đầu vào (task con, phạm vi), đầu ra (kết quả, bằng chứng), và kế thừa policy sàn.
- Dùng lại "Review UI", "Review bảo mật", "Viết test" ở nhiều flow mà không vẽ lại; tăng sức biểu đạt mà không phình số loại khối.

### 2.4 Ngắt (interrupt vector table) = hooks

- Bảng sự kiện → handler: `needs_user`, `review_failed`, `budget_low`, `stalled`, `delivered`…
- Handler là thông báo, chương trình con, hoặc dừng; chạy trong cùng MPU (không bỏ được checks/review, không tự duyệt plan).
- Kèm **watchdog thông minh**: phát hiện "không tiến triển" cho mọi runner (lặp đọc cùng file, không ra kết quả mới) — tổng quát hóa giới hạn 60 lượt của OpenCode.

Hướng khác ghi lại để sau: **simulator** (chạy flow bằng runner giả để thử nhánh và ước tính chi phí trước khi tốn quota), **A/B firmware** (chạy song song hai phiên bản flow, giữ bản có số liệu tốt hơn — tầng 3 của [định hướng 11/2026](direction-2026-11.md)).

## 3. Con chip này dùng vào việc gì? (đang brainstorm)

Liên tưởng tới cách MCU thật được dùng. Mỗi dòng: kiểu dùng MCU → kiểu dùng NeoMind → khối còn thiếu.

| Kiểu MCU | NeoMind tương ứng | Ví dụ | Còn thiếu |
| --- | --- | --- | --- |
| **Bộ điều khiển chuyên dụng** (máy giặt, lò vi sóng: một firmware, chạy mãi) | Flow "đóng chip" cho một việc lặp lại | Review mọi PR, viết release notes, triage issue mới | Kích hoạt bằng sự kiện (ngắt) |
| **Vòng điều khiển** (PID: cảm biến → tính → chấp hành → đo lại) | Flow giữ một chỉ số ở mức mong muốn | Giữ test suite xanh, giữ docs khớp code, nâng dependency tới khi build đạt | Vòng lặp có setpoint + điều kiện dừng ngoài vòng sửa |
| **Data logger / giám sát định kỳ** (RTC đánh thức, đo, ghi, ngủ) | Run chỉ đọc theo lịch | Quét repo hằng đêm tìm TODO, test chập chờn, lỗ hổng; báo cáo | Hẹn giờ (RTC), báo cáo tổng hợp |
| **Thiết bị an toàn** (y tế, ô tô: lockstep, nhật ký, chứng nhận) | Flow có truy vết đầy đủ | IEC 62304 / ISO 14971: yêu cầu → thiết kế → code → test, review độc lập, journal làm audit trail, rule kiểu MISRA | Ma trận truy vết, xuất bằng chứng |
| **Co-processor / accelerator** (CPU chính giao việc nặng) | AI session giao việc "có kỷ luật" cho NeoMind | Session chính gọi `assess` → `start` → nhận kết quả đã review | Đã có; cần kết quả trả về gọn cho host |
| **Fleet + OTA** (cùng firmware trên nghìn thiết bị) | Một flow chạy trên nhiều repo | Đổi API/CI/licence ở 20 repo, mỗi repo một run, tổng hợp | Chạy hàng loạt, dashboard nhiều repo |
| **Hardware-in-the-loop** (thiết bị test điều khiển phần cứng thật) | Checks là phép đo thật | Build firmware → nạp board → đọc UART → agent phân tích → sửa → nạp lại | "Ngoại vi": flasher, serial, máy đo như check/tool |
| **Devkit / giáo dục** (Arduino) | Flow huấn luyện | `leetcode-practice`: gợi ý từng bước, review bài giải, không viết lời giải hộ | Flow hội thoại nhiều lượt với người học |
| **Hệ nhiều MCU trên bus** (CAN, I²C) | Nhiều người/nhiều NeoMind phối hợp | Chương trình nhiều giai đoạn giao giữa các thành viên team | Nhiều người dùng (backlog) |

Câu hỏi để chốt tiếp:

1. Kiểu dùng nào sát nhu cầu thật nhất (công việc firmware/thiết bị y tế, học tập, phát triển chính NeoMind)?
2. Có muốn NeoMind chạy **không cần người bấm** (sự kiện, hẹn giờ) không, hay luôn do người/AI khởi động?
3. Với kiểu "thiết bị an toàn", bằng chứng nào cần xuất ra (ma trận truy vết, báo cáo review, nhật ký)?
