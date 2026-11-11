# Bàn giao khôi phục MCP, chạy lại flow và OpenCode — 11/11/2026

## Bối cảnh

Phần làm ngày 07–08/11 (MCP standalone, nút chạy lại run bị chặn, runner OpenCode) chỉ có trên máy cũ và không được commit. Bản copy mang về (`NeoMind.zip`) bị cắt đúng ở 30 MiB: zip mất mục lục, và các thư mục xếp sau `node_modules` (`package.json`, `src/`, `test/`, `ui/`, `README.md`…) không có trong phần giải nén được. Bản copy vẫn còn `dist/` (JavaScript do `tsc` biên dịch kèm `.d.ts`), `dist-ui/` (bundle đã minify) và tài liệu. Sourcemap của extension trong bản copy được build trước 07/11 nên không chứa phần này.

## Đã khôi phục (branch `feat/restore-11-08`, gộp vào `hieu/adaptive-agent-flow`)

| Phần | Cách khôi phục |
| --- | --- |
| `src/cli/mcp.ts`, lệnh `neomind mcp <project>`, `approvalActor` của session tools | Từ `dist/src/cli/*.js` + `.d.ts` |
| `src/domain/rerun.ts` | Từ JS biên dịch |
| Nút **Chạy lại từ đầu** (`RunMonitor`, `RunPanel`, `RunStart.initialTask`) | Viết lại theo bundle UI minify (cùng cấu trúc: `rerun` prop, key `rerun-<flowId>`) |
| `src/adapters/opencode-server.ts`, `src/runners/opencode-{runner,config,session-map}.ts`, đăng ký trong registry, `GET /api/runners/opencode`, `openCodeWarning` trong preview, `runner` trong write admission | Từ JS biên dịch + `.d.ts` |
| Test: `mcp-stdio`, `rerun`, `opencode-config`, `opencode-server`, `opencode-runner`, `helpers/fake-opencode-server`; sửa `editor-server`, `runner-neutral`, `write-admission` | Từ JS biên dịch, thêm kiểu |
| `AGENTS.md`, `implementation-status.md`, bàn giao 07/11 MCP và 08/11 | Chép từ bản copy |
| README mục MCP và OpenCode | Viết lại (README gốc bị mất) |

Kiểm chéo: build lại rồi so output JavaScript với `dist/` của bản copy (bỏ comment và khoảng trắng): trùng khớp, trừ chuỗi Usage có thêm `mcp`, thứ tự khóa `openCodeWarning` trong kết quả preview và một biến không dùng.

## Khác bản gốc

- `@modelcontextprotocol/sdk` 1.32.2 thay vì 1.29.0: `npm audit` báo lỗ hổng ở phần HTTP/OAuth của SDK (stdio không bị ảnh hưởng), bản vá cùng major. `@hono/node-server` được `npm audit fix` nâng. `npm audit` sạch.
- Comment giải thích *vì sao* được thêm ở vài chỗ (cấu hình cô lập, Basic auth chỉ tới loopback, ánh xạ session bằng `link`).

## Quyết định người dùng (11/11)

Giữ OpenCode **đúng như bản build**: runner được đăng ký, bước sửa của OpenCode được cấp chỉ với bằng chứng dừng process (`sandboxVerified: false`). Probe 08/11 cho thấy OpenCode 1.18.25 ghi được ra ngoài repo qua junction; rủi ro này được ghi trong README và preview (`openCodeWarning`).

## Kiểm chứng (Windows)

- `tsc` core và UI, `npm run build:ui`, build extension đạt.
- Test khôi phục và test bị ảnh hưởng: 24/24 đạt.
- `npm test` đầy đủ: 270 test, 266 pass, 2 fail, 2 skip. Hai ca lỗi (crash recovery, parallel writers) đạt khi chạy riêng; thuộc nhóm chập chờn đã biết.
- Chưa chạy run thật; chưa kết nối MCP từ một session Codex/Claude thật; chưa kiểm OpenCode thật.

## Việc còn lại

- Kiểm MCP với Claude Code/Codex CLI thật (README có lệnh đăng ký).
- OpenCode: cơ chế chặn ghi ra ngoài worktree (junction/symlink) hoặc từ chối an toàn trước khi dùng thật; lưu/khôi phục ánh xạ session đã có nhưng chưa kiểm với server thật.
- Hai test chập chờn trên Windows: [known-test-failures-2026-11-07.md](known-test-failures-2026-11-07.md).
- Backlog trong `nimbalyst-local/tracker/tasks.md` (kiểm model khả dụng thật, xóa flow trên UI).
