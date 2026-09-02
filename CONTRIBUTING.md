# Contributing

## Development loop

```bash
pnpm install
pnpm dev
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Dùng `NEXESTRA_HOME=/tmp/nexestra-dev` khi thử mutation để không đụng dữ liệu thật.
Dùng cặp cổng riêng khi chạy nhiều worktree.

## Change discipline

- Bắt đầu từ contract trong `src/shared/contracts.ts`; không tạo type trùng ở UI/server.
- Giữ transcript append-only. Sửa projection bằng replay, không rewrite lịch sử chat.
- Secret chỉ đi qua `credentials.json` và request trực tiếp tới provider được chọn.
- Inject `AgentRunner` giả trong test; không yêu cầu CLI đăng nhập hoặc request trả phí.
- Thay đổi ít nhất đủ để đáp ứng criterion, không thêm framework hoặc abstraction dự phòng.

## Commit

Dùng conventional commits. AI-authored commit dùng project identity và trailer được yêu cầu bởi
repository policy.
