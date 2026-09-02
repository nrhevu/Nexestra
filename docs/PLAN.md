# Nexestra — Kế hoạch triển khai

> Control center cho công việc agentic: biến yêu cầu mơ hồ thành đặc tả rõ ràng,
> rồi tự tổ chức và giám sát nhiều coding harness (Codex, OpenCode) cho tới khi
> có kết quả đã được kiểm chứng.

Ngày lập: 2026-09-02. Môi trường đã kiểm tra trên máy: Node 24.19, pnpm, bun,
Codex CLI 0.148.0, OpenCode 1.18.25.

---

## 1. Quyết định kiến trúc (cần chốt trước khi code)

| # | Quyết định | Lựa chọn | Lý do |
|---|-----------|----------|-------|
| 1 | Hình thức chạy | **Local-first**: một Node server chạy trên máy người dùng + SPA mở trong browser (`http://localhost:4242`) | Harness (Codex/OpenCode) và git worktree đều cần chạy trên máy có source code. Sau này đóng gói Electron/Tauri nếu cần. |
| 2 | Số người dùng | Single-user, không auth ở v1 | Giảm phạm vi. Server chỉ bind `127.0.0.1`. |
| 3 | Ngôn ngữ | TypeScript toàn bộ (pnpm monorepo) | SDK của Anthropic, Codex, OpenCode đều là TS. Chia sẻ type giữa server và web. |
| 4 | Lưu trữ | SQLite (`better-sqlite3` + Drizzle) trong `~/.nexestra/nexestra.db`; file lớn (artifact, log) trong `~/.nexestra/data/` | Không cần service ngoài. Dễ backup. |
| 5 | Mô hình dữ liệu | **Event-sourced**: mọi thay đổi là một event append-only; UI đọc projection | Cần replay/resume sau crash, audit trail, tính chi phí, và stream realtime ra UI cùng một cơ chế. |
| 6 | Master agent | Claude Opus 5 (`claude-opus-5`) qua `@anthropic-ai/sdk`, adaptive thinking, tool use, streaming | Model mặc định mạnh nhất cho planning dài hơi. Bật `fallbacks: "default"` để tránh refusal làm gãy vòng lặp. |
| 7 | Harness abstraction | Interface `HarnessAdapter` riêng của Nexestra; adapter đầu tiên: **Codex** và **OpenCode**; adapter thứ ba tuỳ chọn: **ACP** (Agent Client Protocol) generic | Codex và OpenCode có giao diện máy khác nhau; chuẩn hoá về một event schema. ACP cho phép cắm thêm harness khác về sau. |
| 8 | Cách lái Codex | `codex exec --json` (JSONL trên stdout) cho v1; nâng lên `codex app-server` (JSON-RPC, có `@openai/codex-sdk`) khi cần steer giữa chừng | `exec --json` đơn giản, ổn định, hỗ trợ `-C`, `-m`, `-s`, `--output-schema`, `--ephemeral`, `-o last-message`. |
| 9 | Cách lái OpenCode | `opencode serve` (HTTP + SSE) + `@opencode-ai/sdk` | Server mode cho phép nhiều session song song, hỏi/đáp permission, đọc event realtime. |
| 10 | Cô lập workspace | Mỗi task chạy trong **git worktree** riêng dưới `<repo>/.nexestra/worktrees/<taskId>`; merge về branch mục tiêu sau khi verify | Các harness chạy song song không giẫm lên nhau; diff per task rõ ràng. |
| 11 | UI | React 19 + Vite, giao diện **terminal-like** (monospace, border box-drawing, mật độ cao) bám sát wireframe | Đúng ảnh người dùng vẽ; dễ làm dark-first. |

---

## 2. Stack chi tiết

**Monorepo**: `pnpm` workspaces + `turbo` (hoặc chỉ pnpm `-r`).

| Lớp | Thư viện |
|-----|----------|
| Server | Node 24, `hono` (HTTP) + `ws` (WebSocket), `zod` (schema), `drizzle-orm` + `better-sqlite3`, `execa` (spawn process), `simple-git` |
| Master | `@anthropic-ai/sdk` (tool runner hoặc manual loop), structured outputs cho Spec/Plan |
| Adapters | `@openai/codex-sdk` (tuỳ chọn), `@opencode-ai/sdk`, `@agentclientprotocol/sdk` (tuỳ chọn) |
| Web | React 19, Vite, TanStack Router + Query, Zustand, `@xyflow/react` (memory graph), `@dnd-kit` (kanban), CodeMirror 6 (editor + diff), `@xterm/xterm` (terminal), `react-resizable-panels` |
| Test | Vitest (unit + contract), Playwright (e2e UI), fixture JSONL ghi lại từ Codex/OpenCode thật |
| Tooling | TypeScript strict, Biome (lint+format), `tsx` để dev |

Cấu trúc thư mục mục tiêu:

```
nexestra/
  apps/
    server/            # Hono + WS, orchestrator runtime, adapters wiring
    web/               # React SPA
  packages/
    core/              # domain types, events, state machines, zod schemas (dùng chung)
    master/            # Master agent: prompts, tools, clarification + planning loop
    orchestrator/      # scheduler, task DAG, verification loop, retry/replan
    adapters/
      codex/
      opencode/
      acp/             # (sau)
    storage/           # drizzle schema, event store, projections
    ui-kit/            # component terminal-like (Box, Pane, Kbd, StatusDot...)
  docs/
    PLAN.md
    ARCHITECTURE.md    # cập nhật khi implement
    adr/               # architecture decision records
  fixtures/            # JSONL event logs thật của codex/opencode để contract test
```

---

## 3. Domain model

Thực thể chính (tất cả có `id`, `workspaceId`, `createdAt`, `updatedAt`):

- **Workspace**: trỏ tới một repo/thư mục trên máy. Chứa settings (harness mặc định, budget).
- **Thread**: một cuộc trao đổi với Master về một ý tưởng/công việc. Có `phase`:
  `intake → clarifying → spec_frozen → planning → executing → verifying → done | blocked | cancelled`.
- **Message**: user / master / system, kèm tool calls, references (`#task`, `#file`, `#memory`, `#artifact`).
- **Spec** (thuộc Thread, có version): `goal`, `scope.in[]`, `scope.out[]`, `constraints[]`,
  `expectedOutcome`, `acceptanceCriteria[]` (mỗi criterion có `id`, `text`, `verification`:
  command/test/manual-review), `openQuestions[]`, `decisions[]`.
- **Plan** (thuộc Thread, có version): danh sách Task + dependency edges (DAG).
- **Task**: `title`, `description`, `dependsOn[]`, `assignedHarness`, `harnessConfig`
  (model, reasoningLevel, tools/skills/MCP, sandbox, permissions, worktree/branch),
  `status`: `todo → ready → running → review → verifying → done | failed | blocked`,
  `attempts`, `acceptanceCriteriaIds[]`, `cost`.
- **Run**: một lần thực thi task bởi một harness. `kind`: `execute | review | verify`.
  Có `sessionRef` của harness, `worktreePath`, `exitStatus`, `usage` (tokens, USD), `startedAt/endedAt`.
- **RunEvent** (event-sourced, append-only): `type` (xem §5), payload chuẩn hoá, `seq`.
- **Artifact**: diff/patch, file output, test report, log, screenshot. Lưu file + metadata.
- **Approval**: yêu cầu người dùng phê duyệt (`kind`: permission/sandbox escalation, spend threshold,
  merge, destructive op, spec change). `status`: pending/approved/rejected, kèm `resolvedBy`.
- **Memory**: node trong memory graph. `type`: goal | requirement | decision | research |
  architecture | task | artifact | lesson. `links[]` (typed edges: `derives_from`, `blocks`,
  `implements`, `verified_by`...). Master ghi memory qua tool; người dùng sửa được.

Lưu trữ: bảng thực thể (projection) + bảng `events` (append-only, `threadId`, `runId`, `seq`, `type`,
`payload` JSON). Projection được rebuild từ events khi cần.

---

## 4. Master agent

Model: `claude-opus-5`, `thinking: {type: "adaptive"}`, `output_config.effort: "high"`
(planning) / `"medium"` (chat thường), streaming, prompt caching cho system prompt + tool list,
`fallbacks: "default"` (beta `server-side-fallback-2026-07-01`). Auth: `ANTHROPIC_API_KEY`
hoặc profile từ `ant auth login`.

Master chạy như một **state machine ngoài LLM** (code quyết định phase), LLM chỉ điền nội dung
trong từng phase. Điều này giúp vòng lặp không phụ thuộc vào việc model "nhớ" phải làm gì.

### 4.1 Phase và tool tương ứng

| Phase | Mục tiêu | Tools Master được dùng |
|-------|----------|------------------------|
| intake | Hiểu sơ bộ ý tưởng | `read_workspace` (tree, README, package manifest), `search_code`, `web_search` (server tool) |
| clarifying | Hỏi cho đủ 5 mục: mục tiêu, phạm vi, ràng buộc, kết quả mong muốn, tiêu chí hoàn thành | `ask_user(questions[])` (mỗi câu có options gợi ý), `update_spec(patch)`, `record_memory` |
| spec_frozen | Người dùng xác nhận Spec | `request_approval(kind: "spec")` |
| planning | Chia task, DAG, chọn harness và config cho từng task | `propose_plan(plan)` (structured output theo schema Plan), `record_memory` |
| executing | Điều phối | `dispatch_task`, `read_run_events`, `read_artifact`, `control_run(pause/cancel/steer)`, `request_approval`, `replan(patch)` |
| verifying | Kiểm tra acceptance criteria | `run_verification(taskId)`, `read_artifact`, `mark_criterion(id, passed, evidenceArtifactId)` |
| done/blocked | Tổng kết | `summarize`, `record_memory(type: lesson)` |

Quy tắc dừng: Master chỉ được gọi `propose_plan` khi Spec không còn `openQuestions` và người
dùng đã approve. Master chỉ được đánh dấu `done` khi mọi acceptance criterion có `evidenceArtifactId`.

### 4.2 Ngân sách và an toàn

- Mỗi Thread có `budgetUSD`; vượt 80% → tạo Approval `spend`; vượt 100% → tự pause.
- Master không có tool ghi file trực tiếp; mọi thay đổi code đi qua harness trong worktree.
- Mọi lệnh cần sandbox `danger-full-access` hoặc network ngoài whitelist → Approval bắt buộc.

---

## 5. Harness adapter

```ts
interface HarnessAdapter {
  id: "codex" | "opencode" | "acp";
  discover(): Promise<HarnessInfo>;            // binary path, version, models, auth ok?
  prepare(spec: RunSpec): Promise<PreparedRun>; // build cmd/args, write instruction files, tạo worktree
  run(prepared: PreparedRun, signal: AbortSignal): AsyncIterable<HarnessEvent>;
  control(runId: string, action: RunControl): Promise<void>; // pause | cancel | answer_permission | steer
}

type RunSpec = {
  taskId: string; kind: "execute" | "review" | "verify";
  cwd: string; instructions: string; model?: string; reasoning?: "low"|"medium"|"high"|"xhigh";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  tools?: string[]; mcpServers?: McpServerRef[]; skills?: string[];
  outputSchema?: JsonSchema; timeoutMs: number; budgetUSD?: number;
};

type HarnessEvent =
  | { type: "started"; sessionRef: string }
  | { type: "assistant_text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; name: string; input: unknown; callId: string }
  | { type: "tool_result"; callId: string; output: unknown; ok: boolean }
  | { type: "file_changed"; path: string; kind: "add"|"modify"|"delete" }
  | { type: "command"; cmd: string; exitCode?: number; stdout?: string; stderr?: string }
  | { type: "permission_request"; requestId: string; description: string; risk: "low"|"high" }
  | { type: "usage"; inputTokens: number; outputTokens: number; costUSD?: number }
  | { type: "final"; message: string; structured?: unknown }
  | { type: "error"; message: string; retryable: boolean }
  | { type: "ended"; exitCode: number };
```

**Codex adapter (v1)**: spawn
`codex exec --json -C <worktree> -m <model> -s <sandbox> --skip-git-repo-check [--ephemeral] [--output-schema f] -o <lastmsg> -c model_reasoning_effort=<level>`,
đọc JSONL stdout → map sang `HarnessEvent`. Review dùng `codex exec review`. Permission: v1 chạy
`workspace-write` không cần hỏi; nếu task cần cao hơn thì Master xin Approval trước rồi mới spawn.
v2: `codex app-server` để steer và trả lời approval giữa chừng.

**OpenCode adapter (v1)**: Nexestra khởi động một `opencode serve --port 0` cho mỗi workspace,
dùng `@opencode-ai/sdk` tạo session, gửi prompt (`model`, `agent`, `variant` = reasoning),
subscribe SSE event, trả lời permission request qua API, huỷ session khi cancel.

**Contract test**: ghi lại JSONL/SSE thật vào `fixtures/`, test adapter parse đúng và không
crash khi gặp event lạ (bỏ qua + log). Pin version harness trong `discover()` và cảnh báo khi
lệch version.

---

## 6. Vòng lặp điều phối (orchestrator)

```
loop:
  ready = tasks có mọi dependsOn = done và status = todo
  for t in ready (giới hạn concurrency, mặc định 2):
     worktree = ensureWorktree(t)
     run = dispatch(execute, t)  → stream events → projection + WS
  on run.ended:
     if error.retryable && attempts < maxAttempts: retry với instruction bổ sung lỗi
     else if failed: Master.replan(t)  (có thể tách task, đổi harness, đổi model)
     else: t.status = review
  review: dispatch(review, t) bằng harness KHÁC harness đã execute (cross-review)
     → nếu reviewer trả về blocking findings: quay lại execute với findings
  verify: chạy verification của từng acceptance criterion liên quan (command/test) trong worktree
     → lưu Artifact (test report, diff) làm evidence
     → pass: t.status = done, merge worktree → target branch (Approval nếu conflict/ổn định thấp)
     → fail: attempts++ → execute lại với evidence thất bại
  khi mọi task done và mọi criterion có evidence: thread.phase = done
  khi thread bị block > N lần cùng một lỗi hoặc cần quyết định: tạo Approval, phase = blocked
```

Mọi bước ghi event → UI cập nhật realtime qua WS. Người dùng có thể pause/cancel/steer bất
kỳ lúc nào; orchestrator tôn trọng `AbortSignal`.

Resume: khi server khởi động lại, đọc projection, đánh dấu run đang `running` thành `interrupted`,
và Master quyết định retry.

---

## 7. UI (bám sát wireframe)

Layout chung: `WS rail (48px) | Navigation (260px) | Main | Sidebar (280px)`, dùng
`react-resizable-panels`. Phím tắt: `⌘K` command palette, `⌘1..4` đổi surface, `⌘/` focus composer.

| Surface | Main | Sidebar |
|---------|------|---------|
| **1. Workspace / Chat** | Timeline message của Master; block "Agent response / artifact" render inline (diff, test result, plan preview); composer với `@agent`, `#ref`, `/command` autocomplete | Context: Requirements (Spec hiện tại), Decisions, References; Approval queue nổi lên trên cùng |
| **2. Task Board** | Kanban TODO / IN PROGRESS / DONE (thêm cột REVIEW, BLOCKED khi có), drag để reorder; badge harness + cost + attempts | Task details: title, assigned agent (select), status, references, acceptance criteria + evidence |
| **3. Editor / Agent Workspace** | File tree của worktree đang chọn; CodeMirror editor với chế độ diff (base vs worktree); terminal pane stream stdout của run | Active agent, current task, progress %, [View changes] |
| **4. Memory Graph** | React Flow: node theo `Memory.type`, edge theo link; click để chọn; filter theo type; layout dagre | Selected memory: nội dung, type, linked memories, [Open source], [Edit memory] |
| Settings | Harness đã phát hiện (version, auth), model mặc định, budget, concurrency, sandbox mặc định, API key | |

Thiết kế: dark-first, font mono (JetBrains Mono / SF Mono fallback), border 1px, hover/selected
bằng nền chứ không bằng viền, mật độ giống TUI nhưng là DOM thật (không render ASCII).

---

## 8. Lộ trình theo milestone

Mỗi milestone có tiêu chí hoàn thành có thể kiểm chứng. Ước lượng cho một người làm full-time.

### M0 — Skeleton + UI tĩnh (2–3 ngày)
- pnpm monorepo, TS strict, Biome, Vitest, script `pnpm dev` chạy server + web.
- `packages/core`: zod schema cho toàn bộ domain (§3) + `HarnessEvent` (§5).
- `apps/web`: 4 surface với **mock data**, layout và điều hướng như wireframe.
- ✅ Mở `localhost:4242`, chuyển 4 surface bằng chuột và phím, không có API thật.

### M1 — Server, storage, realtime (2–3 ngày)
- Drizzle schema + migration; event store append/replay; projection.
- Hono REST: workspaces, threads, messages, tasks, approvals, memories (CRUD tối thiểu).
- WS: subscribe theo `threadId`, push event.
- ✅ Tạo workspace từ UI trỏ vào một repo thật; tạo thread; refresh trang vẫn còn dữ liệu.

### M2 — Master: intake → clarify → spec (3–4 ngày)
- `packages/master`: system prompt, tools `ask_user`, `update_spec`, `read_workspace`,
  `search_code`, `web_search`, `record_memory`, `request_approval(spec)`.
- Chat streaming vào surface 1; Spec hiển thị và cập nhật live ở sidebar; nút Approve spec.
- ✅ Từ một câu mơ hồ ("làm cho tôi CLI todo"), Master hỏi ≤ 6 câu và ra Spec có ≥ 3 acceptance criteria có cách verify; người dùng approve → phase `spec_frozen`.

### M3 — Planning + Task Board (2–3 ngày)
- Tool `propose_plan` với structured output (schema Plan); validate DAG không vòng.
- Task Board hiển thị plan thật; sửa tay task/harness/assignment từ sidebar; Master nhận thay đổi.
- ✅ Plan có dependency; kéo task đổi cột tạo event; Master replan khi người dùng sửa spec.

### M4 — Codex adapter + chạy 1 task end-to-end (3–4 ngày)
- `adapters/codex`: discover, prepare (worktree, instruction file), run (`exec --json`), parse JSONL, usage.
- Orchestrator tối thiểu: dispatch task `ready`, stream event vào Editor surface (terminal + file tree + diff).
- Fixture JSONL + contract test.
- ✅ Task "tạo file hello.ts + test" chạy bằng Codex trong worktree, diff hiện trong Editor, cost hiện trong Task details.

### M5 — OpenCode adapter + cross-review + verification (3–4 ngày)
- `adapters/opencode`: quản lý `opencode serve`, session, SSE, permission reply.
- Vòng lặp review (harness khác) và verify (chạy lệnh của acceptance criteria), evidence → Artifact.
- Retry với instruction bổ sung; replan qua Master khi fail quá `maxAttempts`.
- ✅ Một thread 3 task có dependency chạy hết tự động; ít nhất một task fail lần 1 rồi pass sau retry; mọi criterion có evidence; merge về branch đích.

### M6 — Approvals, budget, memory graph (2–3 ngày)
- Approval queue (sandbox escalation, spend, merge, destructive op) trên UI, block run cho tới khi resolve.
- Cost aggregation per run/task/thread; budget pause.
- Memory graph React Flow với dữ liệu thật do Master ghi; edit memory từ UI.
- ✅ Chạy task cần `danger-full-access` → dừng chờ approve; từ chối → task blocked; Memory graph có ≥ 10 node liên kết sau một thread hoàn tất.

### M7 — Hardening (liên tục, 3+ ngày)
- Resume sau crash; interrupted runs; log rotation.
- Settings surface; kiểm tra version harness; onboarding khi thiếu auth.
- Playwright e2e cho luồng M2→M5 dùng adapter giả (`fake` harness phát lại fixture) để CI không cần Codex thật.
- Docs: ARCHITECTURE.md, ADR cho các quyết định §1.

Tổng ước lượng: ~4–5 tuần cho bản dùng được hằng ngày.

---

## 9. Rủi ro và cách xử lý

| Rủi ro | Xử lý |
|--------|-------|
| Định dạng JSONL của `codex exec --json` và event của OpenCode đổi giữa các version | Pin version trong `discover()`, contract test trên fixture, parser bỏ qua event lạ thay vì crash. |
| Master "quên" quy trình khi hội thoại dài | Phase là state machine trong code; mỗi request chỉ đưa tool của phase hiện tại; bật compaction (`compact-2026-01-12`) cho thread dài. |
| Harness chạy song song xung đột file | Worktree per task; merge tuần tự; conflict → Approval. |
| Chi phí tăng không kiểm soát | Budget per thread, usage event từ harness, pause tự động. |
| Verification chỉ dựa vào lời harness nói | Verification là lệnh chạy bởi orchestrator trong worktree, không tin `final` message; evidence là stdout/exit code/test report. |
| Người dùng mất ngữ cảnh khi nhiều task chạy | Mọi thứ đi qua event log; Activity feed + Approval queue luôn thấy ở sidebar. |

---

## 10. Câu hỏi mở (không chặn M0–M1)

1. Master có nên chạy bằng Claude Agent SDK (có sẵn Read/Grep) thay vì Messages API + tool tự viết? Đề xuất: Messages API để kiểm soát tool surface và phase; xem lại ở M2 nếu tool `read_workspace/search_code` tốn quá nhiều công.
2. Merge worktree về branch đích: tự động sau verify hay luôn cần Approval? Đề xuất: mặc định cần Approval, có setting để tự động.
3. Có hỗ trợ workspace không phải git (chỉ thư mục)? Đề xuất: v1 yêu cầu git (worktree phụ thuộc git).

---

## 11. Bắt đầu ngay

Việc đầu tiên (M0): khởi tạo monorepo và dựng 4 surface với mock data. Đây là bước có
giá trị nhìn thấy sớm nhất và cố định "hợp đồng" UI trước khi backend chạy thật.
