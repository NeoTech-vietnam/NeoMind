# Plan: Skills/Agents và Memory — 11/11/2026

Trạng thái: **đã duyệt 11/11/2026**. Phạm vi do người dùng chọn ngày 11/11. Hai mảng làm song song ở hai worktree, mỗi mảng một session Claude Opus; session điều phối review và merge. Mã tham chiếu theo commit `4250f37`.

Nguyên tắc chung (giữ như các đợt trước):

- Trường schema mới đều **tùy chọn**; flow, profile, run và memory cũ chạy như trước.
- Mỗi khả năng có một hàm core dùng chung cho session tool (`src/runtime/session-tools.ts`), CLI (`src/cli/main.ts`) và API (`src/ui-server/server.ts`).
- AI được tạo/sửa theo quyền `ai.*` trong `neomind/project.json`; **xóa** do AI gọi phải có `confirmed: true` sau khi người dùng đồng ý trong session (như `apply`, `clean`). Memory do AI đề xuất vẫn qua người duyệt.
- Giao diện dùng `ui/src/components/ui`, có trạng thái mẫu trong `/__gallery/`, chạy được ở panel ~900px và web, sáng/tối. Nhãn tiếng Việt.
- Test bằng fake runner; không chạy run thật.

## Mảng A · Skills và Agents (branch `feat/skills-agents`)

### A1. Thư viện skill soạn được (`neomind/skills/<id>/SKILL.md`)

- Core `src/storage/skill-library.ts`: `createSkill`, `updateSkill` (có `expectedSha256` chống ghi đè), `deleteSkill`, đọc/ghi file phụ dạng text trong thư mục skill. Chỉ sửa được skill nguồn `neomind`; skill trong `.claude/skills` hiện **chỉ đọc** (ghi chú "sửa trong .claude/skills"). Kiểm đường dẫn như `materialize.ts`/`skill-catalog.ts` (không symlink, không ra ngoài thư mục).
- `SKILL.md` giữ chuẩn Claude: frontmatter `name`, `description` + thân Markdown.
- **Nơi đang dùng:** `skillUsage(root, path)` liệt kê profile (draft + phiên bản mới nhất) và bước flow (`skillsOverride` trong draft) đang ghim skill. Xóa skill đang được dùng thì từ chối, trả danh sách; có `force` cho người dùng (UI hỏi xác nhận).
- **Ghim lại hàng loạt:** sau khi sửa skill, `repinSkill(root, path)` cập nhật `sha256` trong **draft** của các profile và flow đang dùng (không tự publish), trả danh sách đã cập nhật.
- Tool: `skill_get`, `skill_create`, `skill_update`, `skill_delete` (`confirmed`), `skill_usage`. Quyền `ai.skillEdit?: 'allow' | 'deny'` (mặc định `allow`). CLI `neomind skill get|create|update|delete|usage …`; API `/api/skills/:id…`.

### A2. Màn Skills riêng

- Thêm mục **Skills** vào thanh điều hướng (Runs · Flows · Agents · Skills · Memory); đổi nhãn "Profiles" thành **Agents** (giữ tên `profile` trong code/API).
- Trái: danh sách skill (tên, nguồn, số nơi dùng, trạng thái lệch nếu có). Phải: form tên/mô tả, editor Markdown cho thân, danh sách file phụ (thêm/sửa/xóa file text), nút **Lưu**, **Xóa** (hộp xác nhận liệt kê nơi đang dùng), và **Xem đoạn chèn vào prompt** (đúng định dạng `Skill <name> (<id>):` của `LocalRun.prompt`).
- Sau khi lưu skill đang được ghim: callout "N agent/bước đang ghim bản cũ" + nút "Ghim lại tất cả".
- Nút "+ Skill mới" mở dialog (id, tên, mô tả, mẫu trống/mẫu checklist review).

### A3. Agents dễ dùng hơn

- **Tạo từ mẫu:** dialog "+ Agent mới" có các mẫu Implementer, Planner, Reviewer độc lập, Reviewer UI, Reviewer bảo mật, Research (chỉ đọc) — mỗi mẫu có hướng dẫn, quyền và skill gợi ý sẵn. Mẫu nằm trong code (`src/domain/profile-templates.ts`), không phải file người dùng.
- **Lưu một bước:** nút chính **"Lưu"** = lưu draft + publish phiên bản mới (tác giả `human`). Sau khi lưu, nếu có flow đang dùng bản cũ: callout + nút "Cập nhật các flow" (dùng `migrateProfile` sẵn có, chỉ sửa draft flow).
- **Xóa agent:** hộp xác nhận liệt kê flow/bước đang dùng; nếu còn flow dùng thì đề nghị lưu trữ thay vì xóa. Tool `profile_delete` (`confirmed`) và `profile_archive`.
- Tab **Skills** của agent dùng lại danh mục và link sang màn Skills để sửa nội dung.

### A4. Chọn skill cho từng bước trong Flow Studio

- Đưa mục **Skills** lên phần chính của inspector (không còn trong "Nâng cao") cho `agent_task`, từng reviewer của `review_group`, và `integration`.
- Hiển thị rõ hai chế độ: **"Theo agent"** (chip mờ các skill kế thừa từ profile/phiên bản) và **"Riêng cho bước này"** (chọn từ danh mục; ghi `skillsOverride`). Không đổi nghĩa của `skillsOverride` (danh sách thay thế).
- Thẻ bước trên canvas có chip nhỏ "N skill" khi bước có skill (kế thừa hoặc riêng).
- Preview Run mới: mỗi bước liệt kê skill sẽ dùng.

### A — Test

Tạo/sửa/xóa skill qua tool và API (từ chối khi đang dùng, `force` xóa được); `ai.skillEdit: deny` chặn AI; sửa skill → `skillStatus` báo `changed` → `repinSkill` cập nhật draft profile và flow; prompt (fake runner) chứa skill riêng của bước thay vì skill của agent; tạo agent từ mẫu; xóa agent đang dùng bị từ chối.

## Mảng B · Memory (branch `feat/memory`)

### B1. Bật sẵn, không cần cấu hình

- Khi project **chưa cấu hình** memory root, dùng mặc định `neomind/memory` trong repo (nằm trong Git), **tạo khi ghi bản ghi đầu tiên** (đọc khi chưa có thư mục = memory rỗng, không lỗi). Root đã cấu hình giữ nguyên. Sửa `resolveDefaultMemoryRoot`/`openProjectMemory` cho phù hợp.
- Banner Memory: nói rõ memory nằm ở đâu và được commit cùng repo.

### B2. AI đọc và đề xuất memory qua tool

- `memory_search` (query, type, scope, tags; trả id, loại, phạm vi, tóm tắt, revision), `memory_get`.
- `memory_propose` (type, scope, tags, body, sources, lý do) → tạo **đề xuất chờ duyệt** dùng chung cơ chế `LessonProposals` (mở rộng cho cả `context` và `decision`, không chỉ lesson). Có kiểm trùng với bản ghi sẵn có.
- `memory_pending` liệt kê đề xuất; duyệt/từ chối do người làm trên UI hoặc CLI. Tool duyệt cho AI chỉ chạy với `confirmed: true` sau khi người đồng ý trong session.
- CLI/API tương ứng.

### B3. Tự rút đề xuất từ nhiều nguồn hơn

Ngoài vòng sửa (đã có), khi run kết thúc tạo đề xuất từ:

- yêu cầu sửa plan của người dùng (`revisePlan` feedback) → `decision` hoặc `lesson`;
- phát hiện review `needs_changes` đã được sửa (đã có một phần) và tiêu chí/rule bị vi phạm;
- run bị chặn/hủy kèm lý do;
- nút **"Ghi nhớ điều này"** trên màn chi tiết run: người dùng gõ một câu, tạo đề xuất kèm nguồn là run.

Mọi đề xuất qua hàng đợi duyệt; giới hạn số đề xuất mỗi run; gộp đề xuất trùng.

### B4. Memory theo bước

- Trường tùy chọn trên node agent/reviewer: `memory?: { types?: ('context'|'decision'|'lesson')[]; tags?: string[]; maxRecords?: number; off?: boolean }`.
- Mặc định theo vai trò khi không khai báo: plan → context + decision + lesson; write → context + decision + lesson khớp phạm vi file của plan; review → decision + lesson. Flow cũ không khai báo vẫn nhận như trước (một khối memory chung) để không đổi kết quả run cũ — chỉ flow mới tạo từ template bật mặc định theo vai trò.
- Vẫn ghim một tập memory khi tạo run (giữ replay), mỗi bước lọc trên tập đã ghim; prompt và `node_input.sources` ghi đúng bản ghi bước đó nhận.
- Inspector: mục **Memory** cho bước (chọn loại, tag, số bản ghi, tắt). Component riêng `ui/src/StepMemoryField.tsx`; session điều phối gắn vào inspector khi merge (để tránh đụng mảng A).

### B5. Thấy memory đã dùng và có giúp không

- Màn chi tiết run, mỗi bước: "Memory đã dùng" (id, loại, lý do chọn).
- Nút đánh giá trên từng bản ghi: **Hữu ích / Không liên quan / Sai**. Ghi event `memory_feedback` vào journal; tổng hợp điểm trong SQLite điều phối; xếp hạng lần sau cộng/trừ theo điểm. "Sai" mở form sửa/hết hạn bản ghi.
- Trang Memory hiện số lần dùng và điểm hữu ích của từng bản ghi.

### B6. Trang Memory dễ thêm/sửa/xóa

- "+ Ghi chú" nhanh (chọn loại, phạm vi, tag, nội dung) — người dùng tự ghi thì lưu thẳng (đã duyệt).
- Sửa inline trong sheet chi tiết (có revision chống ghi đè), **Hết hạn**, **Thay thế bằng…** (supersede), **Xóa** (xác nhận).
- Hàng đợi đề xuất: Duyệt / Sửa rồi duyệt / Từ chối (thêm từ chối nếu chưa có).

### B — Test

Project chưa cấu hình: đọc rỗng, ghi tạo `neomind/memory`; `memory_propose` → chờ duyệt → duyệt → `memory_search` thấy; đề xuất sinh từ yêu cầu sửa plan và nút ghi nhớ; bước review chỉ nhận lesson/decision theo mặc định flow mới, flow cũ nhận như trước (fake runner kiểm prompt); `memory_feedback` đổi thứ tự xếp hạng; replay run cũ không đổi.

## Phối hợp hai mảng

- Worktree: `../test_workflow_worktrees/skills-agents` và `../test_workflow_worktrees/memory`, cùng tách từ `4250f37`.
- File cả hai có thể sửa: `src/runtime/session-tools.ts`, `src/ui-server/server.ts`, `src/cli/main.ts`, `src/domain/schema.ts`, `src/runtime/local-run.ts`, `README.md`, `docs/.../implementation-status.md`. Quy ước: thêm khối mới, không sắp xếp lại code cũ; mảng A sở hữu `ui/src/App.tsx` (inspector) và `ui/src/shell/AppShell.tsx`; mảng B không sửa hai file này (chỉ tạo component riêng).
- Merge: A trước, rồi rebase B lên, session điều phối giải xung đột và gắn `StepMemoryField` vào inspector.
- Mỗi mảng commit nhỏ (core / tool-CLI-API / UI / docs); cuối mảng: `tsc` core + UI, `build:ui`, build extension, `npm test` đầy đủ một lần, ảnh chụp gallery tối/sáng × 1440/900; ghi `implementation-status.md`.

## Ngoài đợt này

Nhập `.claude/agents/*.md`; hooks; memory dùng embedding từ model; chia sẻ memory giữa nhiều repo.
