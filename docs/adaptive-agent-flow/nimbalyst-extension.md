# NeoMind trong Nimbalyst: extension · spike 30/10/2026

## Quyết định (30/10/2026)

NeoMind vào Nimbalyst dưới dạng **extension**. Mọi session Nimbalyst có thể start và theo dõi flow NeoMind qua tool MCP (tương ứng các lệnh CLI). Agent của từng bước vẫn chạy bằng **runner Codex/Claude của NeoMind**, không dùng session của Nimbalyst. Lý do: SDK 0.7.1 chưa có stop có bằng chứng, cwd/worktree theo session, và model thực tế. Runner Nimbalyst để sau, khi SDK đủ, theo cùng contract `AgentRunner`.

Cách duyệt đã chốt: agent trong session **được gọi** duyệt kế hoạch hoặc áp dụng thay đổi, nhưng **phải hỏi người dùng trước** ngay trong session. Người dùng cũng duyệt được trong panel.

```mermaid
flowchart LR
  S["Session Nimbalyst<br/>(Claude / Codex)"] -- "tool neomind_*" --> B
  S -- "/neomind:run" --> S
  P["Panel NeoMind"] -- "callBackendTool" --> B
  B["Backend module (utility-process)<br/>RunManager · journal · scheduler"] --> R["Runner Codex / Claude<br/>(Job Object, worktree riêng)"]
  B --> F[("neomind/ + state trên máy<br/>chung với CLI và editor")]
```

## Cách extension được ghép với Nimbalyst

- `extensions/nimbalyst/manifest.json`: id `local.neomind`. Có 3 thành phần:
  - backend module `neomind-runtime`, chạy trong `utility-process`, quyền `mcp-server-register`;
  - panel `neomind`;
  - plugin lệnh `/neomind:run`.
- Backend: `activate(ctx)` nhận `ctx.services.{workspacePath, dataDir, log, registerMcpTools}`, đăng ký tool rồi trả về `{ methods, deactivate }`. Mỗi lần gọi có `ctx.call` (`caller`, `sessionId`).
  - Tool có `panelOnly: true` thì không lộ ra cho agent.
  - Host tự gắn tiền tố theo đoạn cuối của id: agent thấy `neomind_start`, panel gọi `neomind.status`.
  - Hợp đồng này lấy từ extension Crew có sẵn; **không có trong type công khai** của SDK 0.7.1, nên có thể đổi.
- Bundle: backend gói core NeoMind và zod vào một file ESM (`vite.backend.config.ts`). Panel để React do host cung cấp (`vite.panel.config.ts`). Dựng bằng `npm run build` trong `extensions/nimbalyst`.

## Kết quả spike

| Câu hỏi | Kết quả |
| --- | --- |
| Utility process chạy được git, Claude Code, Codex? | Được (Electron 43.7, Node 24.21). Codex cài qua npm phải chạy bằng `node.exe` trên PATH: trong Electron, `process.execPath` là `Nimbalyst.exe` (đã sửa trong `resolveWindowsCodex`). |
| Job Object (giới hạn và dừng process) | Được, dừng có xác nhận. |
| `node:sqlite` (khóa, coordination) | Có. |
| Panel gọi backend | Được, qua `host.callBackendTool('neomind.status')`. |
| Session mới thấy tool `neomind_*` và `/neomind:run`? | Có. Session Claude và session Codex mới đều thấy `neomind_start` và `neomind_status` (kiểm 30/10); `/neomind:run` hiện trong danh sách lệnh. Session mở trước khi backend đăng ký tool thì không thấy. |

## Bài học khi cài

- Extension do người dùng cài phải được cấp quyền chạy native code. Hộp thoại xin quyền chỉ hiện khi Nimbalyst **khởi động backend lúc mở workspace**. Cài lúc workspace đang mở thì không có hộp thoại, panel báo "Backend tool not available". Hai ô trạng thái trong Settings chỉ để hiển thị, không bấm được.
- Cách bật an toàn: giữ một cửa sổ Nimbalyst khác đang mở, đóng riêng cửa sổ workspace, rồi mở lại workspace đó. Thoát hẳn app thì Nimbalyst có thể tự thoát ngay lúc khởi động vì không có workspace để khôi phục (`[SingleInstance] No open-file after timeout, quitting`). Lần đó backend NeoMind chưa chạy, nên đây là hành vi của Nimbalyst.

## Bản đầy đủ (30/10/2026, sau spike)

**Tool cho session** (`src/runtime/session-tools.ts`, mỗi tool một lệnh CLI, cùng `RunManager`): `flows`, `preview`, `start`, `status`, `wait` (chờ đổi phase, tối đa 240 giây), `approve`, `request_changes`, `pause`, `resume`, `cancel`, `extend_time`, `apply`, `retry_commit`, `include_imported`, `clean`, `session` (transcript).
- `approve`, `apply`, `include_imported` và `clean` có `force` bắt buộc `confirmed: true`. Mô tả tool dặn agent hỏi người dùng trước. Host không chứng minh được agent đã hỏi, nên journal ghi lần duyệt từ session là nguồn `session` (thêm vào schema duyệt).
- Tool `api` chỉ dành cho panel: một request API của editor.

**Tạo flow từ session (Gói 1, 06/11/2026):** `neomind_flow_blocks`, `neomind_flow_get`, `neomind_flow_draft`, `neomind_flow_validate`, `neomind_flow_publish` và `neomind_assess` dùng chung core với CLI/API. Tool publish ghi `author: ai`, session nếu host cung cấp và lý do; mô tả tool yêu cầu trình bày diff trước khi publish. `ai.flowPublish` của project giới hạn `allow` / `draft-only` / `deny`; compiler vẫn giữ policy sàn. `assess.available` báo flow được gợi ý có sẵn sàng hay không. Lệnh `/neomind:run` đã dùng vòng assess → draft/validate/diff/publish khi cần → preview/start; người dùng vẫn quyết định duyệt plan của run theo policy.

**Skills và profile từ session (Gói 2, 06/11/2026):** `neomind_skills` (danh mục skill của project, kèm trạng thái `ok`/`changed`/`missing` khi truyền `refs`), `neomind_profile_get`, `neomind_profile_draft`, `neomind_profile_publish` (ghi tác giả AI; theo `ai.profilePublish`). Panel Profiles chọn skill từ danh mục, ghim lại sha khi skill đổi, xem phiên bản cũ chỉ đọc và chuyển draft flow sang phiên bản profile mới.

**Soạn skill và agent từ session (11/11/2026):** `neomind_skill_get` (SKILL.md, sha256, file phụ, đoạn chèn vào prompt; `source: "claude"` đọc `.claude/skills`, chỉ đọc), `neomind_skill_create`, `neomind_skill_update` (cần `expectedSha256` đã đọc; sửa tên/mô tả/thân hoặc toàn bộ `content`, thêm/sửa/xóa file phụ qua `files`; `repin: true` ghim lại trong draft agent và flow), `neomind_skill_delete` (bắt buộc `confirmed: true`; skill đang được ghim bị từ chối kèm danh sách nơi dùng, `force` để vẫn xóa), `neomind_skill_usage`, `neomind_profile_archive` và `neomind_profile_delete` (bắt buộc `confirmed: true`; agent còn flow dùng bị từ chối kèm danh sách flow). Tool skill gửi tác giả AI nên `ai.skillEdit: "deny"` chặn được; tool xóa/lưu trữ agent theo `ai.profilePublish: "deny"`. Panel có thêm màn Skills, nhãn Profiles đổi thành Agents.

**Chương trình nhiều giai đoạn (Gói 3, 06/11/2026):** `neomind_program_create`, `neomind_program_list`, `neomind_program_status`, `neomind_program_next` (chỉ gọi sau khi người dùng xác nhận kết quả giai đoạn trước đã vào branch; run mới được gắn vào session như `start`) và `neomind_program_deliver` (`confirmed: true`, đánh dấu giao khi Git không thấy commit). Panel Runs có nhóm Chương trình.

**Rules (Gói 4, 06/11/2026):** tool `neomind_preview` trả thêm `rules` (`[R1] …`) và `ruleWarnings`; `neomind_flow_blocks` trả `rules` để AI biết review sẽ chấm theo rule. Không có tool sửa `rules.md`: rule là quyết định của người dùng, sửa qua Git.

**Chi phí và quota (Gói 5, 06/11/2026):** tool `neomind_stats` (thống kê theo flow/profile/runner, không trả danh sách run chi tiết); `neomind_extend_time` nhận `seconds`, `tokens` hoặc cả hai (gia hạn ngân sách token `maxTokens`); `neomind_status` không đổi, `run list` có `tokens`. `neomind_assess` kèm `statistics` khi project có ≥ 3 run đã xong của flow.

**Panel = editor đầy đủ.**
- Phần định tuyến `/api/*` của server được tách thành `createEditorApi(projectRoot, runs)`. Server HTTP và backend extension dùng chung hàm này, và chung một `RunManager` trong process.
- Panel render `App` của `ui/src` trong shadow root. CSS (`:root` → `:host`) không lẫn với Nimbalyst. `api()` có transport thay được: HTTP trong trình duyệt, `callBackendTool('neomind.api')` trong panel.
- `window.prompt` (Electron không có) được thay bằng hộp nhập trong trang (`ui/src/dialog.tsx`).
- React Flow kéo theo `use-sync-external-store` dạng CommonJS. Bản đó gọi `require('react')`, mà môi trường panel không có `require`, nên extension không nạp được và biểu tượng biến mất. Đã thay bằng bản ESM trong `extensions/nimbalyst/src/shims`.

**Sửa core khi chạy thật:** worktree của run nằm dưới `%LOCALAPPDATA%\neomind\<hash>\workspaces\…`, dài hơn checkout. Repo có file nằm sâu (NeoMind có `references/ai-workflow-kit/...`) thì vượt MAX_PATH và `git worktree add` thất bại. Mọi lệnh git của NeoMind trên Windows giờ dùng `core.longpaths=true`, truyền qua biến môi trường, không sửa config repo.

**Chạy thật từ session (30/10):** session Claude này gọi `neomind_preview`, `neomind_start`, `neomind_wait` và `neomind_session` trên repo NeoMind, flow Research (Codex gpt-6-luna, suy luận thấp).
- Run đi hết các bước: research, review không đạt, vòng sửa, research lại, review đạt, review làm lại vì bằng chứng sai, rồi dừng ở **blocked** sau 86 giây và khoảng 313k token.
- Lý do: hai trích dẫn không khớp nguyên văn. Báo cáo chép sai đường dẫn tuyệt đối của worktree và reviewer "sửa" lại khi trích; reviewer cũng bỏ dấu `!` khi trích một dòng mã. Bước kiểm tra tự động bắt đúng cả hai.
- Đã thêm vào prompt Research: trích nguồn bằng đường dẫn tương đối, không dùng đường dẫn tuyệt đối.

**Lệnh `/neomind:run`** dẫn agent qua `preview`, `start`, `wait`; hỏi người dùng trước `approve` và `apply`.

**Giao diện panel từ đợt thiết kế lại (05/11/2026, [redesign-plan.md](../design/redesign-plan.md) mục 7 và GĐ 1):**
- Panel render `<App shell="panel" />`: chỉ thanh tab 40px, không logo, không sidebar; theme theo Nimbalyst (`<html class="dark-theme" data-theme="…">`, độ sáng nền `body` khi theme tùy biến), theo dõi bằng `MutationObserver` có debounce.
- CSS của panel là `ui/src/app.css?inline` (`:root` → `:host`). Khi mount, `registerDocumentRules` (`ui/src/lib/shadow.ts`) chép các rule `@property` và `@font-face` sang `document.adoptedStyleSheets`: trình duyệt bỏ qua hai loại rule này trong shadow root (mất shadow/ring của Tailwind, font không tải). Chỉ đăng ký biến và font, không đổi giao diện Nimbalyst.
- Radix render Dialog/Select/Tooltip/menu qua Portal; mọi Portal nhận `container` là một node trong lớp bọc theme (`PortalContainer`), nếu không nội dung ra `document.body` và mất style.
- GĐ 5: `app.css` không còn layer `legacy`; Tailwind preflight chạy trong shadow root ở layer `base`, sau React Flow (`xyflow`). Base text trên `.nm-theme` áp dụng cả vùng portal.
- Tailwind chạy trong cả hai bản build; `theme.css` khai báo `@source "./"` vì build panel chạy từ `extensions/nimbalyst`, ngoài `ui/`.
- Nimbalyst cấp React **19.2.7** (repo ghim 19.3.1): không dùng API chỉ có từ React 19.3 trong `ui/src`.

**Giới hạn còn lại:**
- `extension_reload` chỉ nạp lại panel. Backend chỉ chạy bản mới sau khi mở lại workspace.

## Việc tiếp theo

1. Ghép run với session: biết session nào start run nào (`session-runs.jsonl` đã ghi), và báo session khi run cần duyệt hoặc đã xong.
2. Thử run Fast/Dev thật từ một session trên `demo/claude-e2e1`, gồm đóng/mở workspace giữa chừng (recovery).
