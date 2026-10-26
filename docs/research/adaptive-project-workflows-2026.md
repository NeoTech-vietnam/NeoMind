# Nghiên cứu ý tưởng: workflow thích ứng và memory theo project cho NeoMind

- Ngày tổng hợp: **26/10/2026**.
- Trạng thái: **đề xuất nghiên cứu**, chưa phải đặc tả đã phê duyệt hay kế hoạch triển khai đã chốt.
- Baseline NeoMind đã khảo sát: nhánh `test/thach-workflow`, commit `1dba185`.
- Phạm vi: tổng hợp trao đổi về workflow tùy biến, agents/skills theo project, SQLite memory, benchmark, lựa chọn workflow và cải thiện qua lịch sử chạy.
- Mức bằng chứng: đọc tài liệu/source và metadata GitHub; **chưa cài đặt, chạy thử hoặc benchmark các hệ thống bên ngoài**.

## 1. Mục tiêu và kết luận nghiên cứu

Hướng phát triển mong muốn là biến NeoMind từ một quy trình điều phối được định nghĩa sẵn thành nền tảng cho phép thiết kế, lưu, chọn, thực thi và đánh giá nhiều workflow khác nhau.

Người dùng có thể tạo workflow bằng file thiết kế hoặc giao diện kéo thả; lưu thành các phiên bản; gắn chúng với nhóm công việc; và chọn mức đầu tư phù hợp với loại task, độ quan trọng, deadline, ngân sách và yêu cầu độ chính xác. Mỗi project có agents, skills, workflows và memory riêng, kế thừa những thành phần dùng chung khi phù hợp.

Các nguyên tắc quan trọng:

1. **Level cao hơn biểu thị ngân sách và mức kiểm soát cao hơn.** Chất lượng tốt hơn cần được đo, không được suy ra từ số agent hay số bước.
2. **Agent xử lý chuyên môn; runtime quản lý luật và trạng thái.** Một agent báo hoàn thành chưa đủ để workflow được nghiệm thu.
3. **Workflow là dữ liệu có phiên bản.** Bản thiết kế, một lần chạy và bằng chứng thực thi là các đối tượng khác nhau.
4. **Memory được truy vấn theo nhu cầu.** Mỗi agent nhận context liên quan trong giới hạn dung lượng, thay vì toàn bộ lịch sử project.
5. **Cải thiện tạo ra phiên bản ứng viên.** Chỉ đưa bản mới vào dùng sau đánh giá, kiểm tra hồi quy và quyết định áp dụng phù hợp.

## 2. Nền tảng hiện tại và khoảng trống

Theo [hướng dẫn controlled workflow](../controlled-workflows.md) và [hướng dẫn runtime](../../resources/guides/controlled-workflows.md), NeoMind hiện đã có những thành phần hữu ích:

- Coordinator lập kế hoạch, Implementer thực hiện, Verifier kiểm chứng độc lập; Reviewer và chuyên gia tham gia theo nhu cầu/rủi ro.
- Contract xác định đầu vào, đầu ra, phạm vi sửa, file phải giữ nguyên, lệnh kiểm tra và điều kiện nghiệm thu.
- Bằng chứng gắn với baseline; kiểm tra độ mới của kết quả và tách trách nhiệm implementation/checker.
- Checkpoint, pause/resume/cancel, phân loại lỗi và giới hạn sửa lỗi.
- CLI/MCP, VS Code Model Bridge, giao diện theo dõi và các cơ chế knowledge/procedure reuse.

Controlled workflow hiện mô tả một vòng đời chủ yếu quanh lập kế hoạch, thực hiện, kiểm chứng, báo cáo và review. Bước tiếp theo là tổng quát hóa việc chuyển stage thành thực thi một graph được định nghĩa và kiểm tra hợp lệ.

Các điểm cần xây hoặc xác minh thêm:

- Schema graph chung và editor kéo thả dùng cùng schema.
- Registry workflow, versioning và bộ chọn workflow.
- Cấu hình kế thừa agents/skills theo project.
- Hợp đồng memory thống nhất, truy xuất theo vai trò và kiểm tra độ còn hiệu lực.
- Benchmark so sánh flow, kể cả baseline chỉ dùng skills.
- Chu trình đề xuất, đánh giá và áp dụng cải tiến.

Chưa chạy test trên baseline này trong đợt nghiên cứu. Việc có source và test files không chứng minh workflow thực tế đã chạy thành công qua VS Code/model provider.

## 3. So sánh với giao việc chỉ dùng skills

Skills cung cấp hướng dẫn chuyên môn và quy trình để agent thực hiện. Runtime bổ sung việc kiểm tra và cưỡng chế các điều kiện mà hướng dẫn bằng văn bản tự nó không bảo đảm.

| Tiêu chí | Giao việc bằng skills | Workflow do runtime điều phối |
| --- | --- | --- |
| Setup và chi phí | Ít thành phần, phù hợp việc nhỏ | Nhiều cấu hình, lượt model và trạng thái hơn |
| Linh hoạt khám phá | Dễ đổi hướng theo hội thoại | Cần cập nhật hoặc điều chỉnh contract hợp lệ |
| Phân vai | Có thể mô tả bằng instructions | Có thể ràng buộc phiên, quyền và đầu ra riêng |
| Kiểm chứng | Phụ thuộc agent và tool hiện có | Có gate, bằng chứng và kiểm tra độc lập |
| Tiếp tục sau gián đoạn | Hội thoại, ghi chú, Git | Checkpoint và trạng thái thực thi có cấu trúc |
| Truy vết | Cần tự tổ chức | Có thể chuẩn hóa theo từng lần chạy |

Rủi ro của multi-agent gồm chi phí điều phối, kế hoạch sai lan truyền, nhiều agent cùng bỏ sót một lỗi và lỗi hạ tầng ngoài lỗi sản phẩm. Các phiên riêng dùng cùng model chưa bảo đảm độc lập về suy nghĩ.

Định hướng: skills tiếp tục là thành phần cơ bản; chọn workflow có kiểm soát khi lợi ích kiểm chứng và truy vết xứng đáng với chi phí.

## 4. Kiến trúc đề xuất

```text
Yêu cầu người dùng + chính sách project
                    |
           Phân loại và chọn workflow
                    |
     Registry: bản thiết kế có phiên bản
                    |
       Runtime thực thi graph và contract
          /          |           \
       Agents     Tools/checks    Memory truy vấn
                    |
       Artifacts + bằng chứng + telemetry
                    |
       Đánh giá kết quả và đề xuất cải tiến
                    |
      Workflow/skill ứng viên -> benchmark
```

Các lớp nên có ranh giới rõ:

- **Designer/registry:** soạn, kiểm tra, lưu và phân phối định nghĩa.
- **Selector:** chọn flow theo yêu cầu, chính sách và dữ liệu đánh giá.
- **Runtime:** thực thi, giới hạn quyền/ngân sách, lưu trạng thái, phục hồi và nghiệm thu.
- **Project configuration:** ánh xạ agents, skills, toolchain và workflows vào project cụ thể.
- **Memory service:** lưu và truy xuất thông tin có nguồn/phạm vi.
- **Evaluation/improvement:** so sánh kết quả, sinh ứng viên và quyết định nâng phiên bản.

### 4.1. Workflow design và execution instance

Một định nghĩa workflow nên mô tả:

- ID, version, loại task, level và phiên bản schema.
- Node agent, chạy tool/test, điều kiện, song song, tổng hợp và chờ đánh giá của con người.
- Edges, điều kiện rẽ nhánh, hợp đồng đầu vào/đầu ra và điều kiện dừng.
- Agent/skill/model bindings, quyền đọc/ghi và phạm vi tool.
- Giới hạn thời gian, chi phí, concurrency, retry và repair.
- Tiêu chí nghiệm thu và các bước kiểm chứng bắt buộc.

Ví dụ minh họa, **không phải cấu hình hiện đã được NeoMind hỗ trợ**:

```yaml
id: software-change
version: 1
level: 3
nodes:
  - id: plan
    agent: project/planner
  - id: implement
    agent: project/developer
  - id: verify
    agent: core/verifier
edges:
  - { from: plan, to: implement }
  - { from: implement, to: verify }
limits:
  max_repair_attempts: 2
  max_parallel_agents: 2
acceptance:
  - required_checks_pass
  - independent_verification_pass
```

Một execution instance phải giữ bản định nghĩa đã chọn và các phiên bản bindings. Sửa template không tự đổi instance đang chạy. Nếu hỗ trợ sửa graph khi chạy, thay đổi cần được kiểm tra quyền, dependency, bằng chứng đã có và lưu thành revision mới của execution contract.

### 4.2. Level 1–5

| Level | Cấu trúc tham khảo | Loại việc |
| --- | --- | --- |
| 1 | Một agent + skills + kiểm tra cơ bản | Chỉnh sửa nhỏ, dễ hoàn tác |
| 2 | Implementer + executable checks | Thay đổi thông thường, tiêu chí rõ |
| 3 | Planner + Implementer + Verifier độc lập | Tính năng có nhiều yêu cầu |
| 4 | Thêm nghiên cứu/chuyên gia/review | Nhiều thành phần hoặc rủi ro cao |
| 5 | Nhiều phương án, đánh giá độc lập, phê duyệt cần thiết | Công việc quan trọng, ngân sách kiểm chứng lớn |

Đây là các cấu hình khởi đầu, không phải một thang chất lượng đã đo. Workflow nghiên cứu, nội dung học tập và firmware có thể có cấu trúc khác nhau dù cùng level.

### 4.3. Lựa chọn và nâng mức workflow

Đầu vào của selector gồm loại task, phạm vi, khả năng kiểm tra, rủi ro, deadline, ngân sách và độ tin cậy yêu cầu. Bắt đầu bằng luật có thể giải thích; chỉ học bộ chọn khi đã có đủ dữ liệu đại diện.

Mục tiêu đề xuất: chọn workflow có chi phí dự kiến thấp nhất nhưng vẫn đạt ngưỡng chất lượng và rủi ro. Cho phép nâng mức khi xuất hiện lỗi hoặc phạm vi phức tạp hơn, trong ngân sách được phép. Nếu không có flow đáp ứng ràng buộc thì báo rõ sự thiếu hụt, thay vì tự hạ điều kiện nghiệm thu.

## 5. Agents, skills và workflows theo project

| Thành phần | Tầng dùng chung | Tầng project |
| --- | --- | --- |
| Agents | Planner, Developer, Verifier, Reviewer | Chuyên gia firmware, biên tập kiến thức, chuyên gia ứng dụng |
| Skills | Git, nghiên cứu, kiểm thử, lập kế hoạch | Build riêng, coding standards, mẫu bài học, ràng buộc thiết bị |
| Workflows | Các flow mẫu | Flow đã điều chỉnh cho loại task của project |
| Memory | Kiến thức tái sử dụng đã duyệt | Bối cảnh, quyết định, kinh nghiệm và lịch sử riêng |

Agent project có thể kế thừa vai chung rồi bổ sung skills, kiến thức và giới hạn. Cần quy tắc rõ về thứ tự cấu hình và xung đột; override không được âm thầm mở rộng quyền đã bị chính sách project giới hạn.

Các thành phần dùng chung nên được tham chiếu theo version/hash. Cập nhật tạo đề xuất để project thử nghiệm trước khi áp dụng. Cùng một workflow version có bindings khác nhau cần được phân biệt trong kết quả benchmark.

Setup project đề xuất:

1. Kiểm tra source, manifests, instructions, toolchain và quy trình hiện có.
2. Đề xuất project pack phù hợp; phân biệt quan sát, suy đoán và lựa chọn đã xác nhận.
3. Lưu agents/skills/workflows và các bindings được chọn.
4. Khởi tạo memory, lập chỉ mục có chọn lọc và kiểm tra truy xuất.
5. Chạy smoke task đại diện; ghi nhận capability nào thực sự hoạt động.

Ví dụ ứng dụng: NeoApps ưu tiên flow phát triển tính năng; NeoPlayground ưu tiên ví dụ/bài tập chạy được; NeoKnowledge ưu tiên nguồn và chất lượng nội dung; NeoLab cần phân biệt kiểm chứng build/mô phỏng với kiểm chứng trên thiết bị thật.

## 6. SQLite memory cho từng project

### 6.1. Mục tiêu và mô hình lưu trữ

Yêu cầu mong muốn là một bộ nhớ riêng cho mỗi project, truy xuất nhanh và giảm việc nạp toàn bộ memory. SQLite là phương án triển khai; hiệu quả phụ thuộc schema, truy vấn, freshness và cách phân bổ context.

Cấu trúc minh họa:

```text
.neomind/
  project.yaml
  agents/
  skills/
  workflows/
  memory/
    memory.sqlite
```

Đường dẫn trên là đề xuất. Cần kiểm tra tương thích với storage hiện tại trước khi triển khai. [Nghiên cứu nền tảng hiện có](../research.md) từng chọn Markdown/YAML làm nguồn chuẩn và SQLite làm index có thể dựng lại. Vì vậy, chuyển SQLite thành nguồn chuẩn cho memory là **một quyết định kiến trúc cần đánh giá**, không thể coi là đã chốt.

Phương án nên khảo sát: SQLite lưu memory có cấu trúc và phục vụ truy vấn; source, artifacts và bằng chứng bất biến vẫn nằm ở kho phù hợp, được tham chiếu bằng ID/hash. Xác định rõ bảng nào là dữ liệu gốc, bảng nào là projection có thể dựng lại.

### 6.2. Nhóm dữ liệu

- **Project facts:** cấu trúc, công nghệ, lệnh build/test và ràng buộc.
- **Decisions:** lựa chọn, lý do, phạm vi và quyết định thay thế.
- **Observations/lessons:** kinh nghiệm và điều kiện áp dụng, tách xác minh khỏi suy đoán.
- **Run history:** workflow version, bindings, trạng thái, chi phí và kết quả.
- **Evidence references:** vị trí, hash, baseline và check đã tạo bằng chứng.
- **Checkpoints:** trạng thái cần để tiếp tục sau gián đoạn.

Các trường chung nên gồm ID, project ID, loại dữ liệu, nguồn, thời gian, phạm vi, trạng thái xác minh và liên kết supersedes. Với thông tin phụ thuộc code, thêm commit/file hash và điều kiện hết hiệu lực.

### 6.3. Truy xuất và ghi nhớ

```text
Task + vai trò + baseline
          -> lọc project/quyền/độ còn hiệu lực
          -> SQLite FTS5
          -> xếp hạng và giới hạn context
          -> tóm tắt ngắn + ID/nguồn để đọc sâu
```

Planner cần kiến trúc và quyết định; Implementer cần interfaces, conventions và phần code liên quan; Verifier cần tiêu chí, check contracts và lỗi cũ. Bắt đầu bằng FTS5; chỉ bổ sung vector retrieval khi benchmark chứng minh ích lợi.

Sau mỗi lần chạy, đề xuất memory đáng lưu, kiểm tra trùng/mâu thuẫn, gắn nguồn rồi cập nhật. Tránh lưu mọi câu hội thoại hoặc tự nâng nhận xét của agent thành sự thật. Kiến thức riêng chỉ được đưa lên tầng dùng chung sau bước đánh giá và loại bỏ thông tin riêng.

SQLite không tự ngăn việc đọc toàn bộ memory: API cần giới hạn kết quả, phân trang, bộ lọc và context budget. Cũng cần thiết kế transaction/concurrency, migration, backup/restore và kiểm tra project identity khi nhiều agent cùng làm việc.

## 7. Benchmark và đo hiệu quả

So sánh ít nhất các baseline: một agent dùng skills; flow đơn giản có checks; flow có Verifier độc lập; flow nhiều chuyên gia. Dùng cùng yêu cầu và tiêu chí nghiệm thu.

| Nhóm đo | Chỉ số đề xuất |
| --- | --- |
| Chất lượng | Tỷ lệ đạt, lỗi còn sót, độ nghiêm trọng, đánh giá nội dung |
| Hiệu suất | Thời gian tới kết quả được chấp nhận, token, chi phí model/tool |
| Vận hành | Số vòng sửa, số lần can thiệp, tỷ lệ khôi phục sau gián đoạn |
| Phạm vi | File bảo vệ bị thay đổi, vi phạm quyền, thay đổi ngoài yêu cầu |
| Memory | Độ đúng/liên quan của truy xuất, recall, stale memory, context tokens |
| Selector | Tỷ lệ chọn flow đạt yêu cầu, chi phí chênh lệch với flow tốt nhất đã quan sát |

Task đại diện: sửa lỗi có tái hiện; tính năng cấu hình lưu bền; refactor giữ hành vi; bài học kèm mã chạy; nghiên cứu có nguồn; build/mô phỏng embedded khi đủ công cụ.

Thiết kế thử nghiệm cần:

- Tách dữ liệu tối ưu, validation và bộ đánh giá cuối.
- Có test ẩn và đánh giá con người khi tiêu chí khó tự động hóa.
- Lặp nhiều lần; công bố phân bố/độ biến động thay vì chỉ chọn lần tốt nhất.
- Ghi model/provider/version quan sát được, toolchain, code baseline và cache policy.
- Giữ rõ điều kiện memory: cold start, cùng snapshot ban đầu hoặc memory đã học; không trộn các nhóm.
- Tính cả chi phí điều phối, đánh giá và các lần thất bại.

Chọn flow trên đường đánh đổi chất lượng/chi phí phù hợp từng nhóm task; chưa ép mọi kết quả vào một điểm tổng hợp duy nhất.

## 8. Cơ chế cải thiện sau mỗi lần chạy

```text
Run -> kết quả/bằng chứng -> phân tích lỗi
    -> đề xuất thay đổi -> phiên bản ứng viên
    -> benchmark + regression -> thử giới hạn -> áp dụng hoặc loại bỏ
```

Các loại cải thiện có thể gồm memory mới, skill/prompt, model binding, chia task, thêm/bớt node, điều kiện rẽ nhánh và chính sách selector. Không coi các loại này là cùng một cơ chế: lưu một kinh nghiệm khác với thay đổi graph hay huấn luyện model.

Ưu tiên tối ưu từng node trước khi tìm kiếm toàn bộ graph. Giữ version, lịch sử so sánh và rollback. Không cho phép tối ưu tự bỏ checks, sửa rubric hoặc nới quyền để đạt điểm cao hơn. Memory do lần chạy mới tạo không được làm rò đáp án vào bộ đánh giá cuối.

## 9. Khảo sát bên ngoài và bộ lọc năm 2026

### 9.1. Phương pháp và giới hạn

Đợt đầu khảo sát README/tài liệu/source của LangGraph, CrewAI, Langflow, Flowise, Letta, Agno, DSPy, AFlow, MetaGPT, AutoGen, Microsoft Agent Framework, RouteLLM, Mem0, BMAD và Deep Agents.

Sau đó ưu tiên repo **được tạo trong năm 2026**, kiểm tra ngày tạo từ metadata trang GitHub và ngày commit nhánh mặc định từ commit feed. Tìm kiếm kết hợp các từ khóa agent/workflow, memory/SQLite và multi-agent/visual, có lọc năm, trạng thái archive và mức stars để giảm nhiễu. Đây là khảo sát chọn lọc, không phải danh mục đầy đủ. Stars chỉ hỗ trợ tìm kiếm, không chứng minh chất lượng.

Ngày tạo repo khác ngày khởi đầu ý tưởng/code. Fork, đổi tên hoặc tách hạ tầng có thể mang lịch sử cũ. Commit mới có thể chỉ sửa tài liệu/CI; không chứng minh đã thích nghi tốt với model mới. Các URL nhánh là nguồn động, chưa phải dependency pin.

### 9.2. Shortlist repo mới năm 2026

Các ngày dưới đây là ngày lịch tại Asia/Bangkok từ dữ liệu quan sát ngày 26/10/2026.

| Repo | Ngày tạo | Commit nhánh mặc định gần nhất khi kiểm tra | Điểm đáng học |
| --- | --- | --- | --- |
| [Ekko Studio](https://github.com/EKKOLearnAI/ekko-studio) | 11/04/2026 | [26/10/2026](https://github.com/EKKOLearnAI/ekko-studio/commits/main/) | Visual workflows, profiles, nhiều runtime, budgets và lịch sử |
| [DSH Visual Workflow](https://github.com/GZX2211/dsh-Visual-Workflow) | 16/08/2026 | [21/10/2026](https://github.com/GZX2211/dsh-Visual-Workflow/commits/main/) | Graph tùy biến, meta-orchestration, templates/instances và organizational memory |
| [Rta-Smriti Brain](https://github.com/sulabhdubey/rta-smriti-brain) | 15/08/2026 | [26/10/2026](https://github.com/sulabhdubey/rta-smriti-brain/commits/main/) | Project-scoped SQLite, nguồn/bằng chứng, context packs và trạng thái theo thời gian |
| [Engram](https://github.com/Gentleman-Programming/engram) | 16/02/2026 | [26/10/2026](https://github.com/Gentleman-Programming/engram/commits/main/) | SQLite + FTS5, project-aware retrieval, MCP/CLI |
| [Gas City](https://github.com/gastownhall/gascity) | 22/02/2026 | [26/10/2026](https://github.com/gastownhall/gascity/commits/main/) | Declarative configuration, packs/overrides, multi-project orchestration |
| [Smithers](https://github.com/smithersai/smithers) | 06/01/2026 | [26/10/2026](https://github.com/smithersai/smithers/commits/main/) | Flow cạnh code, tự động hóa thay đổi từ issue và kiểm tra |

Một số ngày khác bảng trao đổi trước vì bảng đó dùng ngày UTC. Các timestamp gốc để đối chiếu:

| Repo | Created timestamp (UTC) | Latest default-branch commit timestamp (UTC) |
| --- | --- | --- |
| Ekko Studio | `2026-04-11T07:38:18Z` | `2026-10-26T05:58:40Z` |
| DSH Visual Workflow | `2026-08-15T20:22:02Z` | `2026-10-21T09:08:16Z` |
| Rta-Smriti Brain | `2026-08-14T20:49:21Z` | `2026-10-26T05:03:40Z` |
| Engram | `2026-02-16T13:38:41Z` | `2026-10-25T19:03:15Z` |
| Gas City | `2026-02-22T01:40:16Z` | `2026-10-26T05:46:05Z` |
| Smithers | `2026-01-05T21:13:36Z` | `2026-10-26T06:03:53Z` |

### 9.3. Phân tích ứng viên ưu tiên

**Ekko Studio — hình dung sản phẩm và editor.** README mô tả Vue Flow canvas, conditions, success/failure routes, loops, approval gates, import/export, budgets/deadlines và execution history. Profiles quản lý memory, skills và cấu hình runtime. Học cách kết hợp thiết kế và quan sát; cần xác minh profile có tương ứng với project identity của NeoMind hay không.

**DSH Visual Workflow — gần ý tưởng flow tiến hóa nhất trong shortlist.** README mô tả kéo thả roles/teams, sửa graph có kiểm soát qua tools, can thiệp trong lúc chạy, template tách instance, SQLite/vector retrieval với BM25 dự phòng và tích lũy kinh nghiệm. Cần đối chiếu source và chạy thử để phân biệt feedback/heuristics với học tăng cường đã được đánh giá. Chưa có bằng chứng trong khảo sát rằng chất lượng tăng ổn định sau mỗi run.

**Rta-Smriti Brain — memory có nguồn và freshness.** README mô tả SQLite theo project, content hashes, symbols/relations, observations tách prior memory, context packs, temporal state và contradiction tracking. Có [public benchmark](https://github.com/sulabhdubey/rta-smriti-brain/blob/main/docs/PUBLIC_BENCHMARK.md). Học mô hình độ còn hiệu lực; cần tự đánh giá retrieval trên NeoProject.

**Engram — memory gọn và truy vấn được.** SQLite + FTS5, MCP/HTTP/CLI/TUI, project-aware reads và quy tắc lưu kiến thức chọn lọc. Mặc định database chung có phạm vi project, khác yêu cầu một file SQLite cho mỗi project. Tham khảo API và kiểm soát scope; không coi hai mô hình lưu trữ là tương đương.

**Gas City — cấu hình và đa project.** `city.toml`, runtime providers, packs/overrides, supervisor reconciliation và bounded convergence. Học ranh giới giữa cấu hình mong muốn và trạng thái thực. Dự án tự mô tả kế thừa hạ tầng từ Gas Town, nên repo mới không đồng nghĩa mọi thành phần đều mới.

**Smithers — workflow cùng source.** Flow được lưu cạnh code; CLI scaffold/start và mục tiêu chuyển issue thành tested changes để review. Học versioning và trải nghiệm authoring; cần khảo sát sâu schema/executor trước quyết định tái sử dụng.

Một ứng viên bổ sung là [OpenFlow](https://github.com/SeeRay11/OpenFlow), repo tạo tháng 8/2026, mô tả kéo role cards và multi-agent workflow. README nói rõ đây là fork của OpenCode; vì vậy không dùng ngày tạo repo làm bằng chứng toàn bộ engine mới năm 2026.

### 9.4. Nguồn cũ vẫn hữu ích theo từng bài toán

| Nguồn | Bài học cho NeoMind | Giới hạn áp dụng |
| --- | --- | --- |
| [LangGraph](https://github.com/langchain-ai/langgraph) | Graph state, checkpoint, durable execution | Cần xây project packs và acceptance contracts riêng |
| [Agno](https://github.com/agno-agi/agno) | Agents/teams/workflows, memory, evals; có [SQLite backend](https://github.com/agno-agi/agno/blob/main/libs/agno/agno/db/sqlite/sqlite.py) | Backend có sẵn không chứng minh memory theo repo hay selector level 1–5 |
| [Langflow](https://github.com/langflow-ai/langflow) | Visual builder, playground, API/MCP cho flow | Canvas cần bổ sung quyền và bằng chứng kỹ thuật |
| [BMAD](https://github.com/bmad-code-org/BMAD-METHOD) và [Builder](https://github.com/bmad-code-org/bmad-builder) | Project setup, agents/skills/workflows đóng gói | Instructions không thay thế runtime enforcement |
| [Letta Code](https://github.com/letta-ai/letta-code) | Global/project/agent skills, memory và context history | Memory của producer không phải independent evidence |
| [DSPy optimizers](https://dspy.ai/learn/optimization/optimizers/) | Tối ưu instructions/examples theo metric | Cần dataset và metric phù hợp; không tự tổng quát thành graph optimizer |
| [AFlow](https://github.com/FoundationAgents/AFlow) | Tìm workflow bằng biến thể Monte Carlo Tree Search | Benchmark học thuật chưa chứng minh hiệu quả trên repo có nhiều side effects |
| [RouteLLM](https://github.com/lm-sys/RouteLLM) | Hiệu chỉnh lựa chọn theo chất lượng/chi phí | Chọn model khác chọn cả workflow; cần thiết kế và dữ liệu mới |

Các repo đã kiểm tra không đáp ứng bộ lọc tạo năm 2026 gồm LangGraph (2023), DSPy (2023), AFlow (2025), Microsoft Agent Framework (2025), Letta Code (2025), Hermes Agent (2025) và Agno (2022). Độ mới của commit và mức phù hợp với model hiện tại vẫn cần đánh giá riêng.

README AutoGen và Flowise quan sát trong đợt khảo sát thông báo archive; AutoGen hướng sang [Microsoft Agent Framework](https://github.com/microsoft/agent-framework). Cần kiểm tra lại trạng thái tại thời điểm chọn dependency. Không có quyết định tích hợp dependency bên ngoài trong report này.

## 10. Lộ trình đề xuất và tiêu chí hoàn thành

| Giai đoạn | Đầu ra | Tiêu chí đánh giá |
| --- | --- | --- |
| 1. Bản thiết kế và executor | Schema, validator, ba flow mẫu, versioned run | Chạy end-to-end, chặn graph/contract sai, resume và giới hạn vòng lặp |
| 2. Project packs và memory | Kế thừa cấu hình, SQLite API, FTS5, freshness | Scope không lẫn project, truy xuất có nguồn, backup/restore và migration |
| 3. Benchmark và selector | Dataset, baseline skills-only, luật chọn ban đầu | So sánh lặp lại được, báo chi phí/chất lượng, chọn flow theo constraint |
| 4. Visual designer | Canvas dùng chung schema với file design | Import/export không mất ngữ nghĩa, version và lỗi validation rõ |
| 5. Improvement loop | Ứng viên skill/flow, eval gate, rollback | Chứng minh lợi ích trên held-out tasks, không hồi quy nghiêm trọng |

Có thể phác thảo UI sớm để kiểm tra trải nghiệm. Tuy nhiên, schema và semantics cần đủ ổn định trước khi đầu tư editor đầy đủ. Chưa ước lượng lịch hay chi phí triển khai vì chưa audit phạm vi tái sử dụng code hiện tại.

## 11. Quyết định còn mở và việc nghiên cứu tiếp

1. SQLite là nguồn chuẩn cho dữ liệu nào; dữ liệu nào tiếp tục dùng file/immutable records?
2. Schema graph chọn JSON, YAML hay TypeScript authoring; làm thế nào giữ cùng semantics với canvas?
3. Khởi đầu với graph cố định hay cho sửa graph khi chạy? Quy tắc migration execution contract là gì?
4. Tách cấu hình common/project/agent ra sao; xử lý xung đột và version updates thế nào?
5. Level là preset, mức assurance hay nhãn ngân sách? Những checks nào bắt buộc theo từng loại rủi ro?
6. Model/provider nào có thể quan sát xác thực; telemetry nào còn thiếu?
7. Tiêu chí nâng cấp workflow, quyền áp dụng tự động và yêu cầu con người đánh giá là gì?
8. Memory retrieval giảm bao nhiêu token, bỏ sót thông tin nào và xử lý stale facts ra sao?

Việc tiếp theo có giá trị nhất là audit schema/state/storage hiện tại của NeoMind và chạy cùng một task nhỏ qua ba phương án: skills-only, flow đơn giản và flow có Verifier độc lập. Song song, đọc sâu Ekko Studio, DSH Visual Workflow và Rta-Smriti Brain để lập bảng đối chiếu source và thử nghiệm giới hạn. Kết quả đó mới đủ cơ sở để chốt kiến trúc hoặc lựa chọn tái sử dụng.
