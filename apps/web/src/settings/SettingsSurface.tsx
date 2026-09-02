import { Button, Checkbox, MonoTable, Select, StatusDot, Tag } from "@nexestra/ui-kit";
import { useRouter } from "@tanstack/react-router";
import { useHarnesses, useWorkspaces } from "../lib/api.js";
import { useUiStore } from "../lib/store.js";

/** Read-only settings placeholder: detected harnesses and workspace defaults. */
export function SettingsSurface() {
  const harnesses = useHarnesses();
  const workspaces = useWorkspaces();
  const theme = useUiStore((state) => state.theme);
  const setTheme = useUiStore((state) => state.setTheme);
  const router = useRouter();

  const workspace = workspaces.data?.[0];

  return (
    <div className="app">
      <div className="surface" style={{ width: "100%" }}>
        <header className="surface__head">
          <span className="surface__title">Settings</span>
          <span className="surface__head-right">
            <Button onClick={() => router.history.back()}>Back</Button>
          </span>
        </header>
        <div className="surface__main nx-scroll">
          <div className="settings">
            <h1>Nexestra — local settings</h1>
            <div className="nx-muted">
              M0 renders detected harnesses and defaults read-only. Editing lands in M7.
            </div>

            <h2>Appearance</h2>
            <Checkbox
              checked={theme === "dark"}
              label="Dark theme"
              onChange={(next) => setTheme(next ? "dark" : "light")}
            />
            <Checkbox
              checked={theme === "light"}
              label="Light theme"
              onChange={(next) => setTheme(next ? "light" : "dark")}
            />

            <h2>Detected harnesses</h2>
            <MonoTable
              rowKey={(row) => row.id}
              rows={harnesses.data ?? []}
              columns={[
                {
                  key: "id",
                  header: "harness",
                  width: "110px",
                  render: (row) => (
                    <StatusDot tone={row.available ? "done" : "idle"} label={row.id} />
                  ),
                },
                {
                  key: "version",
                  header: "version",
                  width: "90px",
                  render: (row) => row.version ?? "—",
                },
                {
                  key: "range",
                  header: "tested range",
                  width: "130px",
                  render: (row) => row.supportedVersionRange ?? "—",
                },
                {
                  key: "auth",
                  header: "auth",
                  width: "70px",
                  render: (row) => (
                    <Tag tone={row.authOk ? "accent" : "warn"}>{row.authOk ? "ok" : "—"}</Tag>
                  ),
                },
                {
                  key: "path",
                  header: "binary",
                  render: (row) => row.binaryPath ?? row.warnings.join(" ") ?? "—",
                },
              ]}
            />

            <h2>Workspace defaults</h2>
            {workspace ? (
              <div style={{ maxWidth: 320 }}>
                <Select
                  id="default-harness"
                  label="Default harness"
                  value={workspace.settings.defaultHarness}
                  options={[
                    { value: "codex", label: "codex" },
                    { value: "opencode", label: "opencode" },
                    { value: "acp", label: "acp" },
                  ]}
                  onChange={() => undefined}
                />
                <Select
                  id="default-sandbox"
                  label="Default sandbox"
                  value={workspace.settings.defaultSandbox}
                  options={[
                    { value: "read-only", label: "read-only" },
                    { value: "workspace-write", label: "workspace-write" },
                    { value: "danger-full-access", label: "danger-full-access" },
                  ]}
                  onChange={() => undefined}
                />
                <div className="kv">
                  <span className="kv__k">root</span>
                  <span className="kv__v">{workspace.rootPath}</span>
                  <span className="kv__k">branch</span>
                  <span className="kv__v">{workspace.defaultBranch}</span>
                  <span className="kv__k">model</span>
                  <span className="kv__v">{workspace.settings.defaultModel ?? "—"}</span>
                  <span className="kv__k">concurrency</span>
                  <span className="kv__v">{workspace.settings.concurrency}</span>
                  <span className="kv__k">budget</span>
                  <span className="kv__v">${workspace.settings.budgetUSD.toFixed(2)}</span>
                  <span className="kv__k">auto-merge</span>
                  <span className="kv__v">{workspace.settings.autoMerge ? "yes" : "no"}</span>
                </div>
              </div>
            ) : (
              <div className="nx-muted">loading…</div>
            )}

            <h2>API key</h2>
            <div className="nx-muted">
              Read from <code>ANTHROPIC_API_KEY</code> on the server. Never stored in the browser.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
