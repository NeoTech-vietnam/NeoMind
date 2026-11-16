# Xem trước graph LangConfig

Prototype chỉ đọc, không import, lưu, publish, compile hay chạy flow. Nhận JSON
`WorkflowBlueprint` trực tiếp hoặc `.langconfig` workflow export version `1.0`
qua stdin; xuất JSON mô tả và diagnostics ra stdout. Hai schema được xử lý riêng;
không coi `workflow.blueprint` là `workflow.configuration` hay tự thay thế khi
thiếu configuration. Không đọc tệp theo đường dẫn, không truy cập mạng hay model.

```sh
python3 experiments/langconfig-opencode/graph-preview/preview.py < blueprint.json
python3 -B -m unittest discover -s experiments/langconfig-opencode/graph-preview -p 'test_*.py'
```

Nguồn cấu trúc: LangConfig ghim `eb786cf8efe0b6cc9e45d07362e66da6ec465424`,
`backend/schemas/workflow_blueprint.py:212-254,274-314,356-404`; export thực ở
`backend/services/workflow_config_service.py:26-27,77-108`; canvas được lưu tại
`src/features/workflows/canvas/WorkflowCanvas.tsx:1701-1727` và được executor đọc
tại `backend/core/workflows/executor.py:1549-1562,1598-1619,1637-1671,1752-1863`.
NeoMind
`src/domain/schema.ts:3,36,49-77` và `src/domain/compiler.ts:241` mô tả ID,
node, outcome và giới hạn DAG.

Với blueprint, `start`/`end` được gợi ý loại `start`/`finish`, cạnh direct gợi ý
`completed`. Với export chỉ gợi ý start/finish cho type tường minh không mâu
thuẫn; cạnh chỉ là topology, không gợi ý outcome. Tất cả là **xấp xỉ hình thức**,
không chứng minh tương đương runtime. Node khác, conditional, `__END__`, handler,
config và trường lạ đều được báo; loop không được chuyển thành repair. ID xuất
ra là alias tổng hợp, tên, nhãn, ID gốc, giá trị config/tool và tên trường lạ
không được sao chép. Có thể có nhiều diagnostics ngay cả khi graph đơn
giản; mã thoát 0 chỉ nghĩa là đã tạo báo cáo, không nghĩa là tương thích.
JSON sai cú pháp trả mã 2. Output không phải schema Flow, không chứa policy,
permissions, bindings hay thông tin đủ để thực thi. Chưa kiểm toàn bộ ràng
buộc blueprint/export, tính reachability, quy tắc entry hay policy của NeoMind;
không round-trip. File JSON fixture chỉ là ví dụ tổng hợp, không phải export
thu được từ workflow thật.

## Giới hạn input không tin cậy

CLI đọc tối đa 1.048.576 byte UTF-8; quá giới hạn trả mã 2 và `input_limit`.
JSON trùng key, sai UTF-8, số NaN/Infinity hoặc quá sâu đối với parser trả
`invalid_json` và mã 2, không phản chiếu chuỗi lỗi. API `preview()` cũng kiểm
giới hạn ước lượng kích thước, 20.000 giá trị/key và độ sâu 64; số không hữu hạn,
chu trình object hoặc kiểu không phải JSON bị từ chối. Giới hạn ước lượng của API
có thể nghiêm hơn kích thước byte JSON ban đầu. Graph tối đa 500 node, 2.000 cạnh;
vượt giới hạn trả diagnostic và graph rỗng, không cắt thành graph một phần.
Diagnostics cho giới hạn/độ sâu sau parse vẫn là báo cáo preview và CLI trả 0;
phải kiểm diagnostics, không dùng exit code như chứng nhận an toàn.

Tham chiếu được đối chiếu theo ID gốc rồi mới đổi alias; alias không được tra
ngược như ID gốc. ID trùng kể cả ở node sai định dạng đều làm tham chiếu mơ hồ.
Export báo thiếu `config` top-level của node thực thi mà không tự thay bằng
`data.config`. Không sao chép giá trị hay key lạ vào diagnostics. Các giới hạn
này không biến parser hoặc môi trường chạy thành sandbox hay đảm bảo chống mọi
kiểu tấn công tài nguyên; tránh dùng input nhạy cảm trong log của shell gọi lệnh.
