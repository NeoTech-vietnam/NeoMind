# Repo Plan — NeoMind

> **Tài liệu Kế hoạch Phát triển Repository NeoMind**  
> **Trạng thái tài liệu:** Đề xuất kế hoạch (Draft Plan)  
> **Thời điểm lập:** 24/10/2026  
> **Repository:** `NeoMind` (`NeoTech-vietnam/NeoMind`)  
> **Worktree thực thi:** `H:\Learning\Neo\NeoProject_worktrees\crystal-delta`  
> **Nhánh thực thi:** `docs/repo-plan` (phân nhánh từ commit `c918f03`)  

---

## 1. Mục tiêu và Phạm vi (Goals & Scope)

### 1.1. Mục tiêu cốt lõi
- **Trung tâm tri thức quy trình AI của hệ sinh thái:** `NeoMind` được thiết kế để đóng vai trò là "một nguồn chuẩn" (Single Source of Truth - SSOT) cung cấp toàn bộ quy trình làm việc (AI workflows), kỹ năng tác nhân (agent skills), bộ điều hợp (adapters), khuôn mẫu (templates) và công cụ tái sử dụng cho các dự án trong hệ sinh thái Neo (`NeoProject`).
- **Tránh phân mảnh và sao chép thủ công:** Chuẩn hóa các phương pháp làm việc có sự hỗ trợ của AI (pair programming, research, code review, verification, handover) để các repo con (`NeoKnowledge`, `NeoApps`, `NeoLab`, `NeoPlayground`) có thể áp dụng đồng nhất một phiên bản xác định mà không cần tự phát triển hay chỉnh sửa thủ công các bộ quy tắc riêng rẽ.
- **Tiến hóa có kiểm soát:** Tạo cơ chế kiểm thử, đo lường và nâng cấp các bộ kỹ năng / quy trình theo phiên bản rõ ràng trước khi phổ biến rộng rãi.

### 1.2. Phạm vi đảm nhiệm (In Scope)
1. **Workflows (Quy trình làm việc AI):**
   - Vòng đời tác vụ chuẩn từ nghiên cứu (research), lập kế hoạch (planning), thực thi mã nguồn (implementation), kiểm thử/đánh giá (testing/review) đến đóng gói/bàn giao (handover).
   - Các cổng kiểm soát chất lượng (Quality gates) giữa các pha chuyển tiếp.
2. **Skills (Kỹ năng tác nhân):**
   - Các tác vụ chuyên môn kỹ thuật tái sử dụng: phân tích vi điều khiển, kiểm tra quy chuẩn mã nhúng (Embedded C/C++ style), tạo tài liệu kỹ thuật, quản lý git submodule/worktree, v.v.
3. **Adapters (Bộ điều hợp công cụ & môi trường):**
   - Cơ chế ánh xạ từ một nguồn chuẩn (canonical definition) sang cấu hình của từng công cụ/editor cụ thể: Cursor rules, Claude Desktop/Code commands, Antigravity skills/rules, VS Code tasks/prompts.
4. **Templates (Khuôn mẫu):**
   - Mẫu chỉ dẫn agent (`AGENTS.md`), mẫu mô tả dự án, danh mục kiểm tra an toàn (safety checklists), mẫu báo cáo hoàn thành nhiệm vụ.
5. **Đánh giá và kiểm chuẩn (Evaluation & Testbed):**
   - Bộ ví dụ mẫu đại diện cho đầu vào/đầu ra của từng kỹ năng; kịch bản kiểm tra chất lượng kết quả do AI sinh ra.

### 1.3. Ngoài phạm vi (Out of Scope)
- **Không lưu chính sách đặc thù của dự án con:** Quy định kinh doanh, quy chuẩn mã nguồn riêng biệt, hoặc yêu cầu kỹ thuật đặc thù của từng repo con vẫn thuộc về chính repo sử dụng đó.
- **Không lưu trữ nhật ký công việc (work logs) của sản phẩm:** Các tài liệu theo dõi tiến độ, nhật ký nhiệm vụ, bug tracker của các sản phẩm cụ thể thuộc về repo sản phẩm trong `NeoLab` hoặc `NeoApps`.
- **Không tự viết lại công cụ thượng nguồn (upstream tooling):** Không tự phát triển lại các IDE, framework AI hay language server nếu công cụ upstream đã cung cấp đủ tốt; tập trung vào logic quy trình và kỹ năng chuyên biệt của NeoTech.
- **Không tự ý mở rộng hệ thống đa agent phức tạp:** Tránh việc xây dựng hệ thống điều phối đa agent cồng kềnh khi nhu cầu thực tế chưa đòi hỏi.

---

## 2. Hiện trạng thực tế và Bằng chứng (Current Reality & Evidence)

Mọi ghi nhận dưới đây đều dựa trên kết quả kiểm tra thực tế từ công cụ và mã nguồn, có ưu tiên cao hơn các thông tin lịch sử trong tài liệu thảo luận trước.

### 2.1. Hiện trạng Repository `NeoMind`
- **Địa chỉ remote:**
  - SSH: `git@github.com:NeoTech-vietnam/NeoMind.git`
  - HTTPS: `https://github.com/NeoTech-vietnam/NeoMind.git`
- **Commit ban đầu:** `c918f0396bc37024742c8baae12f3ef2072e5b01` (`Initial commit`).
- **Nội dung tệp tin thực tế:** Chỉ có duy nhất một tệp tin `README.md` với 2 dòng nội dung:
  ```markdown
  # NeoMind
  Shared AI workflows, agent skills, and reusable tooling for Neo projects. Project-specific policies and daily work remain in their owning repositories.
  ```
- **Tình trạng nhánh:**
  - Nhánh chính trên remote: `main`.
  - Nhánh làm việc cho việc lập tài liệu hiện tại: `docs/repo-plan` (được tạo độc lập từ commit `c918f03`).
- **Bằng chứng kiểm tra thực tế:**
  - Đường dẫn tệp tin: [`NeoMind/README.md`](file:///H:/Learning/Neo/NeoProject_worktrees/crystal-delta/NeoMind/README.md#L1-L2)
  - Lệnh kiểm tra: `git ls-files` trong thư mục `NeoMind` cho ra kết quả duy nhất là `README.md`.

### 2.2. Hiện trạng Submodule trong Superproject `NeoProject`
- **Cấu hình submodule:** Được khai báo trong tệp [`.gitmodules`](file:///H:/Learning/Neo/NeoProject_worktrees/crystal-delta/.gitmodules#L10-L12):
  ```ini
  [submodule "NeoMind"]
      path = NeoMind
      url = git@github.com:NeoTech-vietnam/NeoMind.git
  ```
- **Commit được ghim (pinned commit):** `c918f0396bc37024742c8baae12f3ef2072e5b01` (khởi tạo tại commit `f325059` của NeoProject).
- **Lịch sử cập nhật giao thức:** Trong tệp [NeoProject.canvas](file:///H:/Learning/Neo/NeoProject_worktrees/crystal-delta/docs/NeoProject.canvas), một số node lịch sử (`setup-pins`, `mind`) ghi nhận URL dạng HTTPS. Tuy nhiên, quan sát thực tế trong git log của superproject cho thấy tại commit `501e68b fix: update submodule URLs to use SSH instead of HTTPS`, URL của submodule đã được chuyển dứt khoát sang SSH. Hiện trạng git thực tế này có độ ưu tiên cao hơn văn bản canvas cũ.
- **Tình trạng worktree phiên làm việc:**
  - Phiên làm việc chạy trên worktree độc lập `crystal-delta` tại đường dẫn `H:\Learning\Neo\NeoProject_worktrees\crystal-delta`.
  - Không có bất kỳ thay đổi nào tác động trực tiếp vào thư mục gốc `H:\Learning\Neo\NeoProject`.

### 2.3. Tình trạng kế thừa và liên kết bên ngoài
- **NeoMindv1:** Repository [NeoMindv1](https://github.com/NeoTech-vietnam/NeoMindv1) hiện vẫn là một repo độc lập riêng biệt trên GitHub NeoTech-vietnam. Toàn bộ nội dung của NeoMindv1 vẫn được giữ nguyên và chưa thực hiện bất kỳ đợt di chuyển (migration) nào vào `NeoMind`.
- **Hệ thống đánh giá / kiểm định:** Chưa có bất kỳ cấu hình hay quy trình nghiệm thu nào được tích hợp với `VeryThinker` hoặc `Trellis`.

---

## 3. Cấu trúc thư mục sắp tới đề xuất (Proposed Directory Structure)

Cấu trúc dưới đây được đề xuất theo nguyên tắc: **Một nguồn chuẩn (Canonical Source) độc lập với công cụ** và **các bản chuyển đổi (Generated/Targeted Adapters) cho từng môi trường**.

> *Lưu ý: Cấu trúc dưới đây là đề xuất quy hoạch cho các giai đoạn tiếp theo. Tuyệt đối không tạo sẵn các thư mục rỗng trong phiên làm việc này.*

```text
NeoMind/
├── .gitignore
├── README.md                           # [Đã có] Giới thiệu tổng quan repo
├── docs/                               # [Đề xuất] Tài liệu kiến trúc và hướng dẫn
│   ├── Repo Plan.md                    # [Tạo trong phiên này] Kế hoạch phát triển chi tiết
│   ├── Architecture.md                 # [Đề xuất] Kiến trúc hệ thống skill & adapter
│   └── Guides/                         # [Đề xuất] Hướng dẫn tích hợp cho repo mới
│       ├── Getting-Started.md
│       ├── How-to-Author-Skills.md
│       └── Adapter-Generation.md
├── workflows/                          # [Đề xuất] Định nghĩa quy trình cốt lõi (Nguồn chuẩn)
│   ├── core/
│   │   ├── task-lifecycle.md           # Vòng đời chuẩn: Research -> Plan -> Implement -> Verify -> Handover
│   │   ├── research-phase.md           # Hướng dẫn thu thập ngữ cảnh & khảo sát
│   │   ├── planning-phase.md           # Tiêu chuẩn lập kế hoạch & duyệt gate
│   │   ├── implementation-phase.md     # Quy ước code & refactor
│   │   └── verification-phase.md       # Tiêu chuẩn kiểm thử, tự kiểm chứng
│   └── domain-specific/
│       ├── embedded-development.md     # Quy trình cho firmware, RTOS, driver
│       └── technical-writing.md        # Quy trình viết tài liệu và ghi chú học tập
├── skills/                             # [Đề xuất] Danh mục kỹ năng tác nhân (Canonical Markdown/YAML)
│   ├── code/
│   │   ├── c-cpp-guidelines/           # Kỹ năng định dạng & quy chuẩn mã C/C++
│   │   └── git-workflow-expert/        # Kỹ năng quản lý git worktree, submodule
│   ├── analysis/
│   │   ├── schematic-review-helper/    # Kỹ năng hỗ trợ rà soát sơ đồ phần cứng
│   │   └── bug-root-cause-analysis/    # Kỹ năng tìm nguyên nhân gốc rễ lỗi
│   └── docs/
│       └── markdown-doc-generator/     # Kỹ năng sinh tài liệu kỹ thuật chuẩn Neo
├── adapters/                           # [Đề xuất] Bộ chuyển đổi cho các IDE/Agent
│   ├── antigravity/                    # Cấu hình & rule cho Antigravity / Gemini CLI
│   ├── cursor/                         # Quy tắc xuất khẩu ra .cursorrules
│   ├── claude/                         # Cấu hình MCP & prompts cho Claude Code/Desktop
│   └── vscode/                         # Tác vụ & templates cho VS Code
├── templates/                          # [Đề xuất] Khuôn mẫu văn bản và cấu hình dự án
│   ├── AGENTS.md.template              # Mẫu tệp chỉ dẫn tác nhân cho các repo con
│   ├── PULL_REQUEST_TEMPLATE.md
│   └── HANDOVER_CHECKLIST.md
└── evaluation/                         # [Đề xuất] Bộ dữ liệu kiểm thử và đánh giá skill
    ├── test-cases/                     # Dữ liệu thử nghiệm đầu vào
    └── expected-outputs/               # Kết quả mẫu đạt tiêu chuẩn
```

### Trách nhiệm và Nguồn chuẩn (Single Source of Truth)
- **Nguồn chuẩn (Canonical SSOT):** Toàn bộ nội dung quy trình và kỹ năng được lưu trữ dưới dạng Markdown/YAML trung lập tại `workflows/` và `skills/`. Đây là nơi duy nhất con người và AI trực tiếp biên soạn logic.
- **Bản phái sinh (Adapters):** Thư mục `adapters/` chứa các tệp chuyển đổi hoặc công cụ sinh tự động nhằm đưa các kỹ năng từ nguồn chuẩn vào định dạng riêng của từng công cụ mà lập trình viên sử dụng.
- **Quy tắc bảo trì:** Không chỉnh sửa trực tiếp trên tệp adapter của từng editor; mọi thay đổi phải bắt đầu từ bản gốc tại `workflows/` hoặc `skills/`.

---

## 4. Lộ trình Triển khai (Roadmap)

Lộ trình được chia làm 3 giai đoạn rõ rệt, bám sát định hướng từ tài liệu quy hoạch kiến trúc.

### 4.1. Giai đoạn đầu: Một nguồn chuẩn (Early Phase · Single Source of Truth)
*Mục tiêu:* Thiết lập nền tảng quy trình chuẩn và cung cấp tài liệu hướng dẫn giúp một dự án Neo mới có thể tích hợp ngay mà không cần sao chép thủ công.

- **Nhiệm vụ chính:**
  1. Kiểm kê (Inventory) toàn bộ các workflow, prompts, agent skills hiện có từ quá trình thực chiến và trong repo [NeoMindv1](https://github.com/NeoTech-vietnam/NeoMindv1).
  2. Xác định và chốt vòng đời tác vụ chính (`core task lifecycle`): quy định rõ 5 pha (Nghiên cứu -> Lập kế hoạch -> Triển khai -> Kiểm chứng -> Bàn giao) cùng các tiêu chí nghiệm thu (acceptance criteria) ở từng bước.
  3. Làm rõ vị trí và vai trò của `Trellis` và `VeryThinker` trong chu trình phát triển (xem chi tiết tại Mục 6).
  4. Xác định định dạng chuẩn cho bản gốc (`skills/`, `workflows/`) và xây dựng cơ chế chuyển đổi sang adapter đầu tiên (ưu tiên công cụ đang dùng trực tiếp).
  5. Soạn thảo hướng dẫn chi tiết về việc cài đặt, cập nhật phiên bản và gỡ bỏ bộ quy trình trong một repository con.
- **Đầu ra cụ thể (Deliverables):**
  - Tài liệu vòng đời tác vụ chuẩn `task-lifecycle.md`.
  - Bộ template mẫu `AGENTS.md.template` và `HANDOVER_CHECKLIST.md`.
  - Hướng dẫn tích hợp cho dự án mới `Guides/Getting-Started.md`.
- **Tiêu chí hoàn thành (Exit Criteria):**
  - Một repository mới (hoặc một repo con như `NeoPlayground`) có thể áp dụng bộ quy trình và template mà không gặp xung đột hay phải chỉnh sửa thủ công nhiều nơi.

### 4.2. Giai đoạn mở rộng: Tái sử dụng có kiểm soát (Expansion Phase · Controlled Reuse)
*Mục tiêu:* Đóng gói kỹ năng theo từng lĩnh vực chuyên môn, thiết lập hệ thống phiên bản và kiểm chuẩn độ tin cậy.

- **Nhiệm vụ chính:**
  1. Phân nhóm và đóng gói các bộ skill theo nhu cầu thực tế:
     - Nhóm tài liệu & sư phạm (phục vụ `NeoKnowledge`).
     - Nhóm nhúng & phần cứng (phục vụ `NeoLab`, `NeoPlayground`).
     - Nhóm ứng dụng & giao diện (phục vụ `NeoApps`).
  2. Gắn nhãn phiên bản (Semantic Versioning) cho từng gói quy trình và adapter.
  3. Xây dựng bộ ca kiểm thử (`evaluation/test-cases/`) gồm các câu hỏi, ngữ cảnh mẫu và kết quả kỳ vọng để kiểm tra tính ổn định của skill khi đổi model hoặc prompt.
  4. Thực hiện thử nghiệm cập nhật workflow trên một dự án mẫu (pilot project) trước khi đồng bộ sang toàn bộ các repo trong tổ chức.
- **Đầu ra cụ thể (Deliverables):**
  - Các gói skill chuyên biệt được gán phiên bản rõ ràng kèm `CHANGELOG.md`.
  - Bộ kịch bản kiểm tra chất lượng skill (`evaluation/`).
- **Tiêu chí hoàn thành (Exit Criteria):**
  - Theo dõi và xác định được chính xác repo nào trong tổ chức đang sử dụng phiên bản workflow/skill nào; việc nâng cấp phiên bản không làm thay đổi hành vi bất ngờ của các repo đang chạy ổn định.

### 4.3. Giai đoạn dài hạn: Đo hiệu quả thực tế (Long-term Phase · Real-world Feedback)
*Mục tiêu:* Tự động hóa cập nhật và cải tiến quy trình dựa trên dữ liệu hoạt động thực tế.

- **Nhiệm vụ chính:**
  1. Thiết lập cơ chế ghi nhận và phân tích các trường hợp tác vụ thất bại, tác vụ cần con người can thiệp sửa chữa nhiều lần để phát hiện điểm yếu của quy trình.
  2. Tinh chỉnh và cập nhật các kỹ năng dựa trên các tình huống lỗi thực tế (case-based fine-tuning / iterative prompt optimization).
  3. Tự động hóa quy trình phân phối và thông báo cập nhật khi có bản phát hành mới của `NeoMind`.
  4. Đánh giá nhu cầu phối hợp đa tác nhân phức tạp; chỉ triển khai khi quy trình đơn tác nhân thực sự không đáp ứng được yêu cầu.
- **Đầu ra cụ thể (Deliverables):**
  - Báo cáo định kỳ về hiệu quả sử dụng AI và các lỗi quy trình thường gặp.
  - Công cụ/script tự động kiểm tra và thông báo phiên bản tương thích cho các repo con.
- **Tiêu chí hoàn thành (Exit Criteria):**
  - Bộ kỹ năng có khả năng tự tiến hóa từ các lỗi thực tế, giảm thiểu tối đa sự phụ thuộc vào việc cấu hình thủ công của kỹ sư.

---

## 5. Phụ thuộc và Ranh giới với các Repository khác (Dependencies & Boundaries)

### 5.1. Ranh giới kiến trúc
| Repository | Vai trò & Trách nhiệm | Ranh giới với `NeoMind` |
| :--- | :--- | :--- |
| **`NeoMind`** | Cung cấp phương pháp làm việc, quy trình chuẩn, kỹ năng AI, adapter công cụ. | **Không** chứa code sản phẩm, không chứa dữ liệu bài học, không quản lý lịch sử task riêng của từng dự án. |
| **`NeoKnowledge`** | Lưu trữ tài liệu học tập, lý thuyết, sơ đồ kiến thức. | Nhận workflow viết tài liệu và kiểm tra logic từ `NeoMind`. Nội dung bài học và tổ chức thư mục do `NeoKnowledge` tự quyết định. |
| **`NeoPlayground`** | Lưu trữ mã nguồn ví dụ chạy được độc lập (ESP32, STM32, Linux,...). | Nhận quy chuẩn kiểm tra tính tái lập (reproducibility) từ `NeoMind`. Mã nguồn, cấu hình toolchain và build system do `NeoPlayground` quản lý. |
| **`NeoLab`** | Nghiên cứu và phát triển sản phẩm hoàn chỉnh (Hardware, Firmware, Concept). | Nhận workflow nghiên cứu, review sơ đồ mạch, checklist bàn giao từ `NeoMind`. Mọi tệp thiết kế, schematic, PCB, firmware thuộc về `NeoLab`. |
| **`NeoApps`** | Ứng dụng đầu mối người dùng cuối (Web, Mobile, Companion apps). | Nhận quy trình phát triển phần mềm chuẩn từ `NeoMind`. Kiến trúc app, UI/UX, mã nguồn ứng dụng thuộc về `NeoApps`. |
| **`NeoProject`** | Superproject quản lý submodule và khóa commit stable. | Khóa commit stable của `NeoMind`. Không can thiệp vào các commit trung gian khi `NeoMind` đang phát triển trên branch riêng. |

### 5.2. Nguyên tắc quan hệ tham chiếu
- Quan hệ giữa `NeoMind` và các repo khác là **quan hệ sử dụng và tham chiếu quy trình**, tuyệt đối không phải quan hệ phụ thuộc lồng ghép thư mục (không khuyến nghị lồng submodule vào submodule).
- Khi một repo con cần sử dụng công cụ từ `NeoMind`, repo đó sẽ sử dụng tệp cấu hình sinh ra từ adapter của `NeoMind` hoặc tham chiếu theo thẻ phiên bản (release tag) ổn định.

---

## 6. Quyết định còn mở và Bước tiếp theo (Open Decisions & Next Steps)

### 6.1. Phân loại tình trạng hiện tại
Để đảm bảo tính minh bạch trong quá trình lập kế hoạch, các nội dung được phân định rõ ràng như sau:

- **[ĐÃ CÓ]**:
  - Repository `NeoMind` đã được tạo và khởi tạo submodule trực tiếp tại đường dẫn `NeoMind/` trong `NeoProject`.
  - Tệp [README.md](file:///H:/Learning/Neo/NeoProject_worktrees/crystal-delta/NeoMind/README.md) ban đầu xác định định hướng cơ bản.
  - Cấu hình submodule đã sử dụng giao thức SSH thống nhất trên toàn superproject.
  - Repository [NeoMindv1](https://github.com/NeoTech-vietnam/NeoMindv1) đang tồn tại độc lập trên GitHub.
- **[ĐÃ CHỐT]**:
  - `NeoProject` chỉ quản lý 5 submodule trực tiếp cấp cao nhất (`NeoMind`, `NeoKnowledge`, `NeoApps`, `NeoLab`, `NeoPlayground`).
  - Mỗi repo con phát triển hoàn toàn độc lập trên nhánh riêng; superproject chỉ cập nhật gitlink khi có commit stable được chọn.
  - `NeoMind` là nơi lưu trữ duy nhất các quy trình và kỹ năng dùng chung; không để các repo con tự phát triển các bản rẽ nhánh gây lệch chuẩn.
- **[ĐỀ XUẤT]**:
  - Cấu trúc cây thư mục gồm 6 nhóm: `docs/`, `workflows/`, `skills/`, `adapters/`, `templates/`, `evaluation/`.
  - Chu kỳ phát triển 3 giai đoạn: Một nguồn chuẩn -> Tái sử dụng có kiểm soát -> Đo hiệu quả thực tế.
  - Cơ chế tạo adapter sinh tự động từ nguồn chuẩn Canonical Markdown/YAML.

### 6.2. Các quyết định còn mở cần làm rõ (Open Decisions)
1. **Làm rõ vai trò của Trellis và VeryThinker:**
   - *Vấn đề:* Trong các ghi chú thảo luận trước, `Trellis` và `VeryThinker` được nhắc đến nhưng chưa được định vị rõ ràng trong chu trình làm việc. Chưa có quy trình nghiệm thu qua `VeryThinker`.
   - *Phương án cần chọn:*
     - Phương án A: `VeryThinker` đóng vai trò là công cụ kiểm định/thẩm định chất lượng độc lập (quality inspector) ở cổng kiểm soát (gate) cuối cùng trước khi một tác vụ được coi là hoàn thành.
     - Phương án B: `Trellis` là framework điều phối tác vụ (task orchestration), còn `VeryThinker` là bộ đánh giá logic.
     - Phương án C: Tạm thời coi `Trellis` và `VeryThinker` là các công cụ tham chiếu thử nghiệm; ưu tiên hoàn thiện quy trình đơn giản, gọn nhẹ trước.
2. **Kế thừa từ `NeoMindv1`:**
   - *Vấn đề:* Có chuyển giao toàn bộ lịch sử git hay chỉ trích xuất các workflow, rules và prompts có giá trị sang `NeoMind`?
   - *Đề xuất:* Chọn lọc các prompt và quy tắc đã được kiểm chứng từ `NeoMindv1`, viết lại theo định dạng chuẩn mới của `NeoMind`, không sao chép nguyên trạng các tệp tin lỗi thời.
3. **Lựa chọn định dạng nguồn chuẩn cho Skills (Canonical Schema):**
   - *Vấn đề:* Định dạng nào tối ưu để con người dễ đọc hiểu, AI dễ tuân thủ và dễ viết script chuyển đổi sang các editor khác?
   - *Đề xuất:* Dùng Markdown kết hợp Frontmatter (YAML header) quy chuẩn (tương tự định dạng Skill của Antigravity/Agentic Frameworks).
4. **Mức độ ưu tiên cho các Adapters ban đầu:**
   - *Vấn đề:* Nên tập trung hoàn thiện adapter cho công cụ nào trước tiên?
   - *Đề xuất:* Ưu tiên adapter cho môi trường Antigravity / Gemini CLI và Cursor rules trước vì đây là hai môi trường làm việc chính hiện tại của đội ngũ kỹ sư.

### 6.3. Các bước tiếp theo (Next Steps)
1. **Trình duyệt kế hoạch:** Đệ trình tài liệu `NeoMind/docs/Repo Plan.md` này lên phiên điều phối chính để lấy phản hồi và chốt các điểm còn mở.
2. **Thảo luận kỹ thuật:** Tổ chức phiên làm rõ về vai trò cụ thể của `Trellis` và `VeryThinker` cũng như kế hoạch sàng lọc nội dung từ `NeoMindv1`.
3. **Khởi tạo quy chuẩn kỹ năng (sau khi duyệt plan):** Soạn thảo tài liệu đặc tả chuẩn cho định dạng skill tại `NeoMind/docs/Architecture.md` trên nhánh `docs/repo-plan`.
4. **Tích hợp thử nghiệm:** Thử nghiệm áp dụng template đầu tiên cho một repository trong nhóm (ví dụ: `NeoPlayground`).
