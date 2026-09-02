# AGENTS.md — Nexestra M9

Nexestra là ứng dụng local-first một người dùng: một Node/Hono server, một React/Vite SPA và
các file JSON/JSONL trong `.nexestra/`.

## Commands

```bash
pnpm dev
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check
```

Node >= 24, pnpm 11. Các test phải chạy xanh khi không có Codex, OpenCode hoặc credential.
Không chạy provider live trong test mặc định.

## Map

- `src/shared/contracts.ts`: type và Zod schema dùng chung.
- `src/server/store.ts`: state metadata, secret store và transcript append-only.
- `src/server/dispatcher.ts`: quy tắc `@mention`, queue theo agent và retry.
- `src/server/runtime.ts`: Codex, OpenCode và custom-provider transport.
- `src/server/auth.ts`: ChatGPT device login do Codex CLI sở hữu.
- `src/server/app.ts`: HTTP API và loopback-origin guard.
- `src/web/`: SPA và visual system.

## Rules

1. Persist user message trước khi dispatch. Không mention thì không gọi agent.
2. Mỗi thread có đúng một canonical JSONL transcript. Reply của mọi agent ghi vào cùng file.
3. API key/OAuth token không được xuất hiện trong transcript, `state.json`, response hoặc log.
4. OAuth ChatGPT thuộc Codex CLI. Không tự đọc `auth.json` hay lưu access/refresh token.
5. Process harness đóng stdin, có timeout, output limit và chỉ nhận allowlist environment.
6. Agent reply không kích hoạt mention mới. Một agent xử lý tuần tự; các agent khác có thể chạy song song.
7. Giữ server trên loopback và kiểm tra Origin cho mutation. Không mở bind address khi chưa có auth.
8. Thay đổi protocol parser cần fixture/test tương ứng. Unknown hoặc malformed stream line không được làm crash parser.
9. Mọi thay đổi hành vi cần test nhỏ nhất chứng minh acceptance criterion; chạy `pnpm check` trước handoff.
10. Documentation thuộc cùng change. Mỗi kiến trúc mới cần ADR và phải ghi known gaps trung thực.

Làm việc trên branch/worktree riêng. Commit dùng conventional subject và project identity
`nexestra <nexestra@local>`.
