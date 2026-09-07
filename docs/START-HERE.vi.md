# Dùng bản workspace và harness mới

Nexestra hiện có một luồng chung cho nghiên cứu, tài liệu, thiết kế và code:
**ý định → brief → task có tiêu chí → Worker thực hiện → xem đầu ra → duyệt hoặc sửa**.
Goals nối các task thành một chuỗi có giới hạn và dừng tại bước cần người dùng đánh giá.

## Mở bản mới

Mã nguồn ở nhánh `codex/workspace-harness-foundation`, trong worktree:
`/Users/vunguyen13/Works/Nexestra/.worktrees/workspace-harness`.

Trên máy hiện tại, Node phù hợp nằm trong `/opt/homebrew/bin`. Chạy:

```bash
cd /Users/vunguyen13/Works/Nexestra/.worktrees/workspace-harness
PATH=/opt/homebrew/bin:$PATH pnpm dev
```

Ứng dụng cần Node >= 24 và pnpm 11. Dữ liệu mặc định nằm trong `.nexestra/` của thư mục chạy;
`NEXESTRA_HOME` chọn một thư mục dữ liệu khác. Bản kiểm tra trên cổng 4387 dùng dữ liệu riêng và
runner offline, không gọi provider thật. Chất lượng câu trả lời của model thật chưa được đánh giá
trong phiên phát triển này.

## Thử một công việc hoàn chỉnh

1. Vào **Work briefs**, tạo hội thoại và mô tả kết quả cần đạt. Ghi đầu ra, ràng buộc, phần ngoài
   phạm vi và các câu hỏi chưa rõ. Mỗi tiêu chí thành công đi cùng cách kiểm tra.
2. **Save draft** lưu một phiên bản. **Confirm scope** ghi nhận sự thống nhất khi nội dung đã đủ;
   nó không chạy agent hoặc phê duyệt công cụ.
3. **Draft task** mở form đã điền mục tiêu, loại công việc và tiêu chí. Sửa cho phù hợp rồi lưu.
   Toàn bộ brief gốc được giữ với task, kể cả nội dung dài không nằm trong description.
4. Mở task trong **Taskboard**, chọn Worker và **Start Worker**. Nghiên cứu, tài liệu và thiết kế
   có thể chạy trong thư mục riêng. Code cần repository đã sẵn sàng và dùng Git worktree.
5. Khi Worker nộp, task chuyển sang **In review**. Mở tệp đã chụp lại, thực hiện kiểm tra và ghi
   điều thực sự quan sát được. **Accept result** cần bằng chứng cho mọi tiêu chí.
6. **Request changes** mở lượt sửa. Worker nhận nhận xét và bản sao đã kiểm tra hash của lần nộp
   trước. **Attempt history** cho xem từng bản nộp, lỗi, cấu hình và nhận xét mà không đổi lịch sử.

Tệp trong `outputs/` được chụp lại sau lượt chạy. Sửa thư mục làm việc về sau không sửa bản đã nộp.
Lượt sửa có `inputs/` riêng; một kết quả đã được chấp nhận đóng chuỗi yêu cầu sửa trước đó.

## Lập kế hoạch và chạy liên tục

Master dùng custom provider có thể đọc brief, tìm lịch sử, lập task và giao Worker. `plan` mặc định
là nháp: phù hợp với yêu cầu phân tích hoặc đề xuất. Khi người dùng yêu cầu thực hiện, chế độ
`execute` giữ nghĩa vụ hoàn tất việc giao task. Chế độ này không tự cấp thêm quyền công cụ.

Trong **Goals**, chọn các task trong cùng hội thoại, Worker, giới hạn số lần thử và thời gian.
Xem lại phạm vi rồi **Start**. Mỗi lần chỉ chạy một task của goal; người dùng duyệt xong mới
chuyển tiếp. Yêu cầu sửa có thể tạo lần thử tiếp theo trong ngân sách.

**Pause** dừng Worker hiện tại. Khởi động lại server sẽ giữ checkpoint và tạm dừng goal, không tự
chạy lại những tác động chưa rõ. **Resume** giữ số lần đã dùng và deadline ban đầu. Thời gian chờ
duyệt cũng nằm trong giới hạn thời gian. Hết ngân sách không đồng nghĩa với hoàn thành mục tiêu.

## Dùng và mở rộng surface

**Custom surfaces** hỗ trợ bảng, board, canvas ghi chú và tài liệu. Bạn hoặc Master có thể tạo
manifest và dữ liệu có kiểu, chỉnh từng record, chọn nội dung để đưa vào ngữ cảnh, import/export.
Thay đổi sử dụng revision để tránh ghi đè một chỉnh sửa mới hơn.

Xem [hợp đồng extension](SURFACE-EXTENSIONS.md) và các ví dụ trong `docs/examples/surfaces/`.
Đây là surface khai báo với renderer của app. Canvas chưa có đường nối/vẽ tự do và chưa có runtime
cho plugin giao diện tùy ý. Quyền chỉnh dữ liệu của một surface không cho nó quyền chấp nhận task.

## Những phần chưa nên hiểu là đã hoàn thiện

- Kiểm chứng kết quả trong sản phẩm vẫn dựa vào người dùng; chưa có dịch vụ verifier thực thi
  syntax/runtime/E2E cho mọi loại artifact hoặc evaluator agent độc lập.
- Goals là chuỗi có review, chưa phải graph scheduler có nhánh, rollback và khóa tài nguyên.
- Chưa đo token/chi phí thực tế. Giới hạn văn bản, số lần thử và thời gian là các giới hạn riêng.
- Tool bridge đầy đủ của app hiện dành cho custom-provider Master. Codex/OpenCode CLI nhận brief,
  task và tệp, nhưng chưa có toàn bộ tool app để tự sửa brief/goal/surface.
- Git branch chưa được đóng thành manifest diff/commit để chứng nhận tự động; chưa có merge,
  cleanup hoặc sandbox OS độc lập cho mọi runtime và plugin.

[Roadmap](ROADMAP.md) phân biệt phần đã có và phần tiếp theo.
[Thiết kế harness](HARNESS-DESIGN.md) đối chiếu cơ chế với 14 bài giảng.
[Biên bản kiểm tra](VERIFICATION.md) ghi phạm vi bằng chứng của bản này.
