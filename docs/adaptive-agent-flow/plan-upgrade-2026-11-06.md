# Plan nâng cấp NeoMind — 06/11/2026

Plan chi tiết cho [định hướng 06/11](direction-2026-11-06.md), đã được người dùng duyệt. Năm gói, làm theo thứ tự; mỗi gói tách commit, `npm test` đạt, có test bằng fake runner (không chạy run thật). Không đổi hành vi của run hiện có khi project không bật tính năng mới. Mã nguồn tham chiếu theo commit `cfd413b`.

Quy ước chung:

- Mỗi tính năng có ba bề mặt dùng chung một hàm core: tool cho session (`src/runtime/session-tools.ts`: thêm vào `SESSION_TOOLS` **và** `sessionToolHandlers`, tên trùng nhau), lệnh CLI (`src/cli/main.ts`, cập nhật chuỗi Usage), route API (`src/ui-server/server.ts`, `createEditorApi`). Extension tự lộ tool mới qua `extensions/nimbalyst/src/backend.ts` (không cần sửa trừ khi có tool chỉ cho panel).
- Schema mới đều là trường **tùy chọn** để file cũ (`neomind/project.json`, flow, profile, journal) vẫn đọc được.
- Test theo `test/session-tools.test.ts` (fixture `project()` dòng 17–38, `FakeRunnerFactory`). Prompt kiểm bằng `FakeRunner.turns` hoặc `FAKE_CLAUDE_LOG`.
- Giao diện dùng component trong `ui/src/components/ui`, token trong `ui/src/theme.css`; thêm trạng thái mẫu vào trang `/__gallery/` tương ứng.

## Gói 1 · AI tạo, lưu và chọn flow

**Dữ liệu.**
- `src/storage/flow-library.ts`: bản đã lưu (`versions/NNNNNN.json`, đang có `semanticHash`, `contentHash`, `createdAt`) thêm `author?: { kind: 'human' | 'ai'; sessionId?: string; reason?: string }`. `publish(id, policy, expectedRevision?, author?)`. Bản cũ không có trường này coi là `human`.
- `projectSchema` (`src/domain/schema.ts:109`) thêm `ai?: { flowPublish?: 'allow' | 'draft-only' | 'deny'; profilePublish?: … }`, mặc định `allow` (quyết định 06/11). `deny`: tool không được tạo/sửa nháp; `draft-only`: được nháp, không được publish.
- Policy sàn giữ nguyên ở `compileFlow` (`src/domain/compiler.ts`: `missing_required_reviewer`, `auto_approval_denied`, `approval_bypass`, `review_bypass`, giới hạn concurrency/repair…). Thêm trần cho flow do AI publish: `limits.activeTimeSeconds` ≤ trần của project nếu có, không cao hơn mẫu Dev (ghi rõ trong diagnostics mới `ai_limit_exceeded`).

**Core.** Module mới `src/runtime/flow-authoring.ts` dùng chung cho tool/CLI/API:
- `flowBlocks(projectRoot)`: các loại bước (từ `kindInfo` tương đương ở domain), template có sẵn (`src/domain/templates.ts`), profile và binding hiện có, policy của project, ví dụ một flow Dev đầy đủ. Dạng gọn để AI đọc.
- `draftFlow(projectRoot, { flowId, name?, from?: { template } | { flowId } , draft? })`: tạo flow nếu chưa có (`FlowLibrary.create` + template/clone), ghi draft (`saveDraft` với `expectedRevision`), trả `{ revision, diagnostics }` từ `compileFlow(draft, policy)`.
- `diffFlows(a, b)`: so draft với phiên bản publish gần nhất: bước thêm/bớt/đổi (theo id, so nhãn, loại, các trường chính), kết nối thêm/bớt, binding đổi runner/model/reasoning, limits đổi. Dùng cho tool và cho Flow Studio sau này.
- `publishFlow(projectRoot, flowId, { author, expectedRevision })`: kiểm `ai.flowPublish` khi `author.kind === 'ai'`, rồi `FlowLibrary.publish`.
- `assess(projectRoot, task)`: quy tắc tĩnh, trả `{ flowId, reasons[], alternatives[], suggestedChecks[] }`:
  - từ khóa nghiên cứu/tìm hiểu/so sánh → `research`; việc nhỏ một file, sửa chữ, cấu hình → `fast` nếu project cho phép tự duyệt; có "song song"/nhiều phần độc lập → `parallel`; còn lại → `dev`;
  - ưu tiên flow của project nếu tên/mô tả khớp task hơn template;
  - khi gói 5 xong: dùng thống kê (tỷ lệ giao kết quả, token trung bình) để xếp hạng giữa các ứng viên.

**Tool cho session.** `flow_blocks`, `flow_get` (draft + danh sách phiên bản kèm tác giả), `flow_draft`, `flow_validate` (diagnostics + diff), `flow_publish` (ghi `author: { kind: 'ai', sessionId: call.sessionId, reason }`), `assess`. Mô tả tool dặn AI trình bày diff cho người trước khi publish, dù project cho phép tự publish.

**CLI/API.** `neomind flow diff <dir> <id>`, `neomind assess <dir> --task-file <file>|<task>`; route `GET /api/flows/:id/diff`, `POST /api/assess`; `publish` route nhận `author` (editor web gửi `human`).

**Giao diện.** Flow Studio: badge "AI" cạnh tên khi phiên bản mới nhất do AI publish; sheet so sánh phiên bản dùng `diffFlows`; danh sách phiên bản hiện tác giả và lý do.

**Lệnh `/neomind:run`** (`extensions/nimbalyst/claude-plugin/commands/run.md`): assess → nếu không có flow hợp thì `flow_draft` → `flow_validate` → trình bày diff → `flow_publish` → `preview` → `start` → như cũ.

**Test.** Tạo flow từ template qua tool; sửa draft bỏ reviewer bắt buộc → `flow_publish` trả lỗi `missing_required_reviewer`; `ai.flowPublish: 'draft-only'` chặn publish; `deny` chặn draft; publish ghi `author` và phiên bản mới; `diffFlows` đúng với thêm/bớt bước và đổi binding; `assess` trả `research`/`fast`/`dev` theo các task mẫu.

## Gói 2 · Skills và profile

**Danh mục skill.** Module `src/storage/skill-catalog.ts`: quét `.claude/skills/*/SKILL.md` và `neomind/skills/*/SKILL.md` trong project; đọc frontmatter `name`, `description`; trả `{ id, path, sha256, name, description, source }`. Dùng lại cách kiểm đường dẫn và hash của `src/domain/materialize.ts:43-57`.

**Trạng thái skill trong profile.** Hàm `skillStatus(projectRoot, refs)` → mỗi tham chiếu `ok | changed | missing` (so `sha256` đã ghim với file hiện tại). API `GET /api/skills`, `GET /api/profiles/:id/skills-status`.

**Nội dung phiên bản profile cũ.** `ProfileLibrary` đọc một phiên bản (`GET /api/profiles/:id/versions/:n`); tìm các flow đang dùng profile (draft và phiên bản mới nhất) và đề nghị chuyển: `POST /api/profiles/:id/migrate` sửa **draft** của các flow được chọn sang `profileVersion` mới (không tự publish).

**Đưa skill vào prompt.** Giữ cách hiện tại (`LocalRun.prompt`, `src/runtime/local-run.ts:252`: nội dung skill nằm trong prompt cho cả Claude và Codex) vì Claude chạy với `--setting-sources ''` và không tự nạp skill. Chuẩn hóa nhãn `Skill <name> (<id>):` và chỉ đưa nội dung `SKILL.md`; file phụ trong thư mục skill được liệt kê đường dẫn để agent tự đọc khi có quyền đọc.

**Tool.** `skills` (danh mục + trạng thái), `profile_get`, `profile_draft` (tạo/sửa profile nháp từ profile có sẵn hoặc spec), `profile_publish` (theo `ai.profilePublish`, ghi tác giả như flow).

**Giao diện.** Profiles › Skills: chọn skill từ danh mục (không gõ đường dẫn/hash), cột trạng thái với `changed`/`missing` màu hổ phách/đỏ và nút "Ghim lại" (cập nhật sha trong draft); menu phiên bản xem nội dung bản cũ (chỉ đọc); "Chuyển flow sang bản này" mở dialog chọn flow. Flow Studio inspector › Nâng cao: chọn `skillsOverride` từ danh mục.

**Test.** Quét danh mục với 2 nguồn; đổi nội dung file → `changed`; xóa file → `missing`; migrate chỉ sửa draft; prompt chứa nội dung skill với nhãn mới (fake runner).

## Gói 3 · Chương trình nhiều giai đoạn

**Dữ liệu.** File `neomind/programs/<programId>.json` (trong Git):
`{ schemaVersion: 1, programId, name, goal, phases: [{ id, title, task, flowId, dependsOn: string[], runnerOverrides? }] }`. Trạng thái không lưu trong file: suy ra từ run có `programId`/`phaseId` (thêm hai trường tùy chọn vào `runtimeContext` khi tạo run).

**Core.** `src/runtime/programs.ts`:
- `programStatus`: mỗi giai đoạn `blocked_by_dependency | ready | running | waiting_user | delivered | failed`; `delivered` khi run của giai đoạn đã `completed` **và** commit giao (`run.delivery`) đã có trong HEAD của checkout (`git merge-base --is-ancestor`), hoặc run handoff đã `applied`.
- `startPhase(programId, phaseId)`: chỉ khi `ready`; task = task của giai đoạn + khối "Bài học từ các giai đoạn trước" (A2) gồm: phát hiện review đã `needs_changes` rồi được sửa, lesson đã duyệt sinh từ các run trước của chương trình, ghi chú người dùng khi đánh dấu giao. Giới hạn 4000 ký tự.
- Không tự chạy giai đoạn sau: tool `program_next` bắt đầu giai đoạn sẵn sàng đầu tiên khi được gọi (AI gọi sau khi người dùng xác nhận đã đưa kết quả vào branch).

**Kiểm đủ phạm vi (A3).** `reviewRequirements` (`src/domain/review-requirements.ts:6`) thêm tiêu chí bắt buộc cho từng bước trong `plan.approach` khi approach có danh sách đánh số: `Plan step N: <nội dung>`. Bật theo node (`review_group.planStepCriteria?: boolean`, mặc định bật cho flow mới tạo từ template Dev; flow cũ giữ nguyên để không đổi kết quả review cũ). Reviewer thiếu mục → `needs_changes` như tiêu chí khác.

**Tool/CLI/API.** `program_create` (từ spec; validate các `flowId` tồn tại và đã publish), `program_status`, `program_next`, `program_list`; CLI `neomind program create|status|next <dir> …`; API `/api/programs…`.

**Giao diện.** Màn Runs: nhóm "Chương trình" phía trên danh sách run (tên, tiến độ `2/6`, giai đoạn hiện tại, nút "Bắt đầu giai đoạn tiếp theo" khi sẵn sàng); chi tiết chương trình dạng sheet liệt kê giai đoạn với trạng thái và run.

**Test.** Chương trình 3 giai đoạn với fake runner: giai đoạn 2 `blocked_by_dependency` tới khi commit giai đoạn 1 vào HEAD; task giai đoạn 2 chứa bài học từ review giai đoạn 1; `planStepCriteria` tạo đủ tiêu chí và thiếu một bước thì review không đạt.

## Gói 4 · Rules

Theo [định hướng tháng 11 §1.1](direction-2026-11.md):
- `neomind/rules.md`, mỗi dòng `- [R1] …`; parser trong `src/domain/rules.ts` (mã duy nhất, bỏ dòng không đúng dạng kèm cảnh báo).
- `RunManager.create` đọc, ghim nội dung + hash vào `runtimeContext.rules` (cùng cách memory: `run-manager.ts:104-107`, `runtime-state.ts`), ghi vào prompt sources (`local-run.ts:203-209`).
- `LocalRun.prompt` đưa rule vào mọi agent sau instructions của profile, nhãn "Rules của project (bắt buộc)", khác nhãn memory (tham khảo).
- `reviewRequirements` thêm `Rule R1: …` thành tiêu chí bắt buộc cho mọi review.
- Preview và tool `preview` trả danh sách rule; màn chi tiết run hiển thị kết quả chấm theo rule trong phần Kiểm tra.
- Flow do AI dựng (gói 1) không tắt được rule; `flowBlocks` liệt kê rule để AI biết.
- Giữ nguyên việc Codex tự đọc `AGENTS.md` (câu hỏi cũ chưa chốt; ghi vào bàn giao).

**Test.** Rule xuất hiện trong prompt của planner/writer/reviewer (fake runner); thiếu kết luận cho một rule → evidence không hợp lệ; run cũ không có `rules.md` chạy như trước.

## Gói 5 · Chi phí và quota

- `RunManager.list()` (`run-manager.ts:185`) thêm `tokens` (từ `RecoveryReport.usage`, `src/core/recovery.ts:192-199`).
- `src/runtime/run-stats.ts`: tổng hợp theo flow, profile, runner/model: số run, tỷ lệ hoàn tất/giao, token trung bình và trung vị, thời gian hoạt động, số vòng sửa, tỷ lệ review đạt lượt đầu. CLI `neomind run stats <dir> [--flow …] [--json|--csv]`, API `GET /api/stats`, tool `stats`.
- Ngân sách token: `limits.maxTokens?` trong flow và override khi start; khi tổng token của run vượt (kiểm sau mỗi `usage_observed`) thì `paused` với lý do rõ như hết thời gian; `extend_time` mở rộng thành gia hạn cả token (`extend` với `tokens`).
- Ước tính trong Run mới (đã ẩn ở GĐ 2): hiện khi có ≥ 3 run cùng flow + runner, từ `run-stats`.
- Chi phí USD: tùy chọn `neomind/pricing.json` (giá theo model, người dùng tự điền); không có thì chỉ hiện token.
- `assess` dùng thống kê (gói 1) khi có đủ dữ liệu.

**Test.** Thống kê từ journal mẫu có `usage_observed`; vượt `maxTokens` → `paused`; gia hạn rồi tiếp tục; ước tính chỉ hiện khi đủ 3 run.

## Kiểm chứng và tài liệu

- Mỗi gói: `npx tsc -p tsconfig.ui.json --noEmit`, `npm run build:ui`, build extension, `npm test` một lần cuối gói (test `parallel writers run concurrently` nếu lỗi mà chạy riêng đạt thì chỉ ghi nhận; `test/claude-capabilities.test.ts` gọi Claude CLI thật ~$0.002).
- Không chạy run thật trừ khi người dùng yêu cầu.
- Cập nhật `README.md` (lệnh mới), `docs/adaptive-agent-flow/nimbalyst-extension.md` (tool mới), `implementation-status.md` (mỗi gói một mục), bàn giao cuối đợt.
