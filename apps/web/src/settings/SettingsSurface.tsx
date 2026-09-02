import { type AppSettings, HarnessIdSchema, SandboxLevelSchema } from "@nexestra/core";
import { Button, Checkbox, MonoTable, Select, StatusDot, Tag, TextInput } from "@nexestra/ui-kit";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useHarnesses, useSaveSettings, useSettings, useWorkspaces } from "../lib/api.js";
import { useUiStore } from "../lib/store.js";

const HARNESS_OPTIONS = HarnessIdSchema.options.map((id) => ({ value: id, label: id }));
const SANDBOX_OPTIONS = SandboxLevelSchema.options.map((id) => ({ value: id, label: id }));

/** Reads and writes `/api/settings`; harness detection is still a fixture. */
export function SettingsSurface() {
  const harnesses = useHarnesses();
  const workspaces = useWorkspaces();
  const settings = useSettings();
  const saveSettings = useSaveSettings();
  const theme = useUiStore((state) => state.theme);
  const setTheme = useUiStore((state) => state.setTheme);
  const router = useRouter();

  const [draft, setDraft] = useState<AppSettings | null>(null);
  useEffect(() => {
    if (settings.data) setDraft(settings.data);
  }, [settings.data]);

  const workspace = workspaces.data?.[0];
  const dirty =
    draft !== null &&
    settings.data !== undefined &&
    JSON.stringify(draft) !== JSON.stringify(settings.data);

  const patch = (change: Partial<AppSettings>) =>
    setDraft((current) => (current ? { ...current, ...change } : current));

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
              Stored on the server in <code>~/.nexestra/nexestra.db</code>. Workspaces inherit these
              when they are created.
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

            <h2>Master</h2>
            {settings.data ? (
              <div className="kv" style={{ maxWidth: 460 }}>
                <span className="kv__k">model client</span>
                <span className="kv__v">
                  <Tag tone={settings.data.master.client === "anthropic" ? "accent" : "warn"}>
                    {settings.data.master.client}
                  </Tag>
                </span>
                <span className="kv__k">model</span>
                <span className="kv__v">{settings.data.master.model}</span>
                <span className="kv__k">API key</span>
                <span className="kv__v">
                  <StatusDot
                    tone={settings.data.master.apiKeyPresent ? "done" : "warn"}
                    label={settings.data.master.apiKeyPresent ? "present" : "not set"}
                  />
                </span>
              </div>
            ) : (
              <div className="nx-muted">loading…</div>
            )}
            <div className="nx-muted">
              {settings.data?.master.client === "demo" ? (
                <>
                  No <code>ANTHROPIC_API_KEY</code> on the server, so the Master runs on the
                  deterministic demo model: it clarifies, writes a spec and proposes a plan, but it
                  does not think. Set the key and restart the server to use{" "}
                  <code>claude-opus-5</code>.
                </>
              ) : (
                <>
                  The Master runs on the live Anthropic client. Choosing the client is a restart,
                  not a setting — change the environment and restart the server.
                </>
              )}
            </div>

            <h2>Defaults</h2>
            {draft ? (
              <div style={{ maxWidth: 320 }}>
                <Select
                  id="default-harness"
                  label="Default harness"
                  value={draft.defaultHarness}
                  options={HARNESS_OPTIONS}
                  onChange={(event) =>
                    patch({ defaultHarness: event.target.value as AppSettings["defaultHarness"] })
                  }
                />
                <TextInput
                  id="default-model"
                  label="Default model"
                  value={draft.defaultModel}
                  onChange={(event) => patch({ defaultModel: event.target.value })}
                />
                <Select
                  id="default-sandbox"
                  label="Default sandbox"
                  value={draft.defaultSandbox}
                  options={SANDBOX_OPTIONS}
                  onChange={(event) =>
                    patch({ defaultSandbox: event.target.value as AppSettings["defaultSandbox"] })
                  }
                />
                <TextInput
                  id="budget"
                  label="Budget per thread (USD)"
                  type="number"
                  min={0}
                  step={1}
                  value={String(draft.budgetUSD)}
                  onChange={(event) => patch({ budgetUSD: Number(event.target.value) || 0 })}
                />
                <TextInput
                  id="concurrency"
                  label="Concurrency (1–8)"
                  type="number"
                  min={1}
                  max={8}
                  step={1}
                  value={String(draft.concurrency)}
                  onChange={(event) =>
                    patch({
                      concurrency: Math.min(8, Math.max(1, Number(event.target.value) || 1)),
                    })
                  }
                />

                <div className="row" style={{ marginTop: 8 }}>
                  <Button
                    tone="primary"
                    disabled={!dirty || saveSettings.isPending}
                    onClick={() => saveSettings.mutate(draft)}
                  >
                    {saveSettings.isPending ? "Saving…" : "Save"}
                  </Button>
                  <Button disabled={!dirty} onClick={() => setDraft(settings.data ?? null)}>
                    Reset
                  </Button>
                  {saveSettings.isSuccess && !dirty ? (
                    <span className="nx-muted">saved</span>
                  ) : null}
                </div>
                {saveSettings.isError ? (
                  <div className="form-error">{saveSettings.error.message}</div>
                ) : null}
              </div>
            ) : (
              <div className="nx-muted">loading…</div>
            )}

            <h2>Detected harnesses</h2>
            <div className="nx-muted">
              Placeholder until the adapters shell out to <code>codex</code> and{" "}
              <code>opencode</code> (M4 / M5).
            </div>
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

            <h2>Workspace</h2>
            {workspace ? (
              <div className="kv" style={{ maxWidth: 420 }}>
                <span className="kv__k">name</span>
                <span className="kv__v">{workspace.name}</span>
                <span className="kv__k">root</span>
                <span className="kv__v">{workspace.rootPath}</span>
                <span className="kv__k">branch</span>
                <span className="kv__v">{workspace.defaultBranch}</span>
                <span className="kv__k">auto-merge</span>
                <span className="kv__v">{workspace.settings.autoMerge ? "yes" : "no"}</span>
              </div>
            ) : (
              <div className="nx-muted">no workspace yet</div>
            )}

            <h2>API key</h2>
            <div className="nx-muted">
              Read from <code>ANTHROPIC_API_KEY</code> (or <code>ANTHROPIC_AUTH_TOKEN</code>) on the
              server. The value never reaches the browser — only whether one is set.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
