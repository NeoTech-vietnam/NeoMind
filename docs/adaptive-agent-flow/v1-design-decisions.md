# NeoMind v1: quyết định thiết kế từ bộ câu hỏi

**Cập nhật:** người dùng đã yêu cầu Codex tự thiết kế đầy đủ phần còn lại, rồi tạo chat GPT-6.1 Terra bắt đầu implementation. [Thiết kế tổng hợp](design-v1.md) là baseline hiện tại; tài liệu này giữ quyết định gốc D/F và lịch sử câu hỏi, không yêu cầu hỏi lại các điểm đã được bản tổng hợp xử lý.

Ngày: 28/10/2026. Nhánh: `hieu/adaptive-agent-flow`.

Nguồn: 12 câu trả lời ban đầu và các câu trả lời bổ sung trực tiếp của người dùng trong phiên thiết kế. Đây là các quyết định về hành vi sản phẩm v1, chưa phải bằng chứng runtime hoạt động. Các quyết định này cập nhật những điểm còn mở tương ứng trong `product-direction.md`, `architecture.md` và tài liệu bàn giao. Tiếp tục thiết kế trước khi triển khai.

Xem [sơ đồ kiến trúc và hai môi trường chạy](architecture.md#3-cấu-trúc-logic), [flow, tương tác agent và trạng thái run](architecture.md#10-default-flow-v1-đã-chốt-và-thiết-kế-chuyển-trạng-thái). Các sơ đồ dùng Mermaid để tiếp tục chỉnh sửa cùng đặc tả; cách chia module và tên trạng thái vẫn là đề xuất.

## 1. Các lựa chọn đã xác nhận

| Câu | Chọn | Quyết định |
| --- | --- | --- |
| 1 | A | Một agent khảo sát, lập kế hoạch và thực hiện; agent khác kiểm tra độc lập. |
| 2 | B | Luôn chờ người dùng duyệt kế hoạch trước khi sửa file. |
| 3 | A | Agent kiểm tra đọc thay đổi, chạy checks và báo lỗi; agent thực hiện chịu trách nhiệm sửa. |
| 4 | A | Tối đa hai vòng sửa và kiểm tra lại trong phạm vi kế hoạch đã duyệt; sau đó chờ người dùng quyết định. |
| 5 | A | Runner/model mặc định theo vai trong project; có thể đổi khi bắt đầu run. |
| 6 | C | Khi bắt đầu run, hỏi người dùng chọn Git worktree riêng hoặc checkout hiện tại. |
| 7 | A | Run hoàn thành khi đạt tiêu chí và kiểm tra độc lập thông qua; feedback người dùng có thể bổ sung sau. |
| 8 | B | Tự commit local sau khi kiểm tra đạt; push và tạo PR khi người dùng yêu cầu. |
| 9 | A | Tự lưu tóm tắt và kết quả run; lessons cần người dùng duyệt trước khi thành memory dùng chung. |
| 10 | A | Giao diện Nimbalyst ưu tiên flow, trạng thái, kết quả và nút can thiệp; mở chi tiết session khi cần. |
| 11 | A | Khi cần người dùng trả lời, lưu trạng thái và chờ; tiếp tục sau khi nhận trả lời. |
| 12 | B | Pilot là thêm một tính năng nhỏ trong project đang làm; project và tính năng cụ thể chưa chọn. |

## 2. Flow hành vi đã chốt

```text
Nhập yêu cầu
  -> Chọn workspace và xem/đổi runner, model theo vai
  -> Agent thực hiện khảo sát và lập kế hoạch
  -> Chờ người dùng duyệt kế hoạch
  -> Agent thực hiện sửa file và tự kiểm tra
  -> Agent kiểm tra độc lập đọc thay đổi và chạy checks
       -> đạt: commit local, lưu kết quả và bàn giao
       -> phát hiện lỗi: agent thực hiện sửa -> kiểm tra lại
          (tối đa 2 vòng sửa trong kế hoạch đã duyệt)
       -> cần quyết định hoặc hết giới hạn: lưu trạng thái, chờ người dùng
  -> Feedback và duyệt lessons có thể thực hiện sau
```

Hai vai agent đã được chọn; cách cấp phát/tái sử dụng session qua các vòng sửa còn cần đặc tả. Không đồng nhất số vai với tổng số session được tạo trong cả run.

Kế hoạch được duyệt là ranh giới thực hiện. Việc duyệt ban đầu cho phép các vòng sửa trong phạm vi đó. Đổi mục tiêu, hành vi sản phẩm, mở rộng phạm vi hoặc phát sinh thao tác rủi ro mới cần duyệt lại; chi tiết kỹ thuật trong phạm vi được tự điều chỉnh. Cách gắn approval với phiên bản kế hoạch còn cần đặc tả.

Giới hạn hai vòng được hiểu là sau lần kiểm tra độc lập đầu tiên, cho phép tối đa hai lượt sửa rồi kiểm tra lại. Cách phân biệt lỗi sản phẩm với lỗi môi trường, timeout hoặc kết quả chưa rõ còn cần đặc tả; không tự coi mọi lỗi runtime là một lỗi code có thể sửa.

Điều kiện đạt về kỹ thuật không phụ thuộc việc người dùng đã gửi feedback. Commit local là hành vi cuối flow đã chọn; nếu commit thất bại, run chờ xử lý Git, giữ kết quả kỹ thuật đã đạt và các thay đổi. Người dùng xử lý hoặc cho phép thử commit lại rồi tiếp tục hoàn tất. Nếu code thay đổi trong thời gian chờ, phải kiểm tra tính hợp lệ của bằng chứng trước khi tiếp tục.

## 3. Trách nhiệm

| Thành phần | Trách nhiệm theo quyết định mới |
| --- | --- |
| Người dùng | Cung cấp yêu cầu, chọn workspace, duyệt kế hoạch, trả lời khi run chờ và duyệt lessons. |
| Agent thực hiện | Khảo sát, lập kế hoạch, thực hiện và sửa lỗi trong phạm vi được duyệt. |
| Agent kiểm tra | Đọc yêu cầu/kế hoạch/thay đổi, chạy checks và trả kết quả có bằng chứng; chuyển việc sửa về agent thực hiện. |
| Core | Điều phối, ghi nhận approval, quản lý hai vòng sửa, lưu trạng thái chờ, kiểm tra điều kiện hoàn thành và điều phối commit local. |
| Adapter | Thực thi qua host/runtime và công bố khả năng thực tế; quyền chạy checks của verifier cần được kiểm chứng. |

Việc verifier chạy test có thể sinh build artifacts, caches hoặc fixtures. Cần thiết kế quyền cho các tác động đó; lựa chọn 3A không cho phép verifier tự sửa code để khắc phục lỗi.

## 4. Quyết định bổ sung qua câu hỏi tiếp theo

| Mục | Chọn | Quyết định |
| --- | --- | --- |
| D1 — Kế hoạch | A | Bản duyệt ngắn gọn gồm mục tiêu, phạm vi thay đổi, cách thực hiện, tiêu chí hoàn thành và checks; mở thêm chi tiết khi cần. Đây là câu trả lời mới nhất, thay lựa chọn B trước đó. |
| D2 — Duyệt lại | A | Duyệt lại khi đổi mục tiêu, hành vi sản phẩm, mở rộng phạm vi hoặc có thao tác rủi ro mới; tự điều chỉnh chi tiết kỹ thuật trong phạm vi. |
| D3 — Context kiểm tra | A | Verifier nhận yêu cầu gốc, kế hoạch đã duyệt, code/diff và hướng dẫn kiểm tra; tự đánh giá trước khi xem kết luận của agent thực hiện. |
| D4 — Dirty checkout | A | Hiển thị thay đổi có sẵn; người dùng chọn dùng làm baseline của run, chuyển sang worktree riêng hoặc dừng để xử lý. |
| D5 — Ghi memory | A | Tự cập nhật thông tin thực tế có nguồn; chỉ ghi quyết định khi người dùng đã xác nhận; suy luận chưa xác nhận giữ dạng đề xuất. Lessons vẫn cần duyệt. |
| D6 — Commit lỗi | A | Run chờ xử lý Git, giữ kết quả kỹ thuật và thay đổi; người dùng xử lý hoặc cho phép thử commit lại rồi tiếp tục hoàn tất. |
| D7 — Session kiểm tra | A | Giữ cùng session kiểm tra trong một run để theo dõi lỗi và xác minh việc sửa; tạo mới khi không thể tiếp tục session cũ. |
| D8 — Thay đổi bên ngoài | A | Đối chiếu với kế hoạch: trong phạm vi thì cập nhật baseline và kiểm tra lại phần bị ảnh hưởng; vượt phạm vi thì chờ duyệt lại. |
| D9 — Lỗi môi trường | A | Chỉ tự thử lại checks tối đa một lần nếu lỗi có vẻ tạm thời; còn lỗi thì lưu bằng chứng và chờ người dùng. Không tính lần thử lại này vào hai vòng sửa code. |
| D10 — Thời gian chạy | A | Giới hạn thời gian mặc định theo project, hiển thị và cho đổi đầu run; hết thời gian thì lưu trạng thái và chờ người dùng. |
| D11 — Thiếu telemetry | A | Vẫn cho chạy với giới hạn thời gian và số vòng sửa; hiển thị token/chi phí không đo được, không coi là 0. |

Project memory độc lập với lựa chọn Nimbalyst hoặc CLI. Hai môi trường truy cập cùng nguồn memory của project; session, transcript và run state vẫn thuộc môi trường chạy. Cơ chế chia sẻ giữa worktrees, ghi đồng thời và kiểm tra freshness cần đặc tả.

Baseline có thay đổi sẵn không đồng nghĩa những thay đổi đó được phép đưa vào commit của run. Cách tách changes và tạo worktree có hoặc không kèm nội dung chưa commit còn cần thiết kế, phải hiển thị rõ cho người dùng.

## 5. Chi tiết cần thiết kế tiếp

Các mục dưới đây là vấn đề còn mở, chưa phải lựa chọn đã được duyệt:

1. **Kế hoạch để duyệt:** mẫu hiển thị cụ thể, gắn approval với phiên bản và cách thay thế một kế hoạch đã duyệt; giữ độ ngắn gọn đã chọn.
2. **Bàn giao giữa hai agent:** schema artifacts/baseline/bằng chứng/verdict và thời điểm mở kết luận của implementer; giữ verifier session theo D7, đặc tả recovery khi phải tạo mới.
3. **Trạng thái run:** F19–F20 đã chốt hành vi Tạm dừng/Hủy; cần đặc tả resume, recovery và khả năng xác nhận dừng từng runtime.
4. **Workspace và commit:** baseline khi checkout đã có thay đổi, concurrent edits, tập file thuộc run, nhánh nhận commit và bảo đảm commit đúng nội dung đã kiểm tra.
5. **Cấu hình runner/model:** nơi lưu defaults theo project, overrides cho run, kiểm tra capabilities và auth.
6. **Lưu trữ:** run records, approval và lessons proposals; tránh biến proposal chưa duyệt thành memory chính thức.
7. **Pilot:** chọn project/tính năng, đầu ra và checks cụ thể. Chưa chạy pilot hoặc tự chọn tính năng thay người dùng.

Giới hạn thời gian theo D10 đã được chọn về hành vi; F18 chốt tạm dừng bộ đếm khi toàn run chờ người dùng, còn nhánh chạy thì vẫn tính. Giá trị mặc định và thao tác dừng runtime khi hết hạn chưa chốt. Cần xác định phạm vi bộ đếm thử lại checks để tránh thử lại vô hạn. Thay đổi baseline do người dùng hoặc công cụ khác không tự reset bộ đếm sửa code.

Người dùng đã chọn tạm hoãn pilot, tiếp tục thiết kế hệ thống. Yêu cầu mới về tạo/sửa/xóa/đổi tên nhiều flow, chọn model/reasoning và quan hệ review, cùng editor kéo thả được mô tả trong [thiết kế flow linh hoạt](flow-configuration-design.md). Người dùng chọn phạm vi C: thiết kế đầy đủ cả nhánh song song và nhiều reviewer từ phiên bản đầu, chấp nhận phạm vi lớn hơn. Các quyết định cập nhật tương ứng được ghi dưới đây.

**Cập nhật policy flow:** người dùng đã chốt F1–F4 trong tài liệu flow linh hoạt: workspace theo flow; reviewer bắt buộc/tư vấn, tất cả bắt buộc phải đạt; nhánh độc lập tiếp tục mặc định khi nhánh khác bị chặn; ngân sách sửa ở cấp run và từng vòng sửa trong graph. Các quyết định này cập nhật các điểm tương ứng vừa nêu; isolation, join và cách đếm lượt sửa cụ thể còn cần đặc tả.

**Quản lý flow F5–F8:** templates chung và flow riêng project, cập nhật template không tự đổi flow; flow bị ràng buộc bởi quyền/gate của project; có Archive và xóa vĩnh viễn định nghĩa, lịch sử run quản lý riêng; chỉnh ở draft rồi kiểm tra hợp lệ và lưu phiên bản mới. Run đang chạy giữ snapshot cũ.

**Bindings và concurrency F9–F11:** từng bước chọn Kế thừa/Ghim model và reasoning; trước Run hiển thị cấu hình thực tế. Khi binding không khả dụng, mặc định chờ người dùng; chỉ tự thay trong danh sách flow đã cho phép và ghi lịch sử. Project đặt trần agent chạy đồng thời, flow đặt giới hạn trong trần và có thể giảm đầu run; bước sẵn sàng còn lại xếp hàng.

**Tích hợp, review và profiles F12–F14:** core tự ghép thay đổi không conflict, giao conflict cho agent tích hợp trong kế hoạch đã duyệt rồi kiểm tra kết quả chung. Review lại theo phạm vi ảnh hưởng và reviewer đã báo lỗi; không xác định rõ ảnh hưởng thì chạy lại mọi reviewer bắt buộc. Profiles có thư viện chung và riêng project, cho phép override ở bước trong giới hạn policy.

**Nhiều run và lưu cấu hình F15–F17:** mức trần agent áp dụng riêng từng run. Mỗi workspace chỉ có một run được sửa; run khác dùng worktree riêng hoặc chờ, run chỉ đọc cần baseline ổn định. Flow/profiles riêng project lưu file trong repo theo Git, layout canvas đi cùng flow; run state và cấu hình cá nhân lưu riêng.

**Thời gian và điều khiển F18–F20:** chỉ tính thời gian xử lý tự động, ngừng đếm khi toàn run chờ người dùng. Tạm dừng ngừng dispatch và yêu cầu ngắt agents, tiếp tục phải reconcile. Hủy giữ code/artifacts/lịch sử, xác nhận dừng rồi mới đánh dấu đã hủy; không tự rollback hoặc xóa worktree.

**Khôi phục F21:** sau khi host/CLI đóng hoặc crash rồi mở lại, tự đối chiếu session, code và trạng thái đã lưu; hiển thị kết quả và chờ người dùng bấm Tiếp tục trước khi giao thêm việc. Không tự dispatch chỉ vì startup reconciliation thành công.
