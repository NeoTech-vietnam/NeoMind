# M7a — REA và managed gateway: khả thi và bước nghiệm thu tiếp theo

Khảo sát ngày **2026-11-09**, nhánh `codex/workforce-vscode-native`. Đây là nghiên cứu read-only, **chưa đạt M7a/M7b**. Chỉ đọc metadata và một tập file công khai được pin; không clone toàn repo, tải tarball, cài package, chạy REA/gateway/model, đổi settings hoặc sao chép credentials.

## 1. Những gì thực sự có sẵn

- Fixture `artifacts/workforce-native-local-proof/c3f40d36/workspace` hiện có **REA disabled, chưa installed, chưa có discovery observation**. Các provider trong control panel cũng chưa được cài. Không dùng smoke lịch sử ở project khác để gọi fixture này ready.
- Có sẵn `reaPin`, `configureRea`, `connectRea`, `callReaTool`, `probeRea`, `readReaSkillBundle` trong [src/rea.ts](../../src/rea.ts); `setPluginEnabled`/`installPlugin`/`probePlugin` trong [plugin-control](../../src/plugin-control.ts). Tái sử dụng policy, lock, pin, schema validation và bounded stdio; không xây thêm registry hoặc bước claim thủ công.
- `reaToolsForRole` hiện chỉ cấp cho các role lịch sử `researcher`/`codebase-analyst`. **WF.P-RES native chỉ có `read`/`search`**, chưa có binding REA: [native contract](../../src/native-local-contract.ts). Bật provider không tự làm native worker thấy tools. Không đưa native worker trở lại historical signed invocation/claim gateway để nối tạm.
- [router-probe](../../src/router-probe.ts) đã có `checkRouterHealth`, `listRouterModels`, `probeRouter`, giới hạn loopback, timeout/cancellation, response size và lỗi đã lọc. Đây là client foundation, chưa phải managed server hay streaming executor.

## 2. Nguồn và pin đã kiểm tra

| Thành phần | Danh tính đã quan sát | Cách sử dụng |
| --- | --- | --- |
| 9router source | `decolua/9router`, commit **`1339107e624d1ab150c6a0c2c2ee22caa7e9db2f`**, app/CLI **0.5.116**, MIT | Candidate cho M7; chưa qualification runtime. [App manifest][router-package], [CLI manifest][router-cli], [license][router-license] |
| 9router published artifact | npm **`9router@0.5.116`**, metadata `gitHead` trùng commit trên; 3,699 files, 60,899,008 bytes unpacked | Entry `cli.js`; package bao gồm `app`. Chỉ mới đọc metadata, chưa xác minh bytes tarball. [Exact npm metadata][router-npm] |
| REA runtime WorkForce đang pin | npm **`rea-agents@6.7.0`**, MIT, Node `^22.19.0 || ^24.11.0 || >=26.0.0`; npm không cung cấp `gitHead` | Giữ pin hiện có và skill/reference/license **cùng published package**. Không tuyên bố bằng source HEAD. [Exact npm metadata][rea-npm], [local pin](../../src/rea.ts) |
| REA source hiện tại | `morluto/rea`, commit **`c78c8aed403b955680a342f5ad38680867e3858f`**, package **6.8.0**, Node minimum đã tăng | Chỉ tham khảo thay đổi; không tự nâng runtime. [Manifest][rea-current], [README][rea-readme] |

Integrity npm đã đọc, cần xác minh lại trên **bytes thực tải** khi thực hiện:

```text
9router@0.5.116:
sha512-Ny4N80cuLBjGmSpOluIwjd0kOk5IZJX26vYDZ+xZunvcVUIHX1h9/t9yu5rfiy6hlXkE6H0rVizD794P1YKMjw==
rea-agents@6.7.0:
sha512-yhIx2ioJYYT1C/tONfYeitC6LhnKmCh+ZwRUOgYuhSc733lGhkkt73zhug9WmLgxoMdKuqIYGCoBfD4fXkOhFw==
```

9router Git tree được đọc ở đúng pin: 2,367 entries, 568,892 bytes, `truncated:false`. Đây là inventory source, không phải inventory tarball. Giữ MIT notices của hai upstream và kiểm tra notices/dependency licenses khi đóng gói. [REA license ở pin khảo sát cũ][rea-license]; nghiên cứu [9router 2026-10-23](9router-integration.md) giữ giá trị lịch sử, không thay candidate mới bằng version cũ.

## 3. Điểm tích hợp 9router được source xác nhận

| Năng lực | Entry/API tại pin 0.5.116 | Ranh giới cần giữ |
| --- | --- | --- |
| Service | Next standalone; CLI `9router → cli.js`; build copy standalone vào `cli/app` | Suy luận kiến trúc: quản lý service riêng thay vì import Next dashboard vào orchestrator; manifest không công bố library `exports`. [CLI][router-cli], [build packaging][router-build] |
| Health/discovery | `GET /api/health`; `GET /v1/models` | Health không chứng minh model/quota. Catalog có connections, live/static models, aliases, combos và key filtering; giữ nguyên IDs. [Health][router-health], [models][router-models], [rewrites][router-rewrites] |
| Inference | `POST /v1/chat/completions`, `/v1/responses`, `/v1/messages` → `src/sse/handlers/chat.js::handleChat` → `open-sse/handlers/chatCore.js` | Có protocol translation; WorkForce phải kiểm thử streaming, tool-call IDs/results, cancellation và error mapping thực. [Chat route][router-chat-route], [handler][router-handler] |
| Connections | `/api/providers`; `/api/oauth/{provider}/{action}` | Tái sử dụng UI/flow upstream, không thu tokens từ extensions khác. [OAuth route][router-oauth] |
| Quota/usage | `/api/usage/{connectionId}`, `/api/usage/stats`, `/api/usage/stream` | Admin authorization riêng; quota có thể unknown. Chỉ gán usage của request đi qua gateway. [Usage stream][router-usage], [dashboard guard][router-guard] |
| RTK | `open-sse/rtk/index.js::compressMessages`, trước translation trong chat core | Nén tool-result theo dạng message; giữ raw host evidence, đo before/after, kiểm tra không mất compiler/assertion errors. Không suy từ quảng cáo thành tiết kiệm đã đo. [RTK][router-rtk] |
| Combo/vision | `open-sse/services/combo.js`; `capacityAdapter.js` | Có thêm/reorder fallback candidates và biến đổi tool history theo strategy. Adapter bật nhưng pool rỗng có default model upstream: phải giới hạn bằng authorization của WorkForce, không âm thầm dùng pool/model ngoài lựa chọn. [Combos][router-combo], [capacity adapter][router-capacity] |

Bindings được đọc từ registry và OAuth provider implementations; đây là support trong source, **chưa phải đăng nhập/inference thành công**:

| Provider ID / alias | Flow source | API backend khai báo |
| --- | --- | --- |
| `codex` / `cx` | Authorization code + PKCE | `https://chatgpt.com/backend-api/codex/responses` — [registry][router-codex], [flow][router-codex-oauth] |
| `github` / `gh` | Device code | `https://api.githubcopilot.com/chat/completions` — [registry][router-github], [flow][router-github-oauth] |
| `claude` / `cc` | Authorization code + PKCE | `https://api.anthropic.com/v1/messages` — [registry][router-claude], [flow][router-claude-oauth] |

Đây là ba bindings theo yêu cầu, không phải danh sách provider cố định của WorkForce. Catalog upstream còn nhiều adapters; chỉ công bố capabilities đã quan sát và được phép dùng.

## 4. Đường REA thực tế nhỏ nhất, không giả evidence

**Không dùng REA chỉ để đọc kiến trúc source.** Upstream skill yêu cầu dùng repository tools cho trường hợp đó. Feature/dependency map ở bảng trên dùng read/search; REA có nhiệm vụ khác: kiểm tra **shipped artifact** và đối chiếu packaging/lifecycle với source. [REA skill tại pin khảo sát][rea-skill]

1. Dùng fixture riêng dưới root thử nghiệm; kiểm tra policy hiện hữu rồi cài/probe pin 6.7.0 bằng APIs có sẵn khi chuyển sang thực thi. Fixture legacy hiện thiếu `network_policy`, khác default local-only của native mới: không tự đổi policy hoặc lấy credentials project khác. Đọc skill bundle bằng `readReaSkillBundle`; bản source skill dưới `.agents/skills` không thay thế package-generated bundle.
2. Acquisition riêng: tải đúng tarball `https://registry.npmjs.org/9router/-/9router-0.5.116.tgz`, có byte/time/expansion limits, xác minh SHA-512 trên; **không `npm install`, không postinstall**. Đọc tar inventory trước, chỉ nhận regular files, từ chối absolute/traversal/links. Package đầy đủ vượt giới hạn target 32MiB hiện tại: không đưa cả package vào REA và không tăng limit để lách.
3. Target nhỏ đề xuất: published `cli.js`, `package.json`, `LICENSE`, cùng generated `app/server.js`/`app/custom-server.js` **nếu inventory tarball thật xác nhận chúng**. Build source chỉ xác định đây là candidates, chưa chứng minh layout tarball. Chọn dependencies cần thiết từ inventory bằng exact paths; tối đa 32 files/4MiB tổng/1MiB mỗi file. Tạo public artifact view dưới fixture, giữ original bytes và manifest `tarball integrity → original entry → materialized path → SHA-256`; không chép `.env`, dependency tree hoặc user config. Nếu thiếu imports/runtime chunks, ghi rõ partial artifact và giới hạn kết luận, không tự dựng bootstrap thay thế. [Published manifest][router-cli], [standalone copy logic][router-build]
4. Một `connectRea` connection thật; observe server/version và `tools/list`, lấy schemas đang quảng bá. Sau `binary_session`, gọi `analyze_javascript_application` cho **public artifact directory**; tiếp tục `inspect_analysis_view`/`get_evidence_bundle` trong cùng session. Dùng `callReaTool` và AbortSignal; không đoán payload/retained IDs, không chạy artifact/provider. Adapter hiện giữ target bounds và schema checks; probe target-free không được tính là analysis. [REA adapter](../../src/rea.ts), [verification boundaries](../rea.md)
5. WF.P-RES đối chiếu các source anchors/pin với retained evidence: bootstrap nào được shipped, module/import nào thực có, dependency/runtime nào thiếu, startup/data-directory assumptions nào cần M7b test. Report có exact target hashes, actual calls, findings, limitations, evidence IDs/digest và kết quả close/cancel. Không gọi source-reading hoặc `REA enabled` là M7a đạt.

**Phần wiring còn thiếu:** gắn đúng reviewed MCP tools và original skill bundle vào native WF.P-RES qua host MCP/tool discovery hiện có, đúng fixture scope; kiểm thử actual named subagent tool calls trước khi đánh dấu binding usable. Nếu host chưa hỗ trợ binding này, ghi rõ chưa hỗ trợ; host-side REA smoke riêng không chứng minh worker dùng REA. Không sửa native orchestration để quay về claims cũ.

## 5. M7b: tái sử dụng service, giữ đường Local hiện tại

Đề xuất tối thiểu sau M7a: WorkForce quản lý artifact/version/lifecycle của sidecar; tái sử dụng dashboard upstream cho account/combos khi cần. Đăng ký một provider qua `contributes.languageModelChatProviders` + `lm.registerLanguageModelChatProvider`, triển khai discovery/response streaming/token count. Model picker/role choices dùng inventory VS Code, không bắt alias `top-models`/`worker-models`; models native khác tiếp tục đi trực tiếp. Host/API và enterprise policy vẫn cần kiểm tra trong VS Code thực. [Official provider guide][vscode-provider]

Các điểm bắt buộc kiểm thử trước khi service được dùng:

- **State/lifecycle:** chỉ loopback; start-on-use, process ownership, shutdown/restart/cancel. `DATA_DIR` hiện có fallback sang user default nếu path lỗi/quyền: managed host phải xác minh data directory thực, không chấp nhận rơi vào global state. CLI postinstall/lazy runtime còn có downloads/SQLite/tray; không chạy những hooks đó ngoài policy hoặc coi source pin là dependency closure. [Data dir][router-data], [postinstall][router-postinstall], [manifest][router-cli]
- **Auth:** inference Bearer key và dashboard sessions là hai ranh giới. `settings.requireApiKey` điều khiển inference enforcement; managed service cần thiết lập rõ. Upstream giữ account credentials trong owned service data; extension chỉ giữ secret của kết nối nó sở hữu. Không có tokens trong prompts/repo/evidence. [Handler][router-handler], [guard][router-guard]
- **Behavior:** request Local thật có stream → tool call → tool result → final; stop/cancel không tạo duplicate call; phân loại auth/quota/transport/provider errors; authorized fallback/combo/vision có observed route. RTK test giữ raw evidence và các negative controls. Usage ngoài gateway không cộng vào gateway totals.
- **Update:** candidate → pinned artifact+dependency/license inventory → regression → activate khi không đổi invocation đang chạy; giữ previous artifact/data backup và rollback. Catalog/model label không chứng minh upstream model thực tế hoặc quota còn dùng được.

## 6. Acceptance tiếp theo và trạng thái

| Bước | Điều kiện đạt | Hiện tại |
| --- | --- | --- |
| M7a preparation | Pins/licenses, source/API map, owned-state gaps, bounded artifact target | Đã ghi trong tài liệu này |
| Actual REA | Installed pin + observed schemas + native WF.P-RES call + retained artifact evidence + limitations | **Chưa thực hiện** |
| Gateway compatibility | Service packaging/data confinement + health/models + provider-free local lifecycle checks | **Chưa thực hiện** |
| M7b providers | Actual Local stream/tools/cancel + authorized account/quota/usage/RTK/combo/vision acceptance | **Chưa thực hiện** |

Không đổi checklist M7/M8 từ nghiên cứu này. Không cần credentials để chuẩn bị source map hoặc static REA; việc chứng minh provider connections về sau cần account/quota hợp lệ của từng provider.

[router-package]: https://github.com/decolua/9router/blob/1339107e624d1ab150c6a0c2c2ee22caa7e9db2f/package.json
[router-cli]: https://github.com/decolua/9router/blob/1339107e624d1ab150c6a0c2c2ee22caa7e9db2f/cli/package.json
[router-license]: https://github.com/decolua/9router/blob/1339107e624d1ab150c6a0c2c2ee22caa7e9db2f/LICENSE
[router-npm]: https://registry.npmjs.org/9router/0.5.116
[router-build]: https://github.com/decolua/9router/blob/1339107e624d1ab150c6a0c2c2ee22caa7e9db2f/cli/scripts/build-cli.js
[router-health]: https://github.com/decolua/9router/blob/1339107e624d1ab150c6a0c2c2ee22caa7e9db2f/src/app/api/health/route.js
[router-models]: https://github.com/decolua/9router/blob/1339107e624d1ab150c6a0c2c2ee22caa7e9db2f/src/app/api/v1/models/route.js
[router-rewrites]: https://github.com/decolua/9router/blob/1339107e624d1ab150c6a0c2c2ee22caa7e9db2f/next.config.mjs
[router-chat-route]: https://github.com/decolua/9router/blob/1339107e624d1ab150c6a0c2c2ee22caa7e9db2f/src/app/api/v1/chat/completions/route.js
[router-handler]: https://github.com/decolua/9router/blob/1339107e624d1ab150c6a0c2c2ee22caa7e9db2f/src/sse/handlers/chat.js
[router-oauth]: https://github.com/decolua/9router/blob/1339107e624d1ab150c6a0c2c2ee22caa7e9db2f/src/app/api/oauth/%5Bprovider%5D/%5Baction%5D/route.js
[router-usage]: https://github.com/decolua/9router/blob/1339107e624d1ab150c6a0c2c2ee22caa7e9db2f/src/app/api/usage/stream/route.js
[router-guard]: https://github.com/decolua/9router/blob/1339107e624d1ab150c6a0c2c2ee22caa7e9db2f/src/dashboardGuard.js
[router-rtk]: https://github.com/decolua/9router/blob/1339107e624d1ab150c6a0c2c2ee22caa7e9db2f/open-sse/rtk/index.js
[router-combo]: https://github.com/decolua/9router/blob/1339107e624d1ab150c6a0c2c2ee22caa7e9db2f/open-sse/services/combo.js
[router-capacity]: https://github.com/decolua/9router/blob/1339107e624d1ab150c6a0c2c2ee22caa7e9db2f/open-sse/services/capacityAdapter.js
[router-codex]: https://github.com/decolua/9router/blob/1339107e624d1ab150c6a0c2c2ee22caa7e9db2f/open-sse/providers/registry/codex.js
[router-github]: https://github.com/decolua/9router/blob/1339107e624d1ab150c6a0c2c2ee22caa7e9db2f/open-sse/providers/registry/github.js
[router-claude]: https://github.com/decolua/9router/blob/1339107e624d1ab150c6a0c2c2ee22caa7e9db2f/open-sse/providers/registry/claude.js
[router-codex-oauth]: https://github.com/decolua/9router/blob/1339107e624d1ab150c6a0c2c2ee22caa7e9db2f/src/lib/oauth/providers/codex.js
[router-github-oauth]: https://github.com/decolua/9router/blob/1339107e624d1ab150c6a0c2c2ee22caa7e9db2f/src/lib/oauth/providers/github.js
[router-claude-oauth]: https://github.com/decolua/9router/blob/1339107e624d1ab150c6a0c2c2ee22caa7e9db2f/src/lib/oauth/providers/claude.js
[router-data]: https://github.com/decolua/9router/blob/1339107e624d1ab150c6a0c2c2ee22caa7e9db2f/src/lib/dataDir.js
[router-postinstall]: https://github.com/decolua/9router/blob/1339107e624d1ab150c6a0c2c2ee22caa7e9db2f/cli/hooks/postinstall.js
[rea-npm]: https://registry.npmjs.org/rea-agents/6.7.0
[rea-current]: https://github.com/morluto/rea/blob/c78c8aed403b955680a342f5ad38680867e3858f/package.json
[rea-readme]: https://github.com/morluto/rea/blob/c78c8aed403b955680a342f5ad38680867e3858f/README.md
[rea-license]: https://github.com/morluto/rea/blob/e073f64be0a5a30c32d8b3cec23f9bd411080903/LICENSE
[rea-skill]: https://github.com/morluto/rea/blob/e073f64be0a5a30c32d8b3cec23f9bd411080903/.agents/skills/reverse-engineer-anything/SKILL.md
[vscode-provider]: https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider
