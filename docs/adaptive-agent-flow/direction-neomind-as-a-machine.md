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

### 2.5 Mức tối ưu (`-O0` … `-O2`, `-Os`) cho việc cấp phát session

Ý người dùng 11/11: mỗi bước một session mới thì tốn ngữ cảnh; nên cho một session làm nhiều bước, như mức optimize của trình biên dịch C.

Hiện trạng: NeoMind đã có `sessionGroup` — các bước cùng nhóm dùng chung một session (lượt sau resume lượt trước). Template Dev cho plan + implement + vòng sửa chung `implementation-session`; reviewer luôn ở session riêng; Fast tách planner và implementer thành hai session. Người dùng phải tự đặt nhóm trong Flow Studio.

Đề xuất: một **pass cấp phát session** trong compiler, chạy theo mức tối ưu chọn ở flow hoặc khi start run:

| Mức | Cấp phát | Đổi lại |
| --- | --- | --- |
| `-O0` | Mỗi bước một session | Dễ debug, cô lập tối đa, tốn ngữ cảnh nhất |
| `-O1` | Các bước nối tiếp cùng vai trò và cùng runner/model chung session (như Dev hiện nay) | Mặc định cân bằng |
| `-O2` | Gộp thêm mọi bước nối tiếp được phép gộp (planner + implementer của Fast, các bước sửa liên tiếp) | Rẻ hơn; context dài hơn, dễ "loãng" |
| `-Os` | Như `-O1` nhưng thu gọn bàn giao: bước sau nhận tóm tắt/diff thay vì toàn bộ, memory tối thiểu | Ít token nhất cho bước mới |

Ràng buộc mà tối ưu không được phá (giống `volatile` trong C): reviewer độc lập **không bao giờ** chung session với bước viết code; khác runner/model/provider thì không chung được (khác "core"); nhánh song song không chung; bước chờ duyệt người cắt session nếu runner không giữ được lâu. Preview và memory map hiện bước nào chung session và ước tính tiết kiệm; `run stats` so sánh các mức trên cùng loại task để chọn mặc định bằng số liệu.

### 2.6 Flow như một ngôn ngữ lập trình

Nhận xét người dùng 11/11: tạo flow không còn đơn thuần là kéo thả khối mà có thể thành một ngôn ngữ. Thực tế NeoMind đã có nửa đường: **flow JSON là IR**, `compileFlow` là compiler, Flow Studio là trình soạn thảo trực quan cho IR (như Simulink/LabVIEW so với C). Bước tiếp là cho flow một **dạng văn bản** biên dịch về cùng IR.

Phác thảo cú pháp (chưa chốt):

```
flow dev-review "Dev + review UI" {
  opt O1
  limits { time 30m, tokens 400k, repair 2 }

  agent planner   = implementer @ codex/gpt-6.1-sol  reasoning high
  agent coder     = implementer @ claude/sonnet-5-5  skills [c-style]
  agent reviewer  = verifier    @ codex/gpt-6-luna   memory [decision, lesson]

  plan    = planner.plan(task)                  // -> Plan
  approve plan by user
  code    = coder.write(plan, scope plan.scope) // -> CodeChange
  checks  ["npm test"] on code
  review  = reviewer.review(code, against plan) required
  repair code until review.pass max 2
  commit code
}

fn review_ui(change: CodeChange) -> Verdict { ... }   // chương trình con, gọi lại được
```

| Khái niệm ngôn ngữ | Trong NeoMind |
| --- | --- |
| Kiểu dữ liệu | Output contract (`Plan`, `CodeChange`, `Report`, `Verdict`); compiler báo lỗi khi nối sai kiểu, ở cả canvas lẫn văn bản |
| Hàm, gọi hàm | Chương trình con (2.3), flow con có chữ ký vào/ra |
| Vòng lặp có giới hạn | `repair … until … max N`; sau này vòng điều khiển có setpoint |
| Cờ biên dịch | `opt O0/O1/O2/Os` (2.5) |
| Static analysis / lint | Policy sàn: không bỏ review, không tự duyệt plan — lỗi lúc viết, không đợi lúc chạy |
| `volatile` | Reviewer độc lập không được gộp session |
| Thư viện, import | Skills, agent, flow dùng chung giữa các repo |
| Debugger, trace | Breakpoint, time-travel trên journal (2.1) |

Lợi ích: diff/review flow trong Git dễ hơn JSON canvas; AI viết code tốt hơn viết JSON graph nên `flow_draft` chính xác hơn; có comment và tách hàm.

Nguyên tắc giữ chừng mực:

- **Ngôn ngữ khai báo, nhỏ**, không đa dụng: không biến tùy ý, không vòng lặp vô hạn, mọi thứ kiểm được lúc biên dịch. Sức mạnh của NeoMind là kiểm chứng trước khi chạy; ngôn ngữ càng tự do càng khó giữ policy sàn.
- **Một IR, hai giao diện:** văn bản và canvas cùng biên dịch về flow JSON, cùng compiler; sửa bên nào bên kia cập nhật theo.
- Học từ tiền lệ thay vì phát minh lại: GitHub Actions (YAML khai báo), Temporal/LangGraph (workflow-as-code), Dagger (pipeline-as-code).

Lộ trình: (1) kiểu dữ liệu cho output contract trong compiler hiện có → (2) cú pháp văn bản biên dịch về IR, hai chiều với canvas → (3) hàm/chương trình con → (4) cờ `opt` và các pass tối ưu.

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

## 4. Nghiên cứu tiền lệ (11/11/2026)

Tìm trên web, chưa chạy thử. **(?)** = nguồn thứ cấp hoặc chưa kiểm chứng.

**Tiền lệ gần nhất:** [ArbiterOS](https://arxiv.org/html/2510.13857) (10/2025) mô hình hóa agent thành máy von Neumann: LLM là "Probabilistic CPU", context là RAM, tool là I/O; một kernel tất định kiểm mọi chuyển trạng thái theo policy; ISA 5 nhóm lệnh có kiểu (Cognitive, Memory, Execution, Normative VERIFY/CONSTRAIN, Metacognitive EVALUATE_PROGRESS); có flight recorder cho time-travel. Nên đọc trước khi chốt 2.6.

### Theo từng hướng

| Hướng | Tiền lệ | Nên mượn / tránh |
| --- | --- | --- |
| 2.1 Debugger | [LangGraph time-travel](https://docs.langchain.com/oss/python/langgraph/use-time-travel), [Temporal replay](https://docs.temporal.io/child-workflows) | Tách hai chế độ: **xem lại từ journal** (tất định, miễn phí) và **chạy lại bước** (tốn quota, ra kết quả khác — so cấu hình cần nhiều mẫu). Quay lại quá khứ luôn tạo nhánh/run mới |
| 2.1 Memory map | [Prompt caching của Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [OpenTelemetry GenAI](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans) | Hiện cả token đọc từ cache / ghi cache / mới, không chỉ dung lượng |
| 2.2 RAM → Flash | [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), [MemGPT](https://arxiv.org/abs/2310.08560), [Letta](https://docs.letta.com/guides/agents/memory) | Mượn "cảnh báo áp lực bộ nhớ" để agent kịp ghi chú trước khi context đầy; **tránh** để agent tự sửa memory không duyệt |
| 2.3 Chương trình con | [GitHub Actions reusable workflows](https://docs.github.com/en/actions/sharing-automations/reusing-workflows), [Temporal child workflow](https://docs.temporal.io/child-workflows) | Giới hạn độ sâu, cấm vòng lặp, input/output có kiểu; **quyền chỉ giữ hoặc giảm, không bao giờ nâng**; journal riêng cho flow con + chính sách khi flow cha bị hủy |
| 2.4 Ngắt / watchdog | [Claude Code hooks](https://code.claude.com/docs/en/hooks), [SWE-agent](https://arxiv.org/abs/2405.15793), [SWE-smith](https://arxiv.org/pdf/2504.21798) | Hook của runner (PreToolUse, Stop, PreCompact) là bảng vector sẵn có. Chuỗi lặp dài gắn chặt với thất bại, nhưng can thiệp không làm tăng tỉ lệ giải được → watchdog nên **dừng và báo người** để giữ quota, không cố "cứu" run |
| 2.5 Mức tối ưu | [LLMCompiler](https://arxiv.org/abs/2312.04511), [SGLang RadixAttention](https://arxiv.org/abs/2312.07104) | Pass tìm bước chạy song song được (LLMCompiler báo tới 3,7x nhanh, 6,7x rẻ hơn ReAct); RadixAttention chỉ hữu ích khi tự host model |
| 2.6 Ngôn ngữ | [DSPy](https://arxiv.org/abs/2310.03714), [BAML](https://www.boundaryml.com/blog/schema-aligned-parsing), [LMQL](https://arxiv.org/abs/2212.06094), [AFlow](https://arxiv.org/abs/2410.10762) | Signature vào/ra có kiểu; AFlow dùng workflow dạng code vì graph khó diễn tả điều kiện (ủng hộ dạng văn bản); ArbiterOS diễn đạt policy bằng ràng buộc thứ tự ("GENERATE phải có VERIFY trước TOOL_CALL rủi ro") — compiler kiểm được |

### Ý tưởng mới

1. **Pass bố trí prefix cho cache** (như linker xếp `.rodata`): cache Anthropic tính theo tools → system → messages; prefix giống hệt và còn TTL thì trúng cache kể cả khác conversation. Đặt rules/skills/memory ổn định lên đầu và giống nhau giữa các bước, task/plan để cuối; không chèn timestamp vào prefix; nhánh song song khởi động lệch nhau.
2. **Reviewer khác họ model** (dissimilar redundancy): LLM chấm thiên vị output của chính nó ([Panickssery et al. 2024](https://arxiv.org/abs/2404.13076)) và của cùng họ model ([2026](https://www.alphaxiv.org/abs/2604.06996), (?)). Ở chế độ an toàn, "volatile" nên gồm cả khác provider, không chỉ khác session.
3. **Rút workflow từ journal thành skill/flow con** ([Agent Workflow Memory](https://arxiv.org/abs/2409.07429)): promote RAM → ROM, không chỉ RAM → Flash.
4. **Tối ưu flow offline từ journal** ([AFlow](https://arxiv.org/abs/2410.10762), [ADAS](https://arxiv.org/abs/2408.08435), [Microsoft Trace](https://microsoft.github.io/Trace/)) trong ngân sách cố định hoặc trên fake runner — nền cho A/B firmware.
5. **Mức governance theo môi trường** (dev/staging/prod như ArbiterOS), ghép với cờ `opt`; sàn không bao giờ hạ.
6. **Cache kết quả checks theo content hash** ([Dagger](https://docs.dagger.io/)): tree hash + lệnh không đổi thì dùng lại kết quả, ghi rõ vào journal.

### Chỗ nghiên cứu thách thức giả định

- **"Chung session thì tiết kiệm token" chưa chắc đúng.** Với prompt caching, prefix lặp lại chỉ tốn khoảng 0,1x giá input (ghi cache 1,25x với TTL 5 phút, 2x với TTL 1 giờ). Session chung phải đọc lại lịch sử ngày càng dài; lợi thật của nó là không phải khám phá lại repo. TTL mặc định 5 phút ngắn hơn thời gian chờ duyệt plan, nên resume sau duyệt có thể phải ghi lại cache cả lịch sử — implementer mới nhận plan + tóm tắt có thể rẻ hơn. Có báo cáo `--resume` tốn token bất thường (?). **Phải đo bằng các trường cache trước khi chọn mức mặc định.**
- **Context dài làm chất lượng giảm**: [Lost in the Middle](https://arxiv.org/abs/2307.03172), [Chroma Context Rot](https://www.trychroma.com/research/context-rot) (prompt tập trung ~300 token tốt hơn rõ so với ~113k token). `-O2` có rủi ro chất lượng thật, không chỉ "dễ loãng".
- **Ngược lại, tóm tắt bàn giao (`-Os`) làm mất quyết định ngầm** ([Cognition](https://cognition.ai/blog/dont-build-multi-agents)): bàn giao nên gồm plan + quyết định + diff, không chỉ tóm tắt.
- **Song song tốn kém**: hệ multi-agent dùng khoảng 15x token so với chat ([Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system), qua nguồn thứ cấp). Parallel writers chỉ đáng cho việc giá trị cao.
- **Thiết bị an toàn**: chưa có chuẩn/FDA guidance riêng cho code AI sinh; thực hành ([Innolitics](https://innolitics.com/articles/ai-generated-code-fda-clearance/)) coi nghĩa vụ như code người viết, khoảng trống chính là truy vết code → yêu cầu → hazard → bằng chứng (?). Journal là audit trail nhưng chưa đủ.

### Đọc kỹ ArbiterOS (arXiv 2510.13857v1)

Đây là **bài quan điểm**, không có hệ thống chạy thật hay số liệu đánh giá; NeoMind đã hiện thực nhiều thứ bài chỉ mô tả. Những ý đáng mượn:

- **Tập lệnh 20 lệnh, 5 nhóm ("core")**: Cognitive (`GENERATE`, `DECOMPOSE`, `REFLECT`), Memory (`LOAD`, `STORE`, `COMPRESS`, `FILTER`, `STRUCTURE`, `RENDER`), Execution (`TOOL_CALL`, `TOOL_BUILD`, `DELEGATE`, `RESPOND`), Metacognitive (`PREDICT_SUCCESS`, `EVALUATE_PROGRESS`, `MONITOR_RESOURCES`), Normative (`VERIFY`, `CONSTRAIN`, `FALLBACK`, `INTERRUPT`). Policy viết theo **nhóm lệnh** chứ không theo chữ trong prompt.
- **Policy dạng YAML theo thứ tự lệnh**, ví dụ "Cognitive không được nối thẳng sang Execution, phải có Normative ở giữa". Kiểm **tĩnh** (lint graph trước khi chạy) và **động** (Arbiter Loop kiểm mọi chuyển trạng thái lúc chạy, vì nhánh `FALLBACK` chỉ biết lúc chạy). Gợi ý cho NeoMind: cho người dùng viết policy sàn riêng bằng luật theo loại khối.
- **Golden Dataset + CI cho flow**: mỗi thay đổi flow/model/skill chạy lại một bộ task mẫu, so với baseline, chặn publish nếu kém đi; **mỗi run thất bại quan trọng thành test hồi quy vĩnh viễn**. Ba kiểu chuẩn: output chính xác, rubric, tuân thủ quy trình.
- **Reliability Budget, ba mức kiểm chứng**: mềm (LLM chấm, có điểm tin cậy), cứng (test, validator tất định), hình thức (oracle ngoài / người duyệt). **Leo thang theo độ tin cậy**: reviewer tự tin thấp hơn ngưỡng thì chuyển kiểm cứng hơn hoặc gọi người.
- **Ensemble verification**: k trên n reviewer khác nhau phải đồng ý.
- **Agent Compiler tối ưu chi phí kiểm soát**: chọn mức kiểm cho từng bước lúc biên dịch, gộp `GENERATE` + `VERIFY` mức 1 vào một lượt gọi mà vẫn giữ audit trail, chạy song song các `VERIFY` độc lập.
- **Áp dụng dần**: giai đoạn 1 chỉ bật flight recorder; giai đoạn 2 thêm `VERIFY`/`FALLBACK`; giai đoạn 3 thêm memory và metacognitive. Môi trường dev/staging/prod có độ chặt khác nhau.
- **Cognitive Corruption**: tóm tắt/nén context gây lỗi im lặng — *bỏ sót* (quên dữ kiện) hoặc *thêm sai* (bịa khi tóm tắt). Vì vậy `COMPRESS` phải có `VERIFY` theo sau — liên quan trực tiếp tới `-Os` và bàn giao bằng tóm tắt.
