# Proof ranh giới authority

`test_chain_boundary_proof.py` dùng PostgreSQL saver thật và graph giả, cùng các store authorization, job và synthetic sink hiện có trong cluster disposable. Các receipt/job được tạo độc lập: không có transaction, foreign key hay protocol bền buộc chúng cùng authority. Test cố ý chứng minh invalidate receipt authorization không ngăn job resume hoặc sink giả ghi; đây là blocker, không phải đường tích hợp an toàn.

Crash trước/sau sink chỉ được quan sát bằng đọc effect DB sau khi process thoát. Nhãn `unknown` trong test là trạng thái giả cục bộ, **không phải journal hay cơ chế recovery bền**. Test không replay effect. Chưa có transaction chung với LangGraph saver, không kiểm side effect filesystem/network/OS, không authentication thực, không chứng minh exactly once. Principal do trusted test host dựng, không lấy làm authority từ caller không tin cậy.

Để ghép thật cần một authority chung gắn receipt/job/sink và revoke theo transaction, contract reconcile checkpoint riêng, cùng fencing tại từng sink; phải test crash và tranh chấp trên chính đường tích hợp mới. Không mở production/live dựa trên proof này.
