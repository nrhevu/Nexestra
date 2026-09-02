# Architecture — Milestone M9 fresh rebuild

## Product boundary

M9 là control center local-first, single-user. Server bind `127.0.0.1`, SPA nói chuyện qua HTTP,
và server gọi coding harness hoặc provider đã cấu hình. Hai navigation chính là Threads và
Surfaces; hai surface đầu là Taskboard và Agents.

## Components

```text
React SPA
   │ HTTP + polling
   ▼
Hono API ── FileStore ── state.json / credentials.json
   │                    └─ threads/<id>.jsonl
   ▼
ChatService ── AgentDispatcher ── LocalAgentRunner
                                  ├─ codex exec --json (read-only)
                                  ├─ opencode run --format json (plan)
                                  └─ OpenAI-compatible HTTP
```

Shared Zod contracts ở `src/shared/contracts.ts` là biên giữa browser và server.

## Persistence

`state.json` giữ agent profiles, thread metadata và tasks. Ghi state dùng temp file + atomic
rename. `credentials.json` riêng biệt, mode `0600`, chỉ giữ API key custom theo agent id.

Mỗi thread có một canonical JSONL file. Event `message.created` và `run.updated` dùng sequence
tăng đơn điệu. User message được append + fsync trước khi queue agent. Projection khi đọc lấy
message theo sequence và trạng thái cuối của từng run. Startup cắt bỏ duy nhất JSONL tail dang dở.
Khi restart, run còn queued/running được hoàn tất nếu reply đã fsync, nếu chưa thì được đánh dấu
interrupted và có thể Retry.

## Mention and dispatch

`ChatService` resolve handle không phân biệt hoa thường và loại trùng. Unknown handle chỉ là text.
Mỗi known handle tạo một run; disabled/unavailable agent tạo failed run rõ ràng. Dispatcher có
một promise queue cho mỗi agent, nên một agent trả lời tuần tự trong khi nhiều agent có thể chạy
song song. Mỗi invocation khóa vào đúng trigger message id/content; retry cũ hoặc trùng bị từ chối.
Agent output đi thẳng vào transcript và không đi qua mention parser.

## Agent runtimes

Worker profile chỉ chọn `codex` hoặc `opencode`. Chat turns luôn yêu cầu read-only/discussion mode.
Master profile chọn:

- ChatGPT: dùng session của Codex CLI; device login output được giữ trong memory, token không vào app.
- Custom: OpenAI Chat Completions hoặc Responses với API root, model và API key tùy chọn.

Child process đóng stdin, có timeout/output cap, kill process group và chỉ kế thừa environment
allowlist để giảm nguy cơ lộ secret của server. Timeout dùng TERM rồi KILL sau grace period và chỉ
trả lỗi sau khi process đã đóng.

## Security model

Ứng dụng tin user OS hiện tại và endpoint custom do user nhập. Server chỉ bind loopback và từ chối
browser mutation có Origin ngoài loopback. OAuth token do Codex CLI quản lý. Custom API key vẫn là
plaintext-at-rest trong file `0600`, phù hợp threat model local single-user nhưng không thay thế OS
keychain. Custom base URL không được chứa user info/query/fragment; remote bắt buộc HTTPS, còn HTTP
chỉ được phép trên loopback. Provider response có byte limit trước khi parse.

## Known gaps

- Chat hiện poll, chưa stream token theo thời gian thực.
- Worker chat chạy discussion/read-only; Taskboard chưa dispatch coding job hoặc quản lý worktree.
- OpenCode `plan` là policy của ứng dụng, chưa phải OS/container sandbox độc lập.
- Agent profile chưa sửa toàn bộ config sau khi tạo; hiện có enable/disable và archive.
- Device OAuth hiển thị raw hướng dẫn của Codex CLI; chưa dùng `codex app-server` JSON-RPC.
- Custom provider chỉ hỗ trợ hai OpenAI-compatible protocol; chưa có Anthropic Messages.
- Queue nằm trong process. Restart đánh dấu interrupted và cần user bấm Retry.
- Agent message hiện render plain text; chưa có Markdown/code block/link preview.
- Chưa có upload, nested reply, reaction hoặc multi-user auth.
- Transcript là một file cho mỗi thread, không phải một file toàn workspace; đây là ranh giới giảm
  contention và giữ đúng một nguồn ngữ cảnh chung cho mọi participant trong thread.
