/** Repair lessons as runs wrote them before 12/11 (reviewer JSON cut at 5000 characters plus the agent's reply) and as they write them now. */
const quote = 'Hint: Thử lần theo hai chỉ số `i` và `j` ngay ở lần lặp đầu tiên với mảng một phần tử.';
const artifact = (text: string) => ({ kind: 'artifact', nodeId: 'coach', sha256: '30e30402e4c426dec6c5c4560eb261121b90220370513360850208413f745c1d', quote: text });
const evidence = {
  nodeId: 'audit', attemptId: 'ad9d9f4a-e7f2-4182-a942-a0c957a4917e',
  summary: 'Báo cáo viết bằng tiếng Việt và có đủ các mục checklist. Tuy nhiên, phần gợi ý lặp lại thêm một hint cho cùng vấn đề correctness; kết quả build/test cũng chưa được kiểm chứng lại.',
  evidence: {
    criteria: ['R1 no solution code or full algorithm', 'R2 one hint per issue', 'R3 full firmware checklist covered', 'R4 no file or learning-status change', 'R5 every claim backed by trace or run', 'R6 Vietnamese report', 'R7 severity order'].map((criterion, index) => ({ criterion, status: index === 1 || index === 4 ? 'fail' : 'pass', references: [artifact(quote), artifact('| Correctness | BUG |')] })),
    findings: [{ id: 'F1', criterion: 'R2 one hint per issue', explanation: 'Vấn đề correctness có một hint trong phần finding và thêm một hint trong “Gợi ý bước tiếp theo”, khiến cùng một issue nhận hai gợi ý.', references: [artifact(quote)] },
      { id: 'F2', criterion: 'R5 every claim backed by trace or run', explanation: 'Báo cáo khẳng định độ phức tạp O(n) nhưng code thật duyệt hai vòng lồng nhau (O(n²)); mục TLE không dẫn trace hay kết quả chạy nào.',
        references: [{ kind: 'source', path: 'c/hash/0217-contains-duplicate/solution.c', line: 9, quote: 'for (int j = i + 1; j < numsSize; j++) {' }, artifact(quote)] }],
  },
  result: { reviewerId: 'reviewer', sessionId: 'thread-1', baselineHash: 'f1c27536944ce2d23f06f79658776c3d4938f8d532d072469cba5ccb4cd24259', verdict: 'needs_changes', findingIds: ['F1', 'F2'] },
};
const reply = 'Đã sửa báo cáo review: bỏ hint thứ hai trong mục “Gợi ý bước tiếp theo”, chỉ giữ một hint cho mỗi vấn đề. Mục độ phức tạp giờ dẫn đúng dòng 9 của solution.c và kết quả chạy test. '.repeat(12);

export const legacyLessonBody = (runId: string, findingId: string) => `Review finding corrected in run ${runId}: ${findingId}\n\nOriginal review evidence:\n${JSON.stringify(evidence).slice(0, 5000)}\n\nImplementation response:\n${reply.slice(0, 3000)}\n\nThis is a proposed lesson from a completed repair. Review its applicability before sharing.`;
export const shortLessonBody = 'Giữ đúng tiêu chí review: R2 one first-rung hint per issue and nothing else reveals more\nVấn đề: Hint của issue TLE chỉ hỏi "bạn nghĩ tới cấu trúc nào?" nhưng mục ghi chú cho notes.md nêu thẳng "hash set hoặc sort rồi duyệt", nên một phần khác của review lộ nhiều hơn hint đó.\nĐã sửa trong run run-b00f9a41-afff-419e-aebe-7c790c4ebaa8 (bước audit). File: c/hash/0217-contains-duplicate/notes.md:4';
