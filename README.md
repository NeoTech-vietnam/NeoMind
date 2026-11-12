# NeoMind

NeoMind cấu hình và chạy agent flows, với kế hoạch cần duyệt, kiểm tra độc lập và memory dùng chung theo project.

Hiện đã chạy end-to-end trong worktree riêng (khảo sát → duyệt kế hoạch → thực hiện → checks → review → commit local) với **Codex và Claude Code**, trên Windows native (xem [Windows](START-HERE-WINDOWS.md)); trên Linux mới kiểm chứng đường Codex (29/10). Có flow Fast, Research, Dev song song, xem agent làm gì theo thời gian thực, và [extension Nimbalyst](docs/adaptive-agent-flow/nimbalyst-extension.md) để start flow từ mọi session. Đây là bản đang phát triển.

Người (hoặc agent) mới tiếp tục phát triển: đọc [AGENTS.md](AGENTS.md), rồi [bàn giao 30/10/2026](docs/adaptive-agent-flow/session-handoff-2026-10-30.md) và [tiến độ hiện tại](docs/adaptive-agent-flow/implementation-status.md). [Thiết kế v1](docs/adaptive-agent-flow/design-v1.md) vẫn là phạm vi mục tiêu.

## Chạy Flow Studio

Cần Node >=22.16, Codex CLI đã đăng nhập và một cơ chế worker scope: Linux user-systemd, hoặc Windows job objects (cần .NET Framework 4 có sẵn trên Windows 10/11 để biên dịch helper lần đầu). Runtime đã được thử với Node 22.22.1 và Codex CLI 0.165.0 trên Linux; Node 24.18.0 và Codex CLI 0.160.1 trên Windows 11.

```bash
npm ci
npm test
npm run build:ui
npm run neomind -- editor /absolute/path/to/project
```

Mở URL localhost được in ra. Editor hỗ trợ canvas kéo thả, flow/profile drafts và versions, model/reasoning, theo dõi run, duyệt kế hoạch, yêu cầu sửa kế hoạch, pause/resume/cancel, thử lại Git, memory và duyệt lessons. Publish flow trước khi chạy bản chỉnh sửa. Preview hiển thị cấu hình thực tế và chặn graph chưa được executor hỗ trợ.

Mặc định standalone dùng `gpt-6-luna` reasoning `low`; có thể chọn `gpt-6.1-sol` hoặc `gpt-6.1-terra` khi runner cung cấp. Không tự chuyển model ngoài danh sách fallback đã cấu hình. Chạy thật sử dụng quota tài khoản Codex.

## Cấu hình project lần đầu (`neomind init`)

```bash
npm run neomind -- init /absolute/path/to/project            # neomind/, neomind/project.json, skill soạn flow ở .agents/skills và .claude/skills, tham chiếu trong AGENTS.md
npm run neomind -- init /absolute/path/to/project --force    # ghi đè skill hướng dẫn (bản nào đã bị sửa) bằng bản hiện tại; không đụng AGENTS.md
```

Agent chỉ thấy mô tả của skill và tự quyết có đọc hay không, nên `init` (và lần tự cài skill đầu tiên nói bên dưới) còn đảm bảo `AGENTS.md` ở gốc project có đúng mục:

```markdown
## References

- Authoring NeoMind flows: read .claude/skills/neomind-flow-authoring/SKILL.md first.
```

File đã có dòng nào nhắc `neomind-flow-authoring/SKILL.md` (ở `.claude/skills`, `.agents/skills` hay thư mục khác) thì giữ nguyên từng byte (in `đã có tham chiếu skill, giữ nguyên`). Chưa có thì nối vào cuối (thêm gạch đầu dòng vào cuối mục `## References` nếu đã có mục đó), giữ kiểu xuống dòng CRLF/LF và encoding của file; chưa có `AGENTS.md` thì tạo file chỉ gồm mục trên. Nếu lúc đó project chỉ có `CLAUDE.md` thì dòng tham chiếu cũng được nối vào `CLAUDE.md`, trừ khi nó đã import `@AGENTS.md` hoặc đã nhắc tới skill. NeoMind chỉ nối thêm, không bao giờ ghi đè nội dung của người dùng, kể cả với `--force`; `AGENTS.md`/`CLAUDE.md` là symlink thì từ chối. Các tool session soạn flow, agent và skill (`flow_draft`, `flow_validate`, `flow_publish`, `flow_pin_bindings`, `profile_draft`, `profile_publish`, `skill_create`, `skill_update`) cũng nhắc agent đọc skill trước.

`init` tạo `neomind/` (project cũ dùng `.neomind/` thì giữ chỗ đó), ghi `neomind/project.json` với đúng các giá trị mặc định mà NeoMind vẫn dùng khi chưa có file (nên hành vi project không đổi, chỉ hiện ra để sửa), và cài skill [`neomind-flow-authoring`](.claude/skills/neomind-flow-authoring/SKILL.md) vào hai chỗ của project để agent biết các ràng buộc runtime trước khi soạn flow: `.agents/skills/neomind-flow-authoring/SKILL.md` (quy ước dùng chung của chuẩn mở [Agent Skills](https://agentskills.io), Codex và OpenCode quét thư mục này) và `.claude/skills/neomind-flow-authoring/SKILL.md` (Claude Code). Hai bản cùng nội dung, là file thật (không symlink), và mỗi bản có trạng thái riêng: bản đã bị sửa được giữ (in `đã bị sửa, giữ nguyên`) trong khi bản kia vẫn được tạo; `--force` ghi đè cả hai. Project đã cài skill ở `.claude/skills` từ trước thì chạy `init` lại sẽ thêm bản `.agents/skills`, không cần `--force`. Chạy lại không đổi gì: thư mục và `project.json` đã có được giữ nguyên. Không chạy `init` cũng được: lần ghi đầu tiên tạo `neomind/` (flow, agent, skill, chương trình, memory hoặc cấu hình đầu tiên) tự cài skill một lần; repo chỉ được đọc hoặc preview thì không có gì được ghi, và repo đã có `neomind/` thì phải chạy `init` mới có bản `.agents/skills`. Xóa skill sau đó thì NeoMind không cài lại. Cùng hàm core có ở API `POST /api/project/init` (`{ "force": true }` tùy chọn) và tool session `neomind_project_init` (`force` cần `confirmed: true`). Bản skill NeoMind mang theo được sinh từ `.claude/skills/neomind-flow-authoring/SKILL.md` trong repo này bằng `node scripts/sync-project-guide.mjs`, script này cũng chép sang `.agents/skills/neomind-flow-authoring/SKILL.md` (bản duy nhất trong `.agents/` được commit; phần còn lại do Nimbalyst sinh và bị ignore); test báo lỗi khi các bản lệch nhau.

## AI tạo và chọn flow

NeoMind có thể đề xuất flow bằng quy tắc tĩnh, tạo bản nháp, kiểm policy và so sánh trước khi lưu phiên bản. Các lệnh sau nhận **thư mục project**; `draft.json` là input authoring, ví dụ `{"flowId":"my-dev","name":"My Dev","from":{"template":"dev"}}`.

```bash
npm run neomind -- assess /project "nghiên cứu kiến trúc"
npm run neomind -- assess /project --task-file task.txt
npm run neomind -- flow blocks /project
npm run neomind -- flow author-draft /project draft.json
npm run neomind -- flow get /project my-dev
npm run neomind -- flow author-validate /project my-dev
npm run neomind -- flow diff /project my-dev
npm run neomind -- flow author-publish /project my-dev <revision> "Lý do"
```

Khi sửa draft đã có, input cần `expectedRevision` từ `flow get` hoặc lần lưu trước; khi publish AI cũng cần revision này. `assess.available: false` nghĩa là flow được gợi ý hiện không sẵn sàng; chọn phương án khác hoặc tạo flow. Mỗi phiên bản AI ghi tác giả, session nếu có và lý do; phiên bản cũ không có tác giả được coi là do người lưu. `contentHash` tiếp tục chỉ bao phủ nội dung flow; metadata tác giả không có hash riêng.

`author-validate`, tool `flow_validate`, API validate và nút "Kiểm tra" của Flow Studio kiểm thêm những gì preview sẽ từ chối, không tạo run và không gọi model: binding của từng bước giải ra runner/provider/model/reasoning, runner có trong registry, model nằm trong allowlist, profile có phiên bản đã publish và đủ quyền, skill ghim còn tồn tại. Diagnostic có `severity: "warning"` (skill đã đổi, yêu cầu chạy lệnh ở runner không có shell, "UTF-8 without BOM", flow chỉ đọc nhưng đòi ghi file) không chặn publish; lỗi thì chặn. Luật soạn flow mới chỉ áp khi validate/publish, nên phiên bản đã publish trước đó vẫn chạy.

Trong `neomind/project.json`, trường tùy chọn `ai.flowPublish` nhận `allow` (mặc định), `draft-only` hoặc `deny`. `draft-only` cho AI sửa draft nhưng không publish; `deny` chặn cả tạo/sửa draft bằng tool AI. Project có thể đặt `policy.maxActiveTimeSeconds` tùy chọn: thời gian flow AI publish không vượt giá trị nhỏ hơn giữa trần này và mẫu Dev (1.800 giây). Policy sàn về duyệt và review vẫn được compiler kiểm; flow do người lưu giữ hành vi trước đây. `ai.profilePublish` áp dụng tương tự cho profile (xem mục dưới).

### Nhân bản run và lưu agent mặc định cho flow

Mỗi run (kể cả đang chạy) có **Nhân bản** trong menu "…" của danh sách và ở màn chi tiết. Nút mở Run mới đã điền sẵn flow, yêu cầu (sửa được), runner/provider/model/mức suy luận từng bước theo đúng binding run đó đã dùng (kể cả lựa chọn fallback), giới hạn (thời gian, token, vòng sửa, số agent đồng thời) và workspace. Cấu hình áp lên **phiên bản mới nhất** của flow: chỉ giá trị khác mặc định của flow mới thành override; bước không còn trong flow bị bỏ và được nêu tên; vòng sửa và số agent đồng thời không vượt mức flow cho phép; model không còn khả dụng vẫn giữ để preview báo. Nhân bản không tự bắt đầu run và không tự duyệt.

Khi đã đổi agent của một bước, Run mới hiện **Lưu làm mặc định cho flow**: ghi các giá trị đó dạng `pinned` vào binding của phiên bản publish mới nhất rồi publish phiên bản mới (tác giả người dùng); lần sau chọn flow đó đã có sẵn lựa chọn. Bước dùng chung binding (thường cùng session, như Lập kế hoạch và Thực hiện của Dev) đổi theo nhau; chọn khác nhau cho chúng thì không lưu được. Flow có thay đổi chưa publish trong bản nháp bị từ chối để không publish lẫn. Template có sẵn không sửa được nên nút thành **Lưu thành flow mới…**: hỏi tên, tạo flow project từ template với binding đã ghim, publish và chọn nó cho run.

```bash
npm run neomind -- flow pin-bindings /project my-dev values.json            # {"implement":{"runner":"claude-code","provider":"anthropic","model":"claude-opus-5-5","reasoning":"high"}}
npm run neomind -- flow pin-bindings /project dev values.json --save-as "Dev Opus"
```

API `POST /api/flows/:id/pin-bindings` (`values`, `expectedRevision?`, `saveAs?: { name, flowId? }`); tool session `flow_pin_bindings` theo cùng policy `ai.flowPublish` như `flow_publish` và cần `expectedRevision` từ `flow_get` khi sửa flow có sẵn.

## Skills và profile

Skill của project là thư mục `neomind/skills/<id>/SKILL.md` (sửa trong NeoMind), `.agents/skills/<id>/SKILL.md` (chuẩn Agent Skills, dùng chung với Codex/OpenCode) hoặc `.claude/skills/<id>/SKILL.md` (Claude Code); hai nguồn sau chỉ đọc trong NeoMind nhưng ghim được vào agent và bước như skill khác. Cùng một ID có ở nhiều nguồn thì danh mục chỉ đưa ra một bản theo thứ tự `neomind` > `.agents` > `.claude`, các bản còn lại nằm trong `shadowed` và màn Skills cảnh báo (cùng hay khác nội dung). Ghim lưu đường dẫn nên ghim cũ tới bản `.claude` vẫn chạy như trước. Thư mục skill là symlink thì không được liệt kê, và đường dẫn ra ngoài project bị từ chối. Frontmatter `name`, `description` chỉ để hiển thị. Profile ghim skill bằng SHA-256; khi file đổi, trạng thái là `changed` (nút "Ghim lại" trong Profiles › Skills cập nhật sha của draft), mất file là `missing` và run sẽ từ chối bắt đầu như trước. Prompt đưa nội dung `SKILL.md` với nhãn `Skill <name> (<id>):` và chỉ liệt kê đường dẫn các file phụ trong thư mục skill.

```bash
npm run neomind -- skills /project
npm run neomind -- skills status /project refs.json
npm run neomind -- profile get /project my-profile
npm run neomind -- profile version /project my-profile 1
npm run neomind -- profile skills-status /project my-profile
npm run neomind -- profile usage /project my-profile
npm run neomind -- profile migrate /project my-profile 2 selection.json   # [{"flowId":"dev-x","expectedRevision":"…"}]
npm run neomind -- profile author-draft /project input.json              # {"profileId":"p","name":"P","from":{"profileId":"implementer"}}
npm run neomind -- profile author-publish /project my-profile <revision> "Lý do"
```

`profile migrate` chỉ sửa **draft** của các flow được chọn sang phiên bản profile mới (so revision từng flow); không publish flow. `ai.profilePublish` (`allow` mặc định, `draft-only`, `deny`) giới hạn tool AI như `ai.flowPublish`.

### Soạn skill và agent (11/11/2026)

Màn **Skills** (thanh điều hướng: Runs · Flows · Agents · Skills · Memory) tạo, sửa và xóa skill trong `neomind/skills/<id>/` theo chuẩn Claude (`SKILL.md` gồm frontmatter `name`, `description` và thân Markdown) cùng các file phụ dạng text. Skill trong `.agents/skills` và `.claude/skills` chỉ đọc (`--source agents|claude` ở CLI, `?source=` ở API, `source` của tool `skill_get`/`skill_usage`). Lưu skill phải khớp SHA-256 đã đọc (chống ghi đè). Sau khi sửa một skill đang được ghim, màn Skills báo số agent/bước còn ghim bản cũ; **Ghim lại tất cả** cập nhật sha trong **draft** của các agent và flow (không publish). Xóa skill đang được dùng bị từ chối kèm danh sách nơi dùng; người dùng xác nhận thì xóa được (`force`). **Xem đoạn chèn vào prompt** hiện đúng văn bản run đưa vào prompt.

Màn **Agents** (tên mới của Profiles; code và API vẫn dùng `profile`): tạo agent từ mẫu (Implementer, Planner, Reviewer độc lập, Reviewer UI, Reviewer bảo mật, Research chỉ đọc; skill gợi ý chỉ được ghim khi project có skill cùng ID); nút **Lưu** lưu draft và publish phiên bản mới, rồi đề nghị **Cập nhật các flow** còn dùng bản cũ (chỉ sửa draft flow). Agent còn được flow dùng thì không xóa được, chỉ lưu trữ.

Flow Studio: mục **Skills** nằm ở phần chính của inspector cho agent task, từng reviewer và bước tích hợp có agent, với hai chế độ **Theo agent** (skill của phiên bản agent) và **Riêng cho bước này** (ghi `skillsOverride`, thay toàn bộ skill của agent ở bước đó). Thẻ bước hiện “N skill”; Run mới liệt kê skill từng bước sẽ nhận.

```bash
npm run neomind -- skill list /project
npm run neomind -- skill get /project review [--source claude]
npm run neomind -- skill create /project input.json        # {"id":"review","name":"Review","template":"review-checklist"}
npm run neomind -- skill update /project review change.json # {"expectedSha256":"…","body":"…"}
npm run neomind -- skill usage /project review
npm run neomind -- skill repin /project review
npm run neomind -- skill delete /project review [--force]
npm run neomind -- profile templates
npm run neomind -- profile from-template /project ui-review "Reviewer UI" ui-reviewer
npm run neomind -- profile remove /project ui-review       # từ chối khi flow còn dùng
```

API: `GET /api/skill-library`, `POST /api/skills`, `GET|PUT /api/skills/:id`, `GET /api/skills/:id/usage`, `POST /api/skills/:id/repin`, `POST /api/skills/:id/delete` (409 kèm `usage` khi đang dùng), `GET|PUT|DELETE /api/skills/:id/files/<đường dẫn>`, `GET /api/profile-templates`, `POST /api/profiles/from-template`, `POST /api/profiles/:id/remove|set-archived`. `ai.skillEdit` (`allow` mặc định, `deny`) trong `neomind/project.json` chặn tool AI tạo/sửa/xóa skill; người dùng vẫn sửa trên editor và CLI.

## Chi phí, ngân sách token và thống kê

`limits.maxTokens` (tùy chọn) trong flow hoặc ô "Ngân sách token" ở Run mới › Nâng cao (override khi start) đặt ngân sách token cho run. NeoMind kiểm tổng token sau mỗi bước (lượt agent đang chạy luôn được ghi xong); khi đạt ngân sách, run `paused` với lý do "Hết ngân sách token (đã dùng/ngân sách)". Thêm token rồi tiếp tục trong màn run, bằng tool `extend_time` (`tokens`), API `POST /api/runs/:id/extend_time` `{ tokens }` hoặc CLI:

```bash
npm run neomind -- run extend-time /project <run-id> --tokens 50000        # chỉ thêm token
npm run neomind -- run extend-time /project <run-id> 600 --tokens 50000    # thêm cả thời gian
npm run neomind -- run stats /project [--flow dev] [--json|--csv]
```

`run stats` (API `GET /api/stats?flow=`, tool `stats`) tổng hợp theo flow, profile, runner/model và flow + bộ runner: số run, tỷ lệ hoàn tất/giao, token và thời gian hoạt động (trung bình/trung vị trên run đã xong), số vòng sửa, tỷ lệ review đạt lượt đầu. `run list` có thêm `tokens`. Run mới hiện ước tính thời gian/token (và chi phí) chỉ khi có ≥ 3 run đã xong cùng flow và cùng bộ runner. `assess` dùng thống kê để xếp các phương án khác khi đủ dữ liệu.

Chi phí USD là tùy chọn: tạo `neomind/pricing.json` với giá do bạn tự điền, ví dụ `{ "schemaVersion": 1, "models": { "gpt-6-luna": { "inputPerMTok": 1, "outputPerMTok": 4, "cachedInputPerMTok": 0.1 } } }` (USD mỗi triệu token). Không có file, hoặc thiếu giá của một model đã dùng, thì chỉ hiện token.

## Rules của project

`neomind/rules.md` (commit cùng repo) chứa các rule bắt buộc, mỗi rule một dòng có mã: `- [R1] Không sửa file ngoài phạm vi plan đã duyệt.` Dòng tiêu đề `#` và dòng trống được bỏ qua; dòng khác dạng hoặc mã trùng bị bỏ kèm cảnh báo. Khi tạo run, NeoMind ghim nội dung + hash rule vào run (sửa file sau đó không đổi run đang chạy), đưa rule vào prompt của mọi agent sau instructions của profile với nhãn "Rules của project (bắt buộc)" (khác memory chỉ để tham khảo), và thêm `Rule R1: …` thành tiêu chí bắt buộc của mọi review: thiếu kết luận hoặc vi phạm thì review không đạt. Preview (`Run mới`, tool `preview`) liệt kê rule sẽ áp dụng; chi tiết run hiện kết quả từng rule trong phần Kiểm tra. Flow (kể cả flow AI dựng) không tắt được rule. Project không có `rules.md` chạy như trước.

```bash
npm run neomind -- rules /project      # rule đã đọc và cảnh báo
```

## Chương trình nhiều giai đoạn

Một việc lớn chia thành các giai đoạn, mỗi giai đoạn là một run với flow đã publish (hoặc flow có sẵn). File `neomind/programs/<programId>.json` (nên commit) mô tả `{ schemaVersion: 1, programId, name, goal, phases: [{ id, title, task, flowId, dependsOn: [], runnerOverrides? }] }`. Trạng thái không lưu trong file mà suy ra từ các run có `programId`/`phaseId`: `blocked_by_dependency`, `ready`, `running`, `waiting_user`, `delivered`, `failed`. Giai đoạn chỉ `delivered` khi commit của run đã nằm trong HEAD của checkout (`git merge-base --is-ancestor`), khi thay đổi đã áp dụng vào checkout, khi run không đổi file nào (research), hoặc khi người dùng đánh dấu giao (squash/rebase) kèm ghi chú.

```bash
npm run neomind -- program create /project program.json
npm run neomind -- program list /project
npm run neomind -- program status /project my-program
npm run neomind -- program next /project my-program        # bắt đầu giai đoạn sẵn sàng đầu tiên
npm run neomind -- program deliver /project my-program phase-1 "Đã squash vào main"
```

NeoMind không tự chạy giai đoạn sau. Task của giai đoạn mới kèm khối "Bài học từ các giai đoạn trước" (phát hiện review đã yêu cầu sửa và được sửa, lesson đã duyệt từ các run trước, ghi chú khi giao), tối đa 4.000 ký tự. Màn Runs hiện nhóm "Chương trình" với tiến độ và nút "Bắt đầu giai đoạn tiếp theo".

**Kiểm đủ phạm vi plan.** `review_group.planStepCriteria: true` biến mỗi bước đánh số trong `approach` của plan đã duyệt thành tiêu chí bắt buộc `Plan step N: …`; reviewer thiếu mục nào thì review không đạt như các tiêu chí khác. Flow mới tạo từ mẫu Dev (editor, `flow author-draft`) bật sẵn; mẫu Dev có sẵn và flow cũ giữ nguyên.

## Dùng Claude Code làm runner

> Đã chạy thật trên Windows tới commit: Claude viết + Codex review, toàn Claude, crash giữa lượt viết rồi resume, và một run điều khiển hoàn toàn qua UI. Linux chưa chạy. Chi tiết: [claude-code-runner.md](docs/adaptive-agent-flow/claude-code-runner.md).

**Cần có**
- Claude Code CLI đã cài (`claude --version`) và đã đăng nhập: `claude auth status` báo logged in.
- Codex CLI vẫn cần: checks luôn chạy qua Codex theo chế độ sandbox của run, kể cả khi mọi binding dùng Claude Code. Preview báo lỗi nếu thiếu Codex.

**Chọn runner và model**
- Khi chạy: trong *Xem cấu hình thực tế*, mỗi binding có ô *Runner* (Codex hoặc Claude Code). Đổi runner sẽ đặt model về mặc định của runner đó; bấm *Cập nhật cấu hình* trước khi bắt đầu.
- Trong flow editor: ô *Runner* của binding có *Kế thừa*, *Codex*, *Claude Code*. Khi provider/model đang ghim, đổi runner sẽ chuyển chúng sang giá trị của runner mới.
- Model cho phép: Codex `gpt-6-luna` (mặc định), `gpt-6.1-terra`, `gpt-6.1-sol`; Claude Code `claude-sonnet-5-5` (mặc định), `claude-haiku-5-5`, `claude-opus-5-5`. Mức suy luận: `low`, `medium`, `high`.
- Theo dõi run hiển thị runner và model thực tế của từng bước.

**Giới hạn được áp dụng**
- Writer chỉ có Read/Glob/Grep/Write/Edit; Write/Edit chỉ được phép trong các thư mục ghi đã duyệt. Writer **không có shell**.
- Planner, research và reviewer chỉ đọc.
- Không có sub-agent (Task), MCP, web; settings và CLAUDE.md của user/project bị bỏ qua.
- Model, công cụ và quyền thực tế được đối chiếu ở mỗi lượt; sai lệch thì lượt bị hủy.

Đây là giới hạn do Claude Code tự áp dụng, **không phải sandbox của hệ điều hành** như sandbox Codex. Process vẫn chạy trong worker scope (job object/systemd) để dừng được chắc chắn.

## Flow có sẵn

| Flow | Các bước | Kết quả |
| --- | --- | --- |
| **Dev** | Plan → bạn duyệt → Implement → checks + agent review độc lập (tối đa 2 vòng sửa) → commit local | Commit trong worktree của run; lấy về bằng `git cherry-pick` |
| **Fast** | Plan nhanh (suy luận thấp) → NeoMind tự duyệt → Implement | Không checks, không agent review, không commit. Bạn xem thay đổi rồi bấm **Áp dụng vào checkout** (hoặc `run apply <project> <run-id>`): file được chép vào checkout, chưa stage, chưa commit; từ chối nếu file đó trong checkout đang có thay đổi |
| **Dev song song** | Plan chia 2 gói → bạn duyệt → 2 agent code song song → ghép (agent tích hợp xử lý xung đột) → review → commit | Commit |
| **Research** | Agent chỉ đọc, viết báo cáo có nguồn → agent review nguồn | Báo cáo, không sửa file |

Project chưa có file cấu hình (`neomind/project.json` hoặc `.neomind/project.json` cũ) được mặc định cho phép Fast, không cần tạo file cấu hình. Project đã có cấu hình riêng được giữ nguyên policy. Fast dùng hai ngoại lệ do flow khai báo: bước duyệt tự động (`mode: "auto"`) và review do người (`review: "human"`). Khi policy yêu cầu duyệt trước sửa hoặc review độc lập, project phải chủ động đặt `"allowAutoApproval": true` và `"allowHumanReview": true` trong `policy` của `neomind/project.json` để cho phép các ngoại lệ tương ứng. Trường bị bỏ trống không nới gate bắt buộc; Fast sẽ báo lỗi validation cho tới khi policy được cập nhật. Preview ghi rõ các ngoại lệ trước khi chạy.

## Chế độ sandbox Codex

Run mới mặc định **tắt sandbox Codex** cho cả planner, writer, reviewer và checks. Worktree, duyệt kế hoạch, review/commit gate, journal và Job Object/systemd vẫn hoạt động. Khi tắt, vai trò chỉ đọc và phạm vi ghi là chỉ dẫn cho agent, không còn được sandbox hệ điều hành bảo đảm; tiến trình có quyền của tài khoản chạy nó. Claude Code vẫn giữ giới hạn công cụ/quyền riêng của runner đó.

Muốn bật lại, thêm `"codexSandbox": "enabled"` vào object `policy` hiện có trong `neomind/project.json` (hoặc `.neomind/project.json` cũ); `"disabled"` tắt tường minh. Không cần tạo file chỉ để dùng mặc định tắt. Preview nêu chế độ, và mỗi run ghi nó một lần trong runtime context. Run cũ chưa có trường này tiếp tục dùng sandbox; resume không tự chuyển sang mặc định mới. Đổi policy khi run đang dở vẫn có thể làm run dừng để đối chiếu như các thay đổi policy khác.

Khi tắt, capability probe chỉ xác nhận dừng process và báo `sandboxVerified: false`; không giả sandbox đã được kiểm chứng. Khi bật, probe vẫn phải chứng minh ghi ngoài phạm vi bị chặn.

## Dùng NeoMind qua MCP (không cần Nimbalyst)

`neomind mcp <project>` mở một server MCP qua stdio cho một project. Server cung cấp cùng các tool `neomind_*` như extension Nimbalyst (trừ tool riêng của panel), giữ nguyên các bước cần người xác nhận và ghi người duyệt là `local-user (MCP session)`. Khi client ngắt kết nối, server chờ các tool đang chạy xong rồi mới đóng.

Build trước (`npm run build`), rồi đăng ký với client:

```bash
# Claude Code
claude mcp add neomind -- node /duong/dan/neomind/dist/src/cli/main.js mcp /duong/dan/project
```

```toml
# Codex CLI: ~/.codex/config.toml
[mcp_servers.neomind]
command = "node"
args = ["/duong/dan/neomind/dist/src/cli/main.js", "mcp", "/duong/dan/project"]
```

Đây là MCP cho session của bạn; agent bên trong một run vẫn không có MCP.

## Runner OpenCode (thử nghiệm)

Runner `opencode` đã được đăng ký, model lấy từ provider OpenCode đang kết nối trên máy (`GET /api/runners/opencode`). Chỉ nhận OpenCode 1.18.25 (đã probe 08/11) và 1.19.5 (người dùng cho phép 11/11, chưa probe đối kháng). Mỗi lượt chạy một `opencode serve` riêng trong worker scope, với cấu hình cô lập (không MCP, plugin, agent của project) và quyền `read/glob/grep` (+ `edit` cho bước sửa).

**Giới hạn quan trọng:** quyền của OpenCode không phải ranh giới của hệ điều hành. Probe 08/11 cho thấy OpenCode ghi được file ra ngoài repo qua junction. NeoMind cho bước sửa của OpenCode chạy chỉ với bằng chứng dừng được process (`sandboxVerified: false`), và `preview` báo `openCodeWarning`. Chỉ dùng trên repo và máy bạn chấp nhận rủi ro này.

## Sửa flow bằng canvas (Nimbalyst, Obsidian)

Flow lưu theo schema của NeoMind; canvas trong Flow studio dùng React Flow. Để xem và sửa flow trên canvas của Nimbalyst hoặc Obsidian, xuất flow ra file JSON Canvas 1.0 rồi nhập lại:

- Flow studio › **Quản lý** › **Xuất ra .canvas** ghi `neomind/flows/<flow>/flow.canvas` (lưu nháp trước nếu còn thay đổi). **Nhập từ .canvas** áp board vào bản nháp.
- CLI: `npm run neomind -- flow canvas export <project>/neomind/flows <flow> [file.canvas]` và `... flow canvas import ...`.

Trên board, mỗi thẻ là một **bước** của flow, không phải một agent: dòng 1 là tên bước, dòng 2 là loại bước và ai làm (ví dụ `Agent task · Agent sửa code`, `Duyệt · Bạn duyệt`, `Vòng sửa · NeoMind điều phối sửa lại`), dòng 3 là runner/model thật mà bước dùng, tính theo `neomind/project.json`. Màu theo người làm: cam là agent, tím là agent review độc lập, vàng là bạn duyệt, xanh lá là NeoMind tự làm; có ô chú giải ở góc board. Mũi tên `↺` (Review chưa đạt quay lại bước viết code) chỉ để minh họa vòng sửa và bị bỏ qua khi nhập. Sửa được: kéo thẻ, đổi tên, đổi loại, xóa thẻ, thêm thẻ mới (dòng 2 ghi loại bước), nối mũi tên với nhãn là kết quả (`pass`, `needs_changes`, `blocked`, `true`, `false`; để trống là `completed`). Thẻ không ghi loại bước, nhóm, file và link là ghi chú và được bỏ qua.

Cấu hình chi tiết của bước (goal, quyền, reviewer, runner/model) vẫn sửa trong Flow studio. Board mang bản sao cấu hình trong khóa `x-neomind`, nhưng khi nhập, cấu hình lấy theo bản nháp hiện tại cho mọi bước còn tồn tại, nên editor canvas có bỏ khóa lạ cũng không mất dữ liệu. Nhập kiểm tra cấu trúc flow, từ chối board của flow khác, báo khi bản nháp đã đổi sau lần xuất, và chỉ ghi nếu bản nháp không bị sửa trong lúc nhập. Bước mới nhận cấu hình mặc định như khi thêm từ Flow studio.

## CLI cơ bản

Thay đường dẫn ví dụ bằng project Git thực tế:

```bash
npm run neomind -- run preview /absolute/path/to/project dev
npm run neomind -- run start /absolute/path/to/project dev "Mô tả task"
npm run neomind -- run start /absolute/path/to/project dev --task-file task.md
npm run neomind -- run list /absolute/path/to/project
npm run neomind -- run show /absolute/path/to/project RUN_ID
npm run neomind -- run plan /absolute/path/to/project RUN_ID [--out plan.md]
npm run neomind -- run approve /absolute/path/to/project RUN_ID --plan-hash PLAN_HASH
npm run neomind -- run resume /absolute/path/to/project RUN_ID
npm run neomind -- run changes /absolute/path/to/project RUN_ID --plan-hash PLAN_HASH "Yêu cầu sửa kế hoạch"
npm run neomind -- run changes /absolute/path/to/project RUN_ID --plan-hash PLAN_HASH --feedback-file feedback.md
npm run neomind -- run retry-git /absolute/path/to/project RUN_ID
npm run neomind -- run extend-time /absolute/path/to/project RUN_ID 600
npm run neomind -- run start /absolute/path/to/project dev "Mô tả task" --import-dirty DIRTY_HASH
npm run neomind -- run include-imported /absolute/path/to/project RUN_ID
npm run neomind -- run clean /absolute/path/to/project RUN_ID [--force]
npm run neomind -- run clean /absolute/path/to/project --all [--force]
```

**Dọn worktree.** Mỗi run làm việc trong một Git worktree riêng dưới thư mục state. NeoMind tự xóa worktree khi kết quả đã nằm ở chỗ khác: run có commit (commit được giữ ở `refs/neomind/<run-id>/delivery/<bước>` trước khi xóa, nên `git cherry-pick` vẫn dùng được), run Fast sau khi **Áp dụng vào checkout**, và run chỉ đọc. Run còn thay đổi chưa áp dụng hoặc chưa commit (Fast chưa áp dụng, run bị hủy giữa chừng) thì giữ worktree; `run clean` từ chối và liệt kê các file đó, thêm `--force` để vẫn dọn. Ngay trước khi xóa, NeoMind chụp toàn bộ worktree (file tracked và untracked, trừ file bị ignore) thành ref `refs/neomind/<run-id>/snapshot/workspace` (nhánh song song: `.../snapshot/branch/<bước>`); lấy lại bằng `git worktree add <thư mục> <ref>`. File bị ignore không nằm trong bản chụp, nên chỉ bị xóa khi dùng `--force`. Trên Windows, nếu một chương trình đang mở thư mục hoặc file trong worktree thì việc xóa dừng lại và báo lỗi; đóng chương trình đó rồi dọn lại, bản chụp đã có sẵn. `--all` dọn mọi run đã xong và báo run nào được giữ lại (thoát mã 1 nếu có). Trong editor: nút **Dọn worktree** ở *Chi tiết kỹ thuật* của run (hỏi lại trước khi bỏ thay đổi) và **Dọn worktree run đã xong** trong cột lịch sử. Muốn giữ worktree sau khi run giao kết quả, đặt `"keepRunWorktrees": true` trong policy của `neomind/project.json`. Journal và transcript của run luôn được giữ.

`DIRTY_HASH` là `dirtyImport.baselineHash` trong `run preview`: các thay đổi chưa commit được chép vào worktree của run làm input, checkout của bạn không bị sửa, và commit chỉ chứa phần do run làm. Khi thay đổi của run không tách được khỏi thay đổi có sẵn, run dừng chờ `include-imported` (commit cả hai) hoặc bạn tự xử lý.

**Task và góp ý nhiều dòng.** `--task-file` (cho `run start`) và `--feedback-file` (cho `run changes`) đọc nội dung từ file UTF-8 thay cho đối số trong ngoặc kép; nên dùng khi nội dung có nhiều dòng, vì `cmd` của Windows chỉ giữ dòng đầu của đối số. Không dùng cùng lúc file và đối số. File rỗng, hoặc góp ý dài quá 10000 ký tự, bị coi là sai cú pháp.

**Đọc plan.** `run plan` in plan mới nhất (đang chờ duyệt hoặc đã duyệt) dạng Markdown: planId, phiên bản, run, phase, trạng thái duyệt, `planHash`, rồi Goal, Approach, Acceptance criteria, Checks, Risks, Scope. `--out` ghi ra file thay vì in ra màn hình. Run chưa có plan thì thoát mã 1.

`PLAN_HASH` lấy từ `proposedPlanHash` của `run show` (hoặc dòng `Plan hash` của `run plan`). Lệnh sai cú pháp thoát với mã 2 và không mở state. Chỉ một process được sở hữu scheduler của mỗi run; không điều khiển đồng thời run đang được editor sở hữu từ CLI.

Ctrl+C/SIGTERM (Windows: Ctrl+C, Ctrl+Break, đóng console) với `run …` hoặc `editor` sẽ tạm dừng các run mà process đó sở hữu và chỉ thoát sau khi xác nhận worker đã dừng; worker chưa xác nhận làm workspace bị quarantine. Nhấn lần nữa để thoát ngay; khi `run resume`, worker còn sót được dừng và đối chiếu trước khi chạy tiếp.

## Xem agent đang làm gì

Màn theo dõi run có khung **Hoạt động trực tiếp** khi agent đang chạy: tin nhắn, file đọc, file sửa (kèm diff), lệnh chạy (kèm exit code và output). Hai agent hiện cạnh nhau, agent thứ ba trở đi thu thành một dòng và mở ra khi cần. Khi bước xong, luồng thu lại thành một dòng tóm tắt (file đã sửa, số lệnh, tokens) trong khung **Session của agent**; bấm **Xem session** để mở toàn bộ lượt đó, kể cả các lượt trước của cùng bước.

NeoMind tự ghi transcript này trong lúc chạy, cho cả Codex và Claude Code, vào `runs/<run-id>/transcripts/<attempt-id>.jsonl` trong thư mục state của project. Mỗi mục bị giới hạn: output lệnh giữ 200 dòng cuối, nội dung file đọc giữ 60 dòng đầu, suy luận chỉ giữ phần tóm tắt, mỗi file transcript tối đa 8 MB. Trong ngăn **Xem session** có thể chuyển sang **Session gốc của runner** để đọc lại cùng lượt từ lịch sử của Codex (qua app-server) hoặc Claude Code (file session); run tạo trước khi có transcript chỉ xem được theo cách này. Chỗ thiếu dữ liệu được ghi rõ (lượt bị dừng, bản ghi cắt ngang, runner đã dọn session).

Chỉ xem: không gửi chỉ dẫn giữa lượt và không tiếp tục session từ UI, vì agent khi đó sẽ chạy ngoài journal và ngoài giới hạn quyền của run. Transcript có thể chứa nội dung file và output lệnh, nên chỉ được phục vụ qua editor local.

## Dữ liệu và giới hạn

Dữ liệu NeoMind của project nằm trong thư mục `neomind/` (không có dấu chấm, nên Obsidian và các công cụ ẩn thư mục chấm vẫn thấy): flow ở `neomind/flows`, profile ở `neomind/profiles`, cấu hình tùy chọn ở `neomind/project.json`, memory mặc định ở `neomind/memory`. Project cũ dùng `.neomind/` vẫn chạy; chuyển bằng `npm run neomind -- project migrate <project>` rồi commit (Git nhận là đổi tên). Nếu project đã có thư mục `neomind/` của riêng nó (ví dụ package tên neomind), NeoMind dùng `.neomind/` để không lẫn. Journal, coordination SQLite và worktrees nằm dưới `${XDG_STATE_HOME:-~/.local/state}/neomind/<project-key>` (Windows: `%LOCALAPPDATA%\neomind\<project-key>`, trừ khi đặt `XDG_STATE_HOME`). Các linked worktrees dùng identity Git common directory chung.

Memory Markdown độc lập với frontend. UI cho cấu hình root, ghi context/quyết định với receipt và duyệt lesson trước khi chia sẻ. Revision và nội dung memory được ghim trong từng run; root không khả dụng sẽ báo lỗi. Nimbalyst adapter chưa được triển khai.

Executor chạy trong worktree riêng: một writer, hoặc các writer trong nhánh fork (mỗi nhánh một worktree, gộp bởi bước integration). Reviewer và các nhánh chạy song song trong giới hạn cấu hình; commit nội bộ của nhánh nằm trên `refs/neomind/<run>/…`, không đụng nhánh của bạn. Commit local dùng `commit-tree` và cập nhật ref có kiểm tra baseline, **không chạy Git hooks**. Flow không tự push hoặc tạo PR. Xem bàn giao để biết giới hạn recovery, Git và acceptance còn lại.

### Workflow, workspace và memory (04/11/2026)

Run mới có thể chọn worktree riêng, checkout hiện tại hoặc shared workspace trên Flow Studio. CLI tương ứng:

```bash
npm run neomind -- run preview /path/to/repo dev --workspace current
npm run neomind -- run start /path/to/repo dev "task" --workspace current --import-dirty BASELINE_HASH
```

Lấy `BASELINE_HASH` từ preview khi checkout có thay đổi. Shared/current tuần tự hóa writer, giữ staging và chỉ commit phần run. Isolated hỗ trợ nhiều giai đoạn fork/join/integration và review/repair từng nhánh; fork lồng nhau vẫn bị chặn. `run clean` chụp worktree thành ref snapshot rồi xóa hẳn (xem *Dọn worktree* ở trên).

Project memory có policy lexical/LSA/hybrid, suy ra path từ task/tên file, dedup và metadata `expiresAt`/`supersedes`. LSA chạy cục bộ theo corpus project; lesson chỉnh sửa tạo version mới và cần duyệt lại. Chi tiết kiểm chứng và giới hạn: [bàn giao 04/11](docs/adaptive-agent-flow/session-handoff-2026-11-04.md).

### Memory dùng được (11/11/2026)

**Không cần cấu hình.** Project chưa chọn thư mục memory dùng `neomind/memory` trong repo: chưa có thư mục thì đọc ra memory rỗng, bản ghi đầu tiên tạo thư mục. Memory nằm trong Git nên đi theo commit; cần dùng chung ngoài repo thì chọn "Dùng thư mục khác…" trên trang Memory (thư mục đã cấu hình giữ nguyên như trước).

**Đề xuất và duyệt.** Ngoài lesson từ vòng sửa, run tự đề xuất (tối đa 8 mỗi run, cùng nội dung chỉ một lần): quyết định từ yêu cầu sửa kế hoạch, lesson khi reviewer thấy rule bị vi phạm, lesson từ lý do run bị chặn (khi run xong hoặc bị hủy). Nút **Ghi nhớ điều này** trên chi tiết run biến một câu của bạn thành đề xuất có nguồn là run. AI trong session đề xuất bằng `memory_propose`. Mọi đề xuất vào một hàng đợi trên trang Memory: **Duyệt**, **Sửa rồi duyệt**, **Từ chối**; đề xuất trùng nội dung được gộp, đề xuất trùng bản ghi đã có được cảnh báo.

**Trang Memory.** "+ Ghi chú" lưu thẳng (bạn tự ghi nên coi là đã duyệt; lesson vẫn có biên nhận đề xuất/duyệt). Sheet chi tiết: sửa nội dung/phạm vi/tag theo revision (sửa trùng lúc bị từ chối, không ghi đè), **Hết hạn**, **Thay thế bằng…** (bản mới cùng loại, bản cũ không còn được dùng), **Xóa** có xác nhận (không xóa được bản đang bị bản khác thay thế). Mỗi bản ghi có số run đã dùng và điểm đánh giá.

**Memory theo bước.** Bước agent/reviewer có trường tùy chọn `memory: { types, tags, maxRecords, off }`. Flow tạo mới từ template có `memoryDefaults: "role"`: lập kế hoạch và nghiên cứu nhận context + quyết định + lesson, bước viết code nhận cả ba nhưng chỉ bản ghi khớp phạm vi kế hoạch, reviewer chỉ nhận quyết định + lesson. Flow cũ và template dựng sẵn không đổi: mọi bước nhận cả khối memory như trước. Run vẫn ghim một tập memory khi tạo; mỗi bước lọc trên tập đó, và `node_input.sources` ghi đúng bản ghi bước nhận.

**Memory đã dùng và đánh giá.** Chi tiết run có mục "Memory đã dùng": mỗi bước nhận bản ghi nào, vì sao, bộ lọc của bước. Nút **Hữu ích / Không liên quan / Sai** ghi event `memory_feedback` vào journal của run và cộng điểm trong SQLite điều phối (+1 / −1 / −3); run sau xếp hạng có cộng/trừ theo điểm (tối đa ±5, không vượt qua yêu cầu khớp task). "Sai" mở bản ghi để sửa hoặc cho hết hạn.

CLI dùng cùng core:

```bash
npm run neomind -- memory list /path/to/repo [từ khóa]
npm run neomind -- memory pending /path/to/repo
npm run neomind -- memory approve|reject /path/to/repo <proposalId> [--body-file sửa.txt]
npm run neomind -- memory note /path/to/repo lesson "Chạy npm run build:ui sau khi sửa giao diện" --tags ui
npm run neomind -- memory expire|delete /path/to/repo <context|decision|lesson> <id>
npm run neomind -- memory remember /path/to/repo <runId> "Điều cần nhớ" [--step implement]
npm run neomind -- memory feedback /path/to/repo <runId> lesson/<id> helpful|irrelevant|wrong [--step verify]
npm run neomind -- memory propose /path/to/repo proposal.json
npm run neomind -- memory compact /path/to/repo --dry-run   # xem trước; bỏ --dry-run để ghi
```

**Memory ngắn, đọc được.** Lesson từ vòng sửa chỉ gồm vài dòng: tiêu chí review, vấn đề (tối đa ~400 ký tự), run/bước đã sửa và file (`path:line`); toàn bộ bằng chứng nằm trong run, dẫn qua `sources` (`run:<id>/event:<seq>`). Body tối đa 800 ký tự, scope `project`. Đề xuất của AI trong session tối đa 1500 ký tự. Lesson theo mẫu cũ (trước 12/11: JSON thô của reviewer + cả câu trả lời của agent) rút gọn được bằng nút **Rút gọn** trên trang Memory hoặc `memory compact`: bản ghi đã duyệt được ghi revision mới (giữ nguồn, thêm `compacted`, scope project-id thành `project`), đề xuất chờ duyệt được lưu bản mới; nội dung khác mẫu cũ không bị đụng.

**Memory lưu bằng tiếng Anh.** Phần NeoMind tự sinh (lesson vòng sửa `Keep review criterion: … / Problem: … / Fixed in run <id> (step <node>). Files: …`, đề xuất từ sửa kế hoạch, rule bị vi phạm, run bị chặn, cùng `reason` của chúng) viết bằng tiếng Anh; câu người dùng gõ (phản hồi kế hoạch, "Ghi nhớ điều này", ghi chú) giữ nguyên. Mô tả các tool `memory_propose`, `skill_create`, `skill_update`, `profile_draft`, `flow_draft` yêu cầu AI viết nội dung lưu trữ bằng tiếng Anh. Bản ghi và đề xuất theo mẫu tiếng Việt cũ được `memory compact` viết lại sang mẫu tiếng Anh (cùng cách ghi như trên: revision mới có audit cho bản đã duyệt, bản mới cho đề xuất chờ duyệt); chỉ chữ của mẫu đổi, tiêu chí, giải thích, file và câu người dùng giữ nguyên.

API editor: `GET /api/memory` (kèm `location`, `stats`, `inactive`), `GET /api/memory/search`, `GET /api/memory/records/:type/:id`, `POST /api/memory/note|expire|delete`, `POST /api/memory/compact` (`{ dryRun?, target?: { type, id } | { runId, proposalId } }`), `GET|POST /api/memory/proposals`, `POST /api/memory/proposals/approve|reject|revise`, `POST /api/runs/:id/remember`, `POST /api/runs/:id/memory-feedback`.
