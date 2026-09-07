# Nexestra: workspace để con người và AI cùng hiểu và hoàn thành công việc

Nexestra phục vụ nghiên cứu, tài liệu, thiết kế và code ngay từ mô hình nền tảng. Đơn vị giá trị là
một kết quả người dùng có thể hiểu, kiểm tra và sử dụng; số agent hay số lượt chạy không phải thước
đo thành công.

## Trải nghiệm chủ đạo

Người dùng bắt đầu bằng ngôn ngữ tự nhiên, một tài liệu, hoặc một thao tác trên surface. Assistant
ghi nhận cách nó hiểu yêu cầu, những giả định và câu hỏi còn mở. Hai bên có thể sửa cùng một Work
Brief. Khi công việc đủ rõ, assistant tạo các đơn vị công việc có đầu ra và cách nghiệm thu, chọn
worker phù hợp, theo dõi tiến độ và đưa kết quả trở lại nơi người dùng đang làm việc.

Người dùng luôn tìm được câu trả lời cho năm câu hỏi:

1. AI đang hiểu mình muốn đạt được điều gì?
2. Nó đang làm việc gì, và vì sao chọn bước này?
3. Nó còn cần mình quyết định điều gì?
4. Kết quả nằm ở đâu, đã được kiểm tra bằng cách nào?
5. Nếu dừng hoặc đổi hướng bây giờ, điều gì được giữ lại?

Chat là một đầu vào và lịch sử trao đổi. Surface cung cấp các cách nhìn và thao tác khác trên cùng
dữ liệu. Một task được sửa trên taskboard phải được assistant đọc đúng ngay ở lần tiếp theo; một
quyết định ở whiteboard phải có nguồn gốc và liên kết tới brief hoặc artifact liên quan.

## Ba lớp trách nhiệm

**Assistant hiểu và đề xuất.** Một agent điều phối phụ trách phân tích ý định, phát hiện điều chưa
rõ, so sánh phương án, thiết kế, lập kế hoạch và tổng hợp. Nó có thể thay model hoặc harness mà không
thay định nghĩa hoàn thành của công việc.

**Bộ điều phối kiểm soát thực thi.** Phần mềm xác định quyền, vòng đời task, ngân sách, hàng đợi,
isolation, retry, checkpoint và điều kiện dừng. Model đề nghị chuyển trạng thái; bộ điều phối kiểm
tra điều kiện. Câu trả lời “đã xong” của Worker là một đầu ra cần đánh giá.

**Người dùng quyết định mục tiêu và các đánh đổi có ý nghĩa.** Hệ thống tận dụng quyền đã có và
tự xử lý lựa chọn có thể đảo ngược. Chỉ hỏi khi thông tin thiếu làm thay đổi đáng kể kết quả, khi
có xung đột mục tiêu, hoặc khi thao tác cần quyền chưa được cấp. Xác nhận brief là một lựa chọn ghi
nhận đồng thuận, không phải thêm một cửa xin phép cho mọi lượt chat.

## Một mô hình chung, nhiều hình thức công việc

| Công việc | Đầu ra điển hình | Bằng chứng nghiệm thu |
| --- | --- | --- |
| Nghiên cứu | Bản tổng hợp, bảng so sánh, khuyến nghị | Nguồn gốc từng nhận định, kiểm tra nguồn, giới hạn và phản chứng |
| Tài liệu | Memo, DOCX, slide deck, bảng tính | Schema/cấu trúc, kiểm tra nội dung, render từng trang, review theo rubric |
| Thiết kế | Phương án, prototype, design system | Tiêu chí người dùng, trạng thái lỗi, accessibility, kiểm tra tương tác |
| Code | Thay đổi trong branch, bản build | Kiểm tra cú pháp, hành vi và luồng đầu cuối trên đúng revision |

Git là một adapter của môi trường code. Các công việc khác có thư mục làm việc riêng, artifact có
phiên bản và bản ghi nguồn gốc. Workspace cũng phải chạy được khi người dùng chưa thêm repository.

## Các surface cần thiết

| Surface | Điều nó giúp hai bên hiểu nhau |
| --- | --- |
| Work briefs | Ý định, phạm vi, giả định, câu hỏi mở và tiêu chí thành công |
| Taskboard | Cam kết công việc, phụ thuộc, người phụ trách, trạng thái và lý do bị chặn |
| Artifacts / review | Đầu ra cụ thể, phiên bản, thay đổi và bằng chứng kiểm tra |
| Knowledge | Tài liệu nguồn, nguồn trích dẫn, quyết định và kiến thức đã được xác nhận |
| Whiteboard | Các phương án, mối quan hệ, tranh luận và quyết định chưa chốt |
| Activity | Hệ thống đã làm gì, còn bao nhiêu ngân sách, cần quyết định nào |

Không cần hiển thị mọi surface cho mọi công việc. Assistant có thể gợi ý một view khi nó làm rõ một
quyết định; người dùng vẫn giữ quyền điều khiển bố cục. Phiên bản đầu giữ giao diện rõ ràng trước khi
thêm tự động thay đổi layout.

## Mở rộng bằng plugin

Surface đọc các projection và gửi domain command như người dùng hoặc assistant. Nó không sở hữu
bản sao task, cũng không tự đặt `passing`. Bắt đầu bằng surface khai báo và component có sẵn. Khi
cần renderer tùy biến, dùng runtime tách biệt và quyền theo capability. Không thực thi code vừa được
model tạo trong origin của app.

Một assistant có thể viết manifest, schema và dữ liệu mẫu cho một surface, chạy kiểm tra, rồi tạo
bản preview. Việc kích hoạt được giới hạn theo quyền workspace đã cấp. “AI viết plugin” không có
nghĩa plugin được tự mở rộng quyền của chính nó.

## Chất lượng sản phẩm cần đo

- Tỷ lệ công việc được người dùng chấp nhận trên số đã bắt đầu; ghi riêng các kết quả phải làm lại.
- Tỷ lệ yêu cầu bị hiểu sai, lý do đổi brief và số câu hỏi làm rõ thực sự cần thiết.
- Tỷ lệ kết quả được đánh dấu thành công nhưng thất bại khi kiểm tra lại.
- Thời gian review của người dùng trên mỗi kết quả được chấp nhận.
- Chi phí, thời gian và số lần resume trên một kết quả được chấp nhận; giá trị chưa biết phải hiện
  là chưa biết, không hiển thị thành 0.
- Mức độ tái lập: một phiên mới có thể giải thích mục tiêu, trạng thái và bước tiếp theo chỉ từ
  hồ sơ workspace hay không.

Các chỉ số này là thiết kế đo lường, chưa phải số liệu sản phẩm đang thu thập. Ưu tiên sự rõ ràng và
khả năng phục hồi trước các bảng thống kê đẹp.

## Tình trạng và đường dẫn

- [Kiến trúc hiện tại](ARCHITECTURE.md) mô tả hành vi thực tế và giới hạn.
- [Thiết kế harness](HARNESS-DESIGN.md) ánh xạ 14 bài giảng vào cơ chế và tiêu chí kiểm chứng.
- [Hợp đồng surface](SURFACE-EXTENSIONS.md) xác định điểm mở rộng và ranh giới quyền.
- [Lộ trình](ROADMAP.md) phân biệt phần đã có, đang triển khai và chưa có.
