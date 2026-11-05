# Brief chung cho mockup v2

Mọi file `*-v2.mockup.html` theo brief này để các màn khớp nhau. Hướng thiết kế và lý do: [redesign-plan.md](../redesign-plan.md) (mục 2, 4, 4a). Chuẩn chất lượng: [10-session-viewer-v2.mockup.html](10-session-viewer-v2.mockup.html).

## Kỹ thuật

- File HTML độc lập, không tải gì từ mạng. Chép nguyên khối [v2-shared.css](v2-shared.css) (từ `NEOMIND V2 SHARED STYLES` tới `END`) vào `<style>` đầu tiên; style riêng của màn đặt sau, **chỉ dùng token** (`var(--…)`), không viết mã màu trực tiếp.
- `<body class="theme-dark shell-web">`. Cuối file có thanh mockup và script dưới đây (đổi theme tối/sáng, shell web/panel; đọc hash `#light`, `#panel` để chụp ảnh). Thêm nút trạng thái riêng của màn vào cùng thanh nếu cần.
- Icon: SVG nét kiểu Lucide, `class="i"`, `viewBox="0 0 24 24"`, không dùng emoji hay ký tự Unicode làm icon.
- Màn nằm trong shell: `.app` > `.topbar` + `.sidebar` + `.main`, và `.panel-tabs` (ẩn ở shell web). Shell panel = trong Nimbalyst: không logo, không sidebar, thanh tab 40px.
- Nút chính (`.btn.primary`) tối đa một mỗi màn. Màu chỉ dùng cho trạng thái (`.s-running/.s-attention/.s-danger/.s-success/.s-idle`).
- Nhãn tiếng Việt; giữ thuật ngữ: flow, run, commit, review, worktree, profile, memory, lesson, checks, diff, token.

```html
<div class="mock-bar">
  <button data-theme="dark" class="on">Tối</button><button data-theme="light">Sáng</button>
  <button data-shell="web" class="on">Web</button><button data-shell="panel">Panel Nimbalyst</button>
</div>
<script>
/* NEOMIND V2 MOCK SCRIPT */
(() => {
  const body = document.body, set = (kind, value) => {
    body.classList.remove(`${kind}-dark`, `${kind}-light`, `${kind}-web`, `${kind}-panel`);
    body.classList.add(`${kind}-${value}`);
    document.querySelectorAll(`[data-${kind}]`).forEach(b => b.classList.toggle('on', b.dataset[kind] === value));
  };
  document.querySelectorAll('[data-theme]').forEach(b => b.addEventListener('click', () => set('theme', b.dataset.theme)));
  document.querySelectorAll('[data-shell]').forEach(b => b.addEventListener('click', () => set('shell', b.dataset.shell)));
  const hash = location.hash.slice(1).split(',');
  if (hash.includes('light')) set('theme', 'light');
  if (hash.includes('panel')) set('shell', 'panel');
})();
</script>
```

## Shell và điều hướng

- Logo: `<span class="logo-mark"><svg class="i sm" viewBox="0 0 24 24"><path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/></svg></span>NeoMind` (dấu sao 6 cánh trên ô clay), giống hệt ở mọi màn.
- Sidebar web (thứ tự): **Runs** (đếm "2" màu hổ phách = run cần bạn), **Flows**, **Profiles**, **Memory**; nhóm "Flows" bên dưới liệt kê flow. Topbar: logo NeoMind (ô clay nhỏ, chỗ duy nhất có clay), chip project `neomind-demo · W:\projects\neomind-demo` (đường dẫn rút gọn), bên phải nút tìm `Ctrl K` và công tắc theme.
- Panel tabs: `Runs 2 · Flows · Profiles · Memory`.

## Bố cục màn Runs (dùng chung cho mọi trạng thái run)

- Hai ngăn: danh sách run 288px (240px ở panel) | chi tiết run.
- Danh sách: nút `+ Run mới` (nút viền, không phải nút chính) và ô tìm; nhóm **Cần bạn** / **Đang chạy** / **Gần đây**; mỗi dòng: chấm trạng thái, yêu cầu (1 dòng, cắt …), dòng phụ `Dev · 12 phút trước`.
- Chi tiết: header gồm badge trạng thái, yêu cầu (16px, 600), dòng phụ `Dev v3 · worktree riêng · 4 phút 12 giây · 182k tokens`, hành động bên phải; dưới là stepper ngang các bước của flow (`.stepper`); rồi nội dung theo trạng thái. "Xem session" mở thành `.sheet` bên phải (giống mockup 10).

## Dữ liệu mẫu (dùng thống nhất)

- Project `neomind-demo`, branch `main`. Flows: **Dev** v3, **Dev song song** v1, **Fast** (mẫu có sẵn), **Research** (mẫu có sẵn).
- Bước flow Dev: Lập kế hoạch → Duyệt kế hoạch → Thực hiện → Review độc lập → Vòng sửa (tối đa 2) → Commit local.
- Agent: Lập kế hoạch = Claude Code · Opus 5.5; Thực hiện = Claude Code · Sonnet 5.5; Review = Codex · GPT-6.1 Sol. Checks luôn chạy qua sandbox Codex.
- Model hợp lệ: Codex `GPT-6.1 Sol`, `GPT-6.1 Terra`, `GPT-6 Luna`; Claude Code `Sonnet 5.5` (mặc định), `Haiku 5.5`, `Opus 5.5`. Không có model nào khác.
- Runs:

| Yêu cầu | Flow | Trạng thái |
| --- | --- | --- |
| Thêm hàm power(a, b) vào calc.js và viết test | Dev | Chờ duyệt kế hoạch (`s-attention`) |
| Sửa lỗi chia cho 0 trong divide() | Dev | Bị chặn: review cần quyết định (`s-attention`) |
| Viết lại phần cài đặt trong README | Dev song song | Đang chạy (`s-running`) |
| Thêm cờ --precision cho CLI | Dev | Xong, commit `a1b2c3d` (`s-success`) |
| Tách module parser | Fast | Lỗi: checks thất bại (`s-danger`) |
| Dọn test cũ | Fast | Đã hủy (`s-idle`) |

- File trong repo mẫu: `calc.js`, `calc.test.js`, `cli.js`, `README.md`, `package.json`. Checks: `npm test`.
