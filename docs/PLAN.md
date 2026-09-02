# Nexestra — Kế hoạch triển khai

> Control center cho công việc agentic: biến yêu cầu mơ hồ thành đặc tả rõ ràng,
> rồi tự tổ chức và giám sát nhiều coding harness (Codex, OpenCode) cho tới khi
> có kết quả đã được kiểm chứng.

Ngày lập: 2026-09-02. Môi trường đã kiểm tra trên máy: Node 24.19, pnpm, bun,
Codex CLI 0.148.0, OpenCode 1.18.25.

---

## 0. Status — cập nhật M8, 2026-09-02

> Phần này viết **sau khi implement**. Toàn bộ kế hoạch gốc giữ nguyên bên dưới
> (§1 trở đi) để so được "định làm gì" với "đã làm gì".

Snapshot M7 bên dưới ghi nhận **61 commit** (HEAD `f0341b7`), **11 workspace package**
(2 app + 8 library + `e2e`), và `pnpm test` xanh trên máy không cài Codex,
không cài OpenCode, không có `ANTHROPIC_API_KEY`:

```
pnpm test  →  472 passed, 6 skipped (478) trên 37 test file / 10 package
             (ui-kit có script test nhưng chưa có test file)
             core 16 · storage 17 · master 56 · orchestrator 52 · server 45
             adapter-codex 121 · adapter-opencode 105 · adapter-fake 33 · web 27
```

6 test skip là các **live test** có opt-in (`NEXESTRA_LIVE_CODEX`,
`NEXESTRA_LIVE_OPENCODE`, `ANTHROPIC_API_KEY`) — xem `docs/testing.md` §5.

M8 thay đổi boundary production: không seed mock, không demo-model fallback,
không fake harness trong registry/UI; thêm OpenAI Responses + custom provider,
project-memory search và Slack-inspired shell. Số test hiện hành được lấy từ
release gates thay vì snapshot M7 ở trên.

### 0.1 Milestone M0–M7

Nhánh được merge theo thứ tự thực tế: M0 → M4 → M2 → M1 → M5 → M5(opencode) →
M3 → M7(test infra) → M6. Adapter và Master làm song song với storage/API, nên
số milestone **không** khớp thứ tự thời gian.

| # | Milestone | Kết quả | Commit range | Bằng chứng |
|---|-----------|---------|--------------|------------|
| M0 | Skeleton + UI tĩnh | **done** | `22788cf..31a25b2` (10 commit, trunk) | pnpm monorepo + TS strict + Biome + Vitest; `packages/core` có zod schema cho toàn bộ §3 và `HarnessEvent` §5; `apps/web` dựng đủ 4 surface trên mock data. |
| M1 | Server, storage, realtime | **done** | `0087f87..77fa068` (`merge: m1-storage-api`) | Drizzle schema + migration `0000_init`, `EventStore` append/replay, projection; Hono REST đầy đủ; `/ws` subscribe theo thread/workspace. `packages/storage` 17 test, gồm replay equality và migration drift. |
| M2 | Master: intake → clarify → spec | **done** | `b7b4034..9ebf27b` (`merge: m2-master`) | `packages/master` 56 test, không cần API key. Acceptance run: một câu mơ hồ → `read_workspace` → 4 câu hỏi một lượt → spec 3 acceptance criteria có `command`/`test` → `request_approval` → plan 2 task có dependency. |
| M3 | Planning + Task Board | **done** | `eb3bea4..0197807` (`merge: m3-master-wiring`) | Master chạy thật trong server: `StorageMasterStore`, `ServerMasterHost`, `MasterRunner`, route `master/send·cancel·state`; plan đổ thành `Task` row (task id **derive** từ `(threadId, plan task id)` nên `replan` là upsert idempotent); Chat surface stream `master.*` qua `/ws`. `apps/server` 45 test. |
| M4 | Codex adapter + 1 task end-to-end | **done** | `af15552..509ffd9` (`merge: m4-codex-adapter`) | `@nexestra/adapter-codex` 121 test, replay **mọi** file trong `fixtures/codex/` (6 recording JSONL từ codex-cli 0.148.0, mỗi cái có `*.meta.json`); live smoke test sau `NEXESTRA_LIVE_CODEX=1`. |
| M5 | OpenCode adapter + cross-review + verification | **done** | `2f2773d..bfe1c5c` (`merge: m5-orchestrator`) + `9670dd1..3bdacb7` (`merge: m5-opencode-adapter`) | `@nexestra/orchestrator` 52 test: DAG 4 task chạy 2 luồng, retry → pass, cross-review bounce, criterion fail rồi pass với đủ 2 evidence artifact, approval gate, budget pause, autoMerge/pending/conflict, `recover()` sau crash. `@nexestra/adapter-opencode` 105 test trên fixture SSE thật của OpenCode 1.18.25. |
| M6 | Approvals, budget, memory graph (+ wiring) | **done** | `3d52da4..f0341b7` (`merge: m6-integration`) | `apps/server/src/execution/` nối orchestrator vào server; approval queue hiện ở mọi surface + badge trên rail; cost per run/task/thread; memory graph React Flow trên dữ liệu Master ghi thật. `execution.test.ts` là acceptance run: chỉ model (`DemoLlmClient`) và harness (fake) là stub, còn lại là production code — 4 case gồm chạy tới `done` với mọi criterion có evidence, approval chặn rồi mở, task hết attempt → replan request, và crash được `recoverAll()` vá. |
| M7 | Hardening | **partial** | `6c27a53..c7f0f56` (`merge: m7-test-infra`) + nhánh docs này | **Xong**: `@nexestra/adapter-fake` (scenario-driven), Playwright e2e chạy trên bản build thật (6 spec), resume sau crash (`recoverAll()` trước request đầu tiên), Settings surface + `GET /api/harnesses` kiểm tra version/auth, `docs/testing.md`, và bộ tài liệu này (README, `docs/index.md`, `docs/adr/`, `CONTRIBUTING.md`, `CLAUDE.md`). **Chưa**: `e2e/tests/execution.spec.ts` vẫn skip — cổng thứ nhất (`apps/server` đọc `NEXESTRA_FAKE_HARNESS`) đã mở khi M6 wiring vào, nhưng cổng thứ hai vẫn cần `NEXESTRA_E2E_EXECUTION=1` và `startExecution()` trong file đó vẫn `throw`, chưa trỏ vào route dispatch của M6; log rotation chưa có; xem `docs/ARCHITECTURE.md` §11 cho phần còn lại. |
| M8 | Production hardening | **done** | `m8-product-hardening` | Provider registry OpenAI/Anthropic/custom with in-app credentials; no production demo/fake/seed paths; Master project-memory search; real-only harness discovery; Slack-inspired shell; production-bundle Playwright acceptance. [ADR 0020](adr/0020-production-master-provider-registry.md), [ADR 0021](adr/0021-slack-inspired-project-workspace.md), [ADR 0022](adr/0022-local-provider-credential-store.md). |

### 0.2 Những quyết định §1 đã đổi khi làm thật

| §1 | Kế hoạch | Thực tế | Lý do |
|----|----------|---------|-------|
| 1 | Mở UI ở `http://localhost:4242` | Dev mở ở **`http://localhost:5173`** (Vite), server vẫn ở `4242`. Vite proxy `/api` và `/ws` sang 4242; ngược lại server ở dev mode redirect mọi request không phải `/api` sang `NEXESTRA_WEB_DEV_URL`. Bản `pnpm build` + `pnpm start` thì đúng một cổng `4242`. | HMR của Vite cần cổng riêng; giữ 4242 làm "cổng chính thức" bằng redirect thay vì bắt người dùng nhớ hai số. |
| 5 | Event-sourced, UI đọc projection | Giữ nguyên, thêm hai ngoại lệ có chủ ý: `master_messages` / `master_state` **không** phát event (scratch space của Master, không ai replay), và họ event `master.*` / `orchestrator.*` chỉ để stream — `rebuildProjections` bỏ qua chúng. Migration được **embed** vào `src/migrations.ts` bằng `scripts/embed-migrations.mjs` vì server ship dạng một bundle esbuild. | Xem [ADR 0005](adr/0005-event-sourced-store-with-projections.md), [ADR 0006](adr/0006-embedded-numbered-migrations.md). |
| 6 | Structured outputs cho Spec/Plan | Dùng **strict tools** (`strict: true`, `additionalProperties: false`, JSON Schema sinh từ zod bằng `toStrictJsonSchema()`). `output_config.format` có trong `LlmRequest` nhưng không dùng. | Structured output không kết hợp được với tool call trong cùng một turn; strict tool đã đủ ràng buộc. [ADR 0014](adr/0014-strict-tools-instead-of-structured-outputs.md). |
| 9 | OpenCode qua `@opencode-ai/sdk` | Qua **`fetch` tự viết** (`client.ts`) + SSE tự parse (`sse.ts`), sinh từ `fixtures/opencode/openapi.json`. | SDK version lệch với binary, không có README, và event stream phải tự cầm để chịu được event lạ + reconnect. [ADR 0010](adr/0010-drive-opencode-with-serve-and-sse-over-fetch.md). |
| 7 | `HarnessId` = `codex \| opencode \| acp` | M7 thêm `fake` cho fixture/test. M8 giữ member này vì schema additive nhưng production chỉ register và discover `codex`/`opencode`; không còn switch fake. | Test double chỉ đi qua dependency injection, không trở thành product mode. [ADR 0018](adr/0018-fake-harness-for-dev-and-tests.md), [ADR 0020](adr/0020-production-master-provider-registry.md). |
| — | Spec có version | Spec là **một row/thread**, cột `version` tăng dần mỗi lần `upsertSpec` (không phải một row/version). Bản nháp giữa lúc clarify nằm ở `master_state`, bản đã validate nằm ở bảng `specs`, và evidence từ verification được ghi ngược lên bản published. | Row lịch sử đã nằm trong `events` rồi; giữ một row làm projection để mọi query "spec hiện tại" khỏi phải group-by. |
| §10.2 | Merge tự động hay cần approval? | **Cần approval theo mặc định** — `AppSettings.autoMerge = false`. Orchestrator dựng approval `merge` rồi dừng; `apps/server` là bên thực sự chạy `mergeTaskBranch()` khi row được approve. | Đúng đề xuất trong §10.2. [ADR 0017](adr/0017-approval-gates-and-budget-rules.md). |
| §10.1 | Master dùng Agent SDK hay Messages API? | Provider registry hỗ trợ **OpenAI Responses** và **Anthropic Messages**, tool loop tự viết. Phase machine vẫn nằm trong code. [ADR 0020](adr/0020-production-master-provider-registry.md), [ADR 0013](adr/0013-phase-machine-outside-the-llm.md). |  |
| §10.3 | Workspace không phải git? | **Không** — `POST /api/workspaces` từ chối path không phải git repository. | Worktree phụ thuộc git, đúng đề xuất. |

### 0.3 Thêm ngoài kế hoạch

- **`DemoLlmClient`** (`apps/server/src/master/demo-llm.ts`) còn là test helper
  deterministic; production fallback của M7 đã bị M8 supersede.
  [ADR 0019](adr/0019-demo-llm-client-without-an-api-key.md), [ADR 0020](adr/0020-production-master-provider-registry.md).
- **`@nexestra/adapter-fake`**: test-only harness ghi file **thật** vào temp
  worktree, nên integration test vẫn chứng minh diff/verification mà không
  xuất hiện trong production.
  [ADR 0018](adr/0018-fake-harness-for-dev-and-tests.md).
- **`e2e/`**: Playwright chạy trên `apps/web/dist` do server thật phục vụ, không
  mock API, không stub fetch.
- **`docs/adr/`**: 22 ADR, một cái cho mỗi quyết định §1 cộng các quyết định phát
  sinh khi implement.

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
