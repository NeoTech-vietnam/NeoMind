# Reference snapshots

Các bản tham khảo phục vụ nghiên cứu NeoMind. Nội dung bên trong snapshot là tư liệu của dự án nguồn; không tự cài hooks, kích hoạt skills hoặc áp dụng chính sách của dự án nguồn vào NeoMind.

## ai-workflow-kit

- Nguồn: `/home/hieu-tran/Downloads/ai-workflow-kit.zip`, do người dùng cung cấp và xác nhận đã dùng trong dự án khác.
- Nhập ngày: 28/10/2026.
- [ZIP gốc](ai-workflow-kit.zip), giữ nguyên byte, bao gồm metadata Git trong archive.
- [Bản giải nén](ai-workflow-kit/README.md): 295 files; bỏ 14 entries `.git` để tránh repository lồng nhau. Khi kiểm tra cuối, `tests/test_templates.py` đã có thay đổi local (`BANNED = []`) so với ZIP; giữ lại và ghi cả hashes gốc/hiện tại trong manifest.
- SHA-256 ZIP: `1d24385591ed2852b4bd6c1d6351a32840d8a59a93fd22283bae2c8ac576ae6a`.
- [Manifest và hashes](ai-workflow-kit.provenance.json).
- [Nghiên cứu kế thừa](../docs/adaptive-agent-flow/ai-workflow-kit-analysis.md).
- [Bằng chứng chạy test](../docs/adaptive-agent-flow/evidence/ai-workflow-kit-tests.txt).

ZIP là bản gốc để đối chiếu. Những thay đổi phát triển sau này nên đặt ngoài snapshot. Chưa chạy installer vào NeoMind, chưa cài dependency hoặc thay đổi cấu hình agent của workspace.
