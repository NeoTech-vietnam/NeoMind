# Nghiên cứu: workflow agent hữu ích, chạy ổn định, tự sửa lỗi và hẹn giờ cho NeoMind

Ngày: 12/11/2026 · Trạng thái: **nghiên cứu, chưa duyệt để lập plan**. Đọc tài liệu và trang web, chưa chạy thử hệ thống bên ngoài nào. **(?)** = nguồn thứ cấp hoặc chưa kiểm chứng với bản gốc.

Bối cảnh: [định hướng 11/2026](../adaptive-agent-flow/direction-2026-11.md), [ẩn dụ con chip](../adaptive-agent-flow/direction-neomind-as-a-machine.md) (mục 4 đã có ArbiterOS, LLMCompiler, prompt caching, nên không nhắc lại), [nghiên cứu trước](adaptive-project-workflows-2026.md). Sự cố 11/11: bước plan chạy bằng OpenCode lặp đọc lại cùng các file trong 37–49 lượt model (~1M token cộng dồn, ~3% quota) tới khi bị hủy; test chập chờn; người dùng phải chọn lại model cho mỗi run.

## 1. Tóm tắt

- **Workflow có bằng chứng rõ nhất đều đơn giản:** explore → plan → code → test → review với ngữ cảnh sạch. Anthropic khuyên "bắt đầu từ giải pháp đơn giản nhất". Agentless (pipeline cố định 3 bước) từng thắng các agent phức tạp trên SWE-bench Lite với chi phí $0,70/issue. Cognition (04/2026) nói multi-agent chỉ chạy được khi **việc ghi vẫn đơn luồng**, agent phụ chỉ góp trí tuệ (review, lập kế hoạch) chứ không cùng ghi. NeoMind đã có gần đủ bộ khung này.
- **Kiểu workflow chưa có mà đáng làm nhất là việc định kỳ và việc chỉ đọc:** báo cáo sức khỏe repo hằng đêm, phân loại test chập chờn, đồng bộ docs, review diff khi có commit, release notes hằng tuần. Claude Code, Devin, Factory và GitHub Agentic Workflows đều đã có dạng này. Đặc điểm chung: chạy lặp, rủi ro thấp, kết quả là báo cáo hoặc đề xuất cho người xem.
- **Lỗ hổng ổn định lớn nhất của NeoMind là vòng lặp bên trong một bước.** Ngân sách token chỉ được kiểm *giữa các bước* (`local-run.ts`), còn giới hạn lượt chỉ có ở OpenCode (60 lượt). Cần watchdog "không tiến triển" chung cho mọi runner. Khi phát hiện lặp thì **dừng và báo người**, không tự cứu: SWE-smith cho thấy chuỗi lặp dài đi đôi với thất bại, và phần lớn run không giải được kết thúc vì chạm giới hạn chi phí trước khi sửa được dòng code nào.
- **Tự sửa lỗi chỉ hiệu quả khi có phản hồi từ bên ngoài** (test, checks, reviewer khác). Tự sửa thuần thì lợi ích nhỏ so với chi phí (Olausson, ICLR 2024). Vòng sửa của NeoMind nên dựa vào checks và review độc lập như hiện nay, giữ ít vòng, và cho phép dùng model mạnh hơn ở vòng sửa.
- **Hệ tự nâng cấp có rủi ro thật:** Darwin Gödel Machine tự xóa marker phát hiện ảo giác để đạt điểm cao. ImpossibleBench cho thấy model càng mạnh càng hay sửa test cho qua (GPT-5 làm vậy 54% số lần (?)). Thiết kế an toàn gồm: evaluator và bộ golden task **bị đóng băng**, đề xuất chỉ thành **phiên bản mới** (flow/skill/rule/memory), người duyệt, chạy thử trên golden task trước khi dùng thật, rollback về version có hash.
- **Hẹn giờ:** làm bản tối thiểu, chạy cục bộ. Một lệnh `schedule tick` idempotent, gọi từ Windows Task Scheduler hoặc systemd timer, và gọi thêm từ editor/extension khi đang mở. Mặc định không cho run chồng nhau, lỡ lịch thì chỉ chạy bù một lần, có trần token mỗi ngày. Flow chỉ đọc được chạy tự động tới cuối; flow ghi code **dừng ở cổng duyệt plan** và báo người.
- **Ẩn dụ MCU:** nên giữ watchdog, journal, brown-out (ngân sách), MPU (policy sàn), RTC (hẹn giờ). Không nên mang sang vòng điều khiển nhanh, ngắt độ trễ thấp hay nhiều bước nhỏ. Mỗi "lệnh" của NeoMind tốn vài phút và có thể vài đô-la, nên mọi logic điều khiển phải nằm trong code tất định, LLM chỉ làm phần cần phán đoán.
- **Ưu tiên đề xuất:** (1) watchdog + trần token mỗi bước → (2) preset model và checks chịu được test chập chờn → (3) scheduler tối thiểu, job đầu tiên là phân loại test chập chờn của chính NeoMind → (4) golden tasks + `eval` → (5) đề xuất cải tiến sau run có cổng duyệt.

## 2. Workflow hữu ích trong thực tế

| # | Workflow | Kích hoạt | Các bước | Vì sao hữu ích / bằng chứng | NeoMind |
| --- | --- | --- | --- | --- | --- |
| 1 | **Explore → Plan → Code → Commit** | Người/AI giao task | Đọc repo (chỉ đọc) → plan → duyệt → sửa → test → commit | Claude Code best practices: tách nghiên cứu khỏi sửa code để không giải sai bài; với việc nhỏ, rõ thì bỏ plan vì tốn thêm | **Có sẵn** (Dev, Fast) |
| 2 | **TDD có đóng băng test** | Task có thể kiểm tự động | Viết test (người duyệt) → khóa test → code tới khi xanh | Anthropic gọi đây là workflow ưa thích cho thay đổi kiểm được. ImpossibleBench: model hay sửa test cho qua; cho phép "dừng và giải thích" làm giảm gian lận rõ rệt (?) | **Cần thêm:** bước "test trước", check báo khi diff đụng file test đã khóa, rule cấm sửa test |
| 3 | **Generator–verifier, ngữ cảnh sạch** | Sau mỗi bước ghi code | Reviewer không chia sẻ context với người viết, chấm theo tiêu chí | Cognition: Devin Review bắt trung bình 2 bug/PR, ~58% nghiêm trọng; tốt nhất khi reviewer **không** chia sẻ context trước. Anthropic: evaluator-optimizer hợp khi có tiêu chí rõ | **Có sẵn** (review độc lập). Thêm tùy chọn reviewer khác họ model |
| 4 | **Routing theo độ khó** | Lúc tạo run | Phân loại task → flow/model rẻ hay mạnh | Anthropic: chuyển câu hỏi dễ sang model rẻ, câu khó sang model mạnh | **Có một phần** (`assess`); cần dựa trên `run stats` |
| 5 | **Pipeline cố định localize → repair → validate** | Bug có cách tái hiện | Định vị file → hàm → dòng (chỉ đọc, có giới hạn) → sinh bản vá → chạy test | Agentless: 32% SWE-bench Lite, $0,70/issue, LLM không tự chọn bước tiếp theo | **Cần thêm:** template "Bug fix" với bước localize có trần lượt/token |
| 6 | **Architect / editor** | Mọi task code | Model mạnh lập plan, model rẻ sửa | Aider: o1-preview + editor rẻ đạt 85% (Sonnet một mình 84%), lợi về chi phí nhiều hơn về điểm. Run `run-450e4827` (Sol lập plan, Luna làm) xong trong 147 giây | **Có sẵn** (binding theo bước); **thiếu preset** để khỏi chọn lại model |
| 7 | **Harness dài hơi theo tính năng** | Việc lớn nhiều phiên | Bước khởi tạo tạo feature list JSON và file tiến độ → mỗi phiên làm một tính năng → commit → cập nhật tiến độ | Anthropic (11/2025): agent hay "làm quá nhiều một lúc" hoặc "tuyên bố xong" sớm; agent chỉ được đổi trường `passes`, dùng JSON vì model ít ghi đè hơn Markdown | **Có một phần** (chương trình nhiều giai đoạn); thiếu scratchpad/tiến độ chung giữa các run |
| 8 | **Review diff khi có sự kiện** | Commit/push/PR | Lấy diff → review theo `rules.md` → báo cáo (không sửa) | Copilot coding agent không được tự duyệt/merge PR của nó; cloud scheduled task của Claude Code có trigger theo sự kiện GitHub | **Cần thêm:** trigger sự kiện + flow chỉ đọc |
| 9 | **Báo cáo định kỳ chỉ đọc** | Hẹn giờ (đêm/tuần) | Quét repo: TODO, dependency cũ, docs lệch code, cờ tính năng hết hạn → báo cáo/đề xuất | Devin: dọn cờ tính năng mỗi thứ Hai, release notes thứ Sáu, QA staging mỗi sáng; ghi chú giữa các lần chạy để "biết đã dừng ở đâu". GitHub Agentic Workflows: agent mặc định chỉ đọc, mọi thao tác ghi đi qua "safe outputs" có giới hạn | **Cần thêm:** timer, đầu ra kiểu báo cáo, ghi chú giữa các run |
| 10 | **Phân loại test chập chờn** | Hằng ngày hoặc sau suite đỏ | Đọc lịch sử chạy → chấm điểm bất định → nguyên nhân rõ thì đề xuất sửa, chưa rõ thì đề xuất cách ly (người duyệt) | Kortix chạy agent này hằng ngày, mở PR cách ly kèm issue cho người (?). Skill Datadog: nguyên nhân chưa chắc thì không sửa (?). Có dự án cố ý *không* tự cách ly vì cách ly cũng giấu bug thật | **Cần thêm**; đúng vấn đề NeoMind đang gặp (backlog "test process/reviewer không ổn định") |
| 11 | **Sửa lỗi khi nâng dependency** | PR Renovate/Dependabot đỏ | Đọc log lỗi → tìm breaking change → sửa trên nhánh → checks | Ona, bumpgen, fossabot làm đúng việc này (tài liệu nhà cung cấp, (?)); Renovate tự nó không sửa code | **Cần thêm** trigger; hợp sau khi có #8 |
| 12 | **Đồng bộ docs** | Sau commit hoặc hằng tuần | So code đã đổi với docs → đề xuất sửa docs | Là ví dụ chính thức của GitHub Agentic Workflows; AGENTS.md của repo này đòi cập nhật `implementation-status.md` sau mỗi đợt làm | **Cần thêm** (flow ghi nhưng chỉ đụng `docs/`) |

Rút ra: với NeoMind, các workflow **#1–#3, #6** đã đủ khung và chỉ cần làm cho chắc. Phần còn thiếu thật nằm ở #9–#12, và chúng đều cần **timer/sự kiện** cùng một **loại flow chỉ đọc có đầu ra là báo cáo**.

## 3. Chạy ổn định

| Kiểu lỗi | Bằng chứng | NeoMind hiện tại | Đề xuất |
| --- | --- | --- | --- |
| **Lặp/kẹt trong một bước** (đọc lại cùng file, sửa lỗi lặp) | SWE-smith: chuỗi lặp dài gắn chặt với thất bại; hơn nửa số run không giải được kết thúc vì chạm giới hạn chi phí/bước, thường trước khi sửa code. OpenHands có `StuckDetector` bật mặc định: lặp hành động–kết quả 4 lần, hành động–lỗi 3 lần, độc thoại 3 lần, lặp xen kẽ 6 chu kỳ | Chỉ OpenCode có 60 lượt; `maxTokens` kiểm **giữa các bước**; `activeTimeSeconds` cho cả run | **Watchdog chung** dùng luồng sự kiện của runner: cùng tool + cùng tham số ≥ N lần; M lượt liên tiếp không đọc file mới và không ghi gì; token của bước vượt ngưỡng mềm. Hành động: dừng bước, chuyển run sang `paused` với lý do `stalled`, ghi bằng chứng (các lời gọi lặp) vào journal |
| **Chi phí khó đoán** | Anthropic: agent tự trị nghĩa là "chi phí cao hơn và lỗi cộng dồn" | `maxTokens` của run là tùy chọn; ước tính từ `run stats` | **Trần token cho từng bước** (mặc định theo vai trò: plan/review thấp, implement cao), kiểm trong lúc bước đang chạy. Preview hiện ước tính p50/p90 theo flow |
| **Báo xong sớm, sửa test cho qua** | Harness của Anthropic; ImpossibleBench; DGM | Review độc lập + checks | Rule mặc định "không sửa/xóa test để qua"; check tất định gắn cờ khi diff xóa assertion hoặc file test; cho agent lối ra `blocked` hợp lệ (outcome này đã có) |
| **Test chập chờn đầu độc vòng sửa** | Agent coi lỗi ngẫu nhiên là bug thật rồi "sửa" (?) | Checks lỗi thì tiêu một vòng sửa | Check lỗi thì **chạy lại một lần**; lần hai qua thì ghi `flaky` vào journal, không tiêu vòng sửa, báo người; thống kê ca chập chờn theo tên test |
| **Lỗi tạm thời** (429, 5xx, process chết) | Temporal: activity chạy *ít nhất một lần*, retry có backoff và danh sách lỗi không retry; LLM gọi lại có thể ra kết quả khác nên phải lấy kết quả đã ghi cho bước đã xong | Journal + recovery; resume từ checkpoint | Phân loại lỗi runner thành *retry được* / *không*; retry có backoff ở ranh giới bước, có giới hạn; không retry bước đã có kết quả trong journal |
| **Bất định giữa các lần chạy** | τ-bench: GPT-4o pass^1 ~61% nhưng pass^8 < 25% ở retail. Anthropic phân biệt pass@k (thử nhiều lần, chỉ cần một lần đạt) với pass^k (lần nào cũng phải đạt) | `run stats` mỗi run một mẫu | Đo flow bằng **pass^k trên golden tasks** (k = 3), không dựa vào một run |
| **Context mục ("context rot")** | Anthropic context engineering: recall giảm khi context dài; dùng compaction, xóa kết quả tool cũ, ghi chú ngoài context, agent con trả bản tóm tắt 1–2k token | Session group; memory theo vai trò | Bước khám phá có trần; bàn giao gồm plan + quyết định + diff (đã nêu ở tài liệu chip) |
| **Khó quan sát** | OpenTelemetry GenAI: span `invoke_agent` → `chat` → `execute_tool`, token `gen_ai.usage.*`; spec còn ở trạng thái development | Journal + transcript + activity feed | Xuất journal ra dạng OTel (tùy chọn) sau; trước mắt UI hiện số lượt và token **theo bước** để thấy lặp ngay khi đang chạy |

Nguyên tắc chung: **phát hiện bằng code tất định, xử lý bằng cách dừng và báo.** Không để một LLM tự quyết có đang lặp hay không, vì việc đó tốn token và cũng có thể lặp.

## 4. Tự sửa lỗi và tự nâng cấp

### 4.1 Cái gì chạy được, cái gì không

| Hướng | Bằng chứng | Bài học cho NeoMind |
| --- | --- | --- |
| Reflexion (tự phản tư, lưu bài học dạng chữ) | 91% pass@1 HumanEval (GPT-4 gốc 80%) nhưng **dựa vào test thật**; bộ nhớ chỉ 1–3 trải nghiệm (?) | Bài học chỉ đáng tin khi gắn với tín hiệu thật (check, review) |
| Self-repair | Olausson et al. ICLR 2024: tính cả chi phí thì lợi ích khiêm tốn, có khi không bằng sinh lại từ đầu; nút thắt là chất lượng phản hồi; **phản hồi từ model mạnh hơn hoặc từ người** giúp nhiều hơn hẳn | Vòng sửa dùng phản hồi của reviewer/checks (đã vậy); cho phép nâng model ở vòng sửa thứ hai; giữ ít vòng |
| Agent Workflow Memory | Rút "workflow" từ các lần chạy thành công: +24,6% Mind2Web, +51,1% WebArena (tương đối), ít bước hơn | Rút quy trình từ run thành công thành **đề xuất skill** |
| Voyager | Thư viện skill dạng code, chỉ thêm skill sau khi **tự kiểm chứng** đạt | Skill mới chỉ được đề xuất khi run gốc đã qua review + checks |
| AFlow / ADAS / GEPA (tối ưu workflow, prompt tự động) | AFlow: +5,7% trung bình trên 6 benchmark nhờ tìm kiếm MCTS trên workflow dạng code. GEPA: tiến hóa prompt từ trace bằng chữ, cần ít rollout hơn RL nhiều lần (?); model phản tư nhỏ thì không cải thiện được (?) | Đều cần **bộ đánh giá có điểm** và nhiều lần chạy. Với quota cá nhân, chỉ làm offline trên golden tasks nhỏ, ưu tiên fake runner |
| SICA, Darwin Gödel Machine (agent tự sửa code của mình) | SICA: 17% → 53% trên tập con 50 bài SWE-bench Verified, tốn nhiều; có LLM giám sát song song (?). DGM: agent **xóa marker** dùng để phát hiện ảo giác tool, đạt điểm mà không giải được vấn đề | Thứ được tối ưu không bao giờ được sửa evaluator của chính nó |

### 4.2 Rủi ro

- **Reward hacking / sửa test:** đã có bằng chứng ở mức benchmark (ImpossibleBench, DGM).
- **Trôi dần (drift):** mỗi đề xuất nhỏ đều hợp lý nhưng cộng lại thì làm flow phình hoặc lỏng dần. Policy sàn giữ được phần cứng nhất, phần còn lại cần số liệu trước/sau.
- **Overfit vào bộ đánh giá nhỏ:** 5–10 golden task dễ bị "học thuộc".
- **Memory bị đầu độc:** lesson sai được duyệt vội sẽ đi vào mọi run sau.
- **Chi phí:** mỗi vòng thử một phiên bản là k run thật.

### 4.3 Thiết kế an toàn cho NeoMind (4 mức)

| Mức | Làm gì | Tự động? | Cổng |
| --- | --- | --- | --- |
| **L0 · Trong run** | Retry lỗi tạm thời; vòng sửa từ phản hồi checks/review; watchdog dừng khi lặp; chạy lại check chập chờn | Có, trong giới hạn của flow | Policy sàn, `maxRepairRounds`, trần token |
| **L1 · Chẩn đoán sau run** | Bước chỉ đọc, model rẻ: phân loại kết cục (lặp, chập chờn, plan sai, review trượt theo rule nào, vượt ngân sách), gắn vào hồ sơ run | Có | Không ghi gì ngoài journal |
| **L2 · Đề xuất** | Lesson/memory (đã có), **skill** rút từ run thành công (AWM/Voyager), **phiên bản flow mới** (thêm check, đổi model ở bước hay hỏng, giảm trần), **rule mới** khi lỗi lặp ≥ N lần | Sinh tự động sau mỗi N run hoặc khi gọi | **Người duyệt** từng đề xuất |
| **L3 · Triển khai có cổng** | Flow ứng viên chạy trên **golden tasks** (fake runner trước, rồi k run thật nhỏ), so pass^k, token, thời gian với bản hiện hành; sau đó chạy song song (A/B) trên việc thật; rollback = chọn lại version cũ có hash | Đánh giá tự động | Người chọn publish; **không bao giờ** tự đổi bản mặc định |

Những thứ vòng tự cải tiến **không được chạm**: policy sàn, yêu cầu review độc lập, lệnh checks, bộ golden tasks và cách chấm (lưu tách riêng, sửa phải do người commit), và code của chính NeoMind. Nếu muốn NeoMind "tự nâng cấp code" thì việc đó đi qua đúng một run Dev bình thường trên repo NeoMind, có duyệt plan và review như mọi thay đổi khác.

## 5. Timer / tự khởi động

### 5.1 Các sản phẩm đang làm thế nào

| Sản phẩm | Cách làm đáng mượn |
| --- | --- |
| Claude Code Desktop (task cục bộ) | Chỉ chạy khi app mở và máy thức. Kiểm lịch mỗi phút, mỗi task lệch vài phút cố định. **Lỡ lịch thì chạy bù đúng một lần cho lần lỡ gần nhất trong 7 ngày**, bỏ các lần cũ hơn. Lịch sử ghi cả lần *bị bỏ qua* kèm lý do (máy ngủ, run trước chưa xong, đang có task khác chạy). Mỗi run có thể dùng worktree riêng. Run có thể kẹt ở prompt xin quyền |
| Claude Code cloud scheduled task | Trigger theo lịch, API hoặc sự kiện GitHub. Lịch tối thiểu 1 giờ. Trần 100 run lịch/giờ cho mỗi tài khoản. Chỉ push lên nhánh `claude/` |
| `/loop` của Claude Code | Gắn với session. Task lặp **tự hết hạn sau 7 ngày** để chặn vòng lặp bị bỏ quên. Không chạy bù |
| Kubernetes CronJob | `concurrencyPolicy: Allow/Forbid/Replace`; `startingDeadlineSeconds` giới hạn việc chạy bù; lỡ quá 100 lần thì ngừng lập lịch, và không có cảnh báo |
| GitHub Actions `schedule` | Có thể trễ hoặc bị **bỏ im lặng** khi tải cao (nhất là đầu giờ); nên có job kiểm "job hằng ngày có thực sự chạy không" (?) |
| Devin / Factory | Automation = trigger (lịch, Slack, GitHub, webhook) + prompt. Devin giữ ghi chú giữa các lần chạy |
| GitHub Agentic Workflows | Workflow viết bằng Markdown + frontmatter, biên dịch ra Actions. Agent chỉ đọc; thao tác ghi đi qua "safe outputs" có giới hạn số lượng |

### 5.2 Thiết kế tối thiểu đề xuất cho NeoMind

**Nơi chạy.** Lịch nằm ở core, không phụ thuộc giao diện:

- `neomind/schedules.json` nằm trong repo, để định nghĩa job đi theo project. Trạng thái bật/tắt và lịch sử fire nằm ở thư mục state của máy (`%LOCALAPPDATA%\neomind\<project-key>`), vì máy nào bật lịch là chuyện riêng của máy đó.
- Lệnh **`neomind schedule tick <project>`** tính job đến hạn rồi khởi động run. Lệnh idempotent: mỗi lần fire có khóa `scheduleId + slot` ghi vào SQLite, nên gọi trùng không tạo run thứ hai.
- Bộ gọi tick:
  - **Windows Task Scheduler** (đăng ký bằng `neomind schedule install`, tick mỗi 5–15 phút, chạy cả khi Nimbalyst đóng);
  - **systemd user timer** trên Linux;
  - editor server và backend extension Nimbalyst cũng tick khi đang mở.
  - Nimbalyst có extension automations (?), chưa kiểm khả năng; nếu dùng được thì chỉ là thêm một bộ gọi tick.
- Không dùng GitHub Actions: NeoMind chạy cục bộ trên quota cá nhân và cần worktree/journal trên máy.

**Chính sách** (giá trị mặc định):

| Mục | Mặc định | Lý do |
| --- | --- | --- |
| Chồng nhau | `forbid`: run trước của cùng job chưa xong thì bỏ lần này, ghi `skipped: previous_running` | Run AI dài và tốn; `replace` sẽ vứt bỏ công đã trả tiền |
| Lỡ lịch | `catch_up_once` trong cửa sổ (mặc định 24 giờ), bỏ các lần cũ hơn; tùy chọn `skip` | Giống Claude Desktop; tránh dồn N run khi máy thức dậy |
| Song song | Tôn trọng `maxConcurrency` của project; run hẹn giờ xếp sau run của người | Người đang làm việc được ưu tiên |
| Quota | Job **phải** có `maxTokens`; thêm trần token/ngày cho mọi run hẹn giờ của project; vượt trần thì bỏ qua và báo | Một job lặp không được tiêu quota của cả tuần |
| Giờ yên | `quietHours` tùy chọn; ngoài giờ cho phép thì hoãn tới khung kế tiếp | Tránh đụng giờ dùng máy hoặc giờ quota đắt |
| Tự hết hạn | Job tạo bởi AI (qua session tool) hết hạn sau 7 ngày nếu người không xác nhận giữ | Học từ `/loop`; chặn lịch bị quên |
| Lịch sử | Mỗi lần fire, bỏ qua hoặc lỗi đều ghi kèm lý do; UI có danh sách job + lần chạy | Không có lỗi im lặng như CronJob hay Actions |

**Một run hẹn giờ được tự làm gì khi không có người:**

- **Flow chỉ đọc** (báo cáo, review diff, phân loại test chập chờn, kiểm dependency): chạy tới cuối. Đầu ra là báo cáo trong journal/file, thông báo (Nimbalyst `notify_user` hoặc toast Windows), và **đề xuất** memory/skill chờ duyệt.
- **Flow ghi code:** chạy tới plan rồi **dừng ở cổng duyệt** và báo người, kể cả flow có `approval.mode: auto`, trừ khi project bật riêng `schedule.allowAutoApproval`. Khi bật thì vẫn bắt buộc worktree cô lập, review độc lập, checks, và chỉ commit local. Policy sàn giữ nguyên.
- **Không bao giờ:** push, xóa nhánh, áp vào checkout đang dùng, duyệt đề xuất memory.

**Sự kiện (sau timer):** git hook `post-commit`/`post-merge` gọi `neomind trigger <project> --event commit`, gộp các sự kiện gần nhau (debounce vài phút) để 10 commit liên tiếp chỉ sinh một run. Lỗi CI có thể phát hiện bằng cách tick gọi `gh run list` (tất định, không tốn token), chỉ khởi động agent khi có lỗi mới.

**Phụ phẩm hữu ích:** một job lưu sẵn runner/model cho từng binding, tức là có **preset run**. Cùng cơ chế này giải luôn vấn đề "phải chọn lại model mỗi run" khi người khởi động tay.

## 6. Ẩn dụ vi điều khiển: đánh giá thẳng thắn

Một lệnh MCU mất vài nano giây, tất định và gần như miễn phí. Một "lệnh" của NeoMind mất vài chục giây tới vài phút, tốn từ vài nghìn tới vài trăm nghìn token, và chạy lại thì ra kết quả khác. Chênh lệch khoảng 10⁹ lần về thời gian và chi phí nên chỉ những ý tưởng *về cấu trúc* là mang sang được, còn ý tưởng *về tốc độ* thì không.

| Mang sang được | Vì sao | Lưu ý khi chuyển |
| --- | --- | --- |
| Watchdog | Phát hiện kẹt là việc tất định, rẻ | Phản ứng là **dừng và báo**, không reset rồi chạy lại, vì mỗi lần chạy lại tốn tiền |
| Journal / trace / flight recorder | Đã chứng minh giá trị (resume, review, stats) | Replay chỉ là **đọc lại**; chạy lại bước là thí nghiệm mới |
| Brown-out detector | = trần token theo bước/run/ngày, mức quota | Cần kiểm *trong* bước, không chỉ giữa các bước |
| MPU / option bytes | = policy sàn, quyền read/write | Giữ nguyên |
| RTC + ngủ sâu | = scheduler; giữa các lần chạy **không có LLM nào thức** | Việc thăm dò (poll) do code tất định làm, chỉ đánh thức agent khi có thay đổi |
| Image có checksum, A/B firmware | = flow version có hash, rollback | Nền cho L3 ở mục 4 |

| Không mang sang được | Vì sao |
| --- | --- |
| Vòng điều khiển nhanh (PID) | Mỗi vòng tốn phút và đô-la, sai số mỗi vòng lớn. Vòng có setpoint chỉ hợp khi ít vòng (≤ 3) và điều kiện dừng do code tất định đo |
| Ngắt độ trễ micro-giây, nhiều handler | Sự kiện phải được gộp và lọc trước; handler gọi LLM là "ngắt" tốn vài phút, nên phần lớn handler phải là code thường (thông báo, dừng) |
| Nhiều bước nhỏ (ISA mịn) | Mỗi bước có chi phí cố định lớn (nạp context, khám phá lại repo). Ít bước lớn có bàn giao tốt thường rẻ hơn nhiều bước nhỏ |
| Lockstep / dự phòng nhiều kênh mọi lúc | k reviewer = k lần chi phí; chỉ dùng cho việc rủi ro cao |
| Thực thi tất định, "chạy lại cho chắc" | Cùng input ra output khác; thay bằng thống kê pass^k |

Kết luận: giữ ẩn dụ như một danh mục kiểm tra ("máy tử tế cần watchdog, trace, brown-out, MPU"), nhưng thiết kế theo nguyên tắc **"vỏ tất định, lõi xác suất"**. Thời gian, ngân sách, phát hiện lặp, retry, lập lịch và cổng duyệt đều là code; LLM chỉ làm plan, viết code, review và chẩn đoán.

## 7. Đề xuất lộ trình

1. **Watchdog "không tiến triển" + trần token theo bước cho cả ba runner.** Dùng luồng sự kiện tool đã có (activity feed); ngưỡng mặc định lấy theo OpenHands rồi chỉnh theo dữ liệu.
   *Xong khi:* có test bằng fake runner tái hiện kịch bản 11/11 (đọc lặp cùng file); bước bị dừng trong ≤ 10 lượt lặp hoặc chạm trần token của bước; run chuyển `paused` với lý do `stalled` kèm bằng chứng trong journal, UI hiện được; trần token theo vai trò có giá trị mặc định trong template; `npm test` xanh.
2. **Preset run + checks chịu được test chập chờn.** Lưu runner/model/reasoning theo flow để run sau dùng lại. Check lỗi thì chạy lại một lần, ghi `flaky` mà không tiêu vòng sửa.
   *Xong khi:* khởi động lại cùng flow không phải chọn model; test fake check "lỗi rồi qua" cho kết quả `flaky` trong journal và `run stats` đếm được theo tên check.
3. **Scheduler tối thiểu** (mục 5.2): `schedules.json`, `schedule tick` idempotent, `schedule install` cho Task Scheduler/systemd, `forbid` + `catch_up_once` + trần token/ngày, flow ghi dừng ở cổng plan. Job đầu tiên: **báo cáo test chập chờn hằng đêm cho chính repo NeoMind**, chỉ đọc.
   *Xong khi:* có test cho tick gọi trùng (một run), lỡ lịch (chạy bù đúng một lần), chồng nhau (ghi `skipped`), vượt quota (bỏ và báo); job thật chạy ≥ 5 đêm liên tiếp trên Windows, có báo cáo, không có run chồng nhau.
4. **Golden tasks + `neomind eval`.** 5–10 task cố định trên `leetcode-practice` và repo NeoMind, chấm bằng checks và rule, lưu tách riêng và chỉ người sửa. Lệnh so hai version flow theo pass^k (k = 3), token và thời gian; chạy fake runner mặc định, run thật phải bật rõ.
   *Xong khi:* có báo cáo so sánh Dev và Fast trên bộ golden, ghi kết quả vào `implementation-status.md`.
5. **Chẩn đoán sau run + đề xuất có cổng** (L1–L3 ở mục 4.3): phân loại kết cục, đề xuất skill/flow version/rule từ ≥ N run, ứng viên phải qua `eval` trước khi hiện cho người duyệt.
   *Xong khi:* ít nhất một đề xuất flow version được sinh từ dữ liệu thật, chạy `eval`, được người duyệt hoặc từ chối qua UI/tool; không có đường nào để đề xuất sửa policy sàn, golden tasks hay checks.

## 8. Nguồn

- Anthropic, Building effective agents: https://www.anthropic.com/engineering/building-effective-agents
- Anthropic, Effective context engineering for AI agents: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Anthropic, Effective harnesses for long-running agents: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- Claude Code best practices: https://code.claude.com/docs/en/best-practices
- Claude Code scheduled tasks (`/loop`): https://code.claude.com/docs/en/scheduled-tasks
- Claude Code cloud scheduled tasks (routines): https://code.claude.com/docs/en/routines
- Claude Code Desktop scheduled tasks: https://code.claude.com/docs/en/desktop-scheduled-tasks
- Demystifying evals for AI agents (qua tóm tắt thứ cấp (?)): https://snowan.gitbook.io/study-notes/ai/ai-resources-1/evals/anthropic-demisfy-ai-evals
- OpenAI, A practical guide to building agents (qua tóm tắt (?)): https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf
- Cognition, Don't build multi-agents: https://cognition.ai/blog/dont-build-multi-agents
- Cognition, Multi-agents: what's actually working: https://cognition.com/blog/multi-agents-working
- Cognition, Devin can now schedule Devins: https://cognition.com/blog/devin-can-now-schedule-devins
- Devin scheduled sessions / automations: https://docs.devin.ai/product-guides/scheduled-sessions
- Factory automations: https://docs.factory.ai/software-factory/automations
- GitHub Copilot coding agent: https://docs.github.com/copilot/concepts/coding-agent/about-copilot-coding-agent
- GitHub Agentic Workflows: https://github.github.com/gh-aw/ và https://github.blog/ai-and-ml/github-copilot/automate-repository-tasks-with-github-agentic-workflows/
- Codex automations (?): https://openai.com/academy/codex-automations
- SWE-agent: https://arxiv.org/abs/2405.15793
- SWE-smith: https://arxiv.org/pdf/2504.21798
- OpenHands stuck detector: https://docs.openhands.dev/sdk/guides/agent-stuck-detector
- Agentless: https://arxiv.org/abs/2407.01489
- Aider architect/editor: https://aider.chat/2024/09/26/architect.html
- τ-bench (pass^k): https://arxiv.org/abs/2406.12045
- Temporal durable agents: https://temporal.io/blog/building-durable-agents-with-temporal-and-ai-sdk-by-vercel
- LangGraph durable execution / interrupts: https://docs.langchain.com/oss/python/langgraph/durable-execution
- OpenTelemetry GenAI agent spans: https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans
- Reflexion: https://proceedings.neurips.cc/paper_files/paper/2023/hash/1b44b878bb782e6954cd888628510e90-Abstract.html
- Is self-repair a silver bullet: https://arxiv.org/abs/2306.09896
- Agent Workflow Memory: https://arxiv.org/abs/2409.07429
- Voyager: https://arxiv.org/abs/2305.16291
- AFlow: https://arxiv.org/abs/2410.10762
- ADAS: https://arxiv.org/abs/2408.08435
- GEPA (?): https://www.emergentmind.com/papers/2507.19457
- A Self-Improving Coding Agent (SICA): https://arxiv.org/abs/2504.15228v2
- Darwin Gödel Machine: https://arxiv.org/pdf/2505.22954 ; The Register: https://www.theregister.com/2025/06/02/self_improving_ai_cheat/
- ImpossibleBench: https://arxiv.org/abs/2510.20270v1 (số liệu 54%/9% qua tóm tắt (?))
- Flaky test triage: https://kortix.com/use-cases/flaky-test-triage (?), https://momentic.ai/docs/reliability/auto-maintenance (?), https://skillselion.com/skills/datadog-labs/agent-skills/triage-flaky-test (?)
- Dependency upgrades + agent: https://ona.com/docs/examples/ai-agent-use-cases/fixing-dependencies.md (?), https://docs.fossa.com/docs/fossabot/dependency-upgrades (?), https://arxiv.org/abs/2510.03480
- Kubernetes CronJob: https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/
- GitHub Actions schedule không đáng tin (?): https://runhooks.app/blog/github-actions-scheduled-workflows-unreliable/
