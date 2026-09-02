# Nexestra

Nexestra là workspace local-first để con người trò chuyện và làm việc cùng coding agent.
Bản M9 được viết lại từ đầu, tập trung vào hai luồng chính:

- tạo **Worker agent** chạy bằng Codex hoặc OpenCode;
- tạo **Master agent** dùng ChatGPT OAuth qua Codex CLI hoặc một endpoint OpenAI-compatible;
- trò chuyện trong thread chung và chỉ gọi agent khi có `@handle`;
- quản lý task và agent trong hai surface đầu tiên: Taskboard và Agents.

## Chạy local

Yêu cầu Node.js 24+ và pnpm 11.

```bash
pnpm install
pnpm dev
```

Mở `http://127.0.0.1:5173`. Backend chỉ bind vào loopback tại cổng `4242`.
Có thể đổi cổng bằng `NEXESTRA_PORT`.

Dữ liệu mặc định nằm trong `.nexestra/` của repo đang chạy:

```text
.nexestra/
├── state.json          # agent, thread metadata và task
├── credentials.json    # API key custom, mode 0600
└── threads/
    └── <thread-id>.jsonl  # transcript append-only chung của thread
```

Đặt `NEXESTRA_HOME=/đường/dẫn/khác` nếu muốn tách data khỏi repo.

## Cách gọi agent

Tin nhắn không có mention chỉ được lưu vào transcript. Tin nhắn có `@maya`, `@codex`,
hoặc nhiều handle sẽ tạo một lượt chạy cho mỗi agent được gọi. Reply của agent được ghi lại
vào chính file transcript đó. Reply của agent không tự kích hoạt agent khác, tránh vòng lặp.

Worker chạy ở chế độ thảo luận read-only trong MVP. Taskboard hiện chỉ tổ chức công việc và
không tự dispatch agent.

## Provider

- **ChatGPT OAuth:** cài Codex CLI và chạy `codex login`, hoặc bấm Kết nối trong form tạo
  Master. OAuth token do Codex CLI quản lý; Nexestra không đọc hoặc lưu token.
- **Custom:** nhập API root, model và chọn OpenAI Chat Completions hoặc OpenAI Responses.
  API key có thể để trống cho local endpoint. Remote endpoint bắt buộc dùng HTTPS; HTTP chỉ được
  chấp nhận trên loopback.

## Kiểm tra

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
# hoặc chạy toàn bộ:
pnpm check
```

Các test mặc định không gọi provider trả phí và không cần tài khoản Codex/OpenCode.

Xem [kiến trúc](docs/ARCHITECTURE.md) và [các giới hạn hiện tại](docs/ARCHITECTURE.md#known-gaps).
