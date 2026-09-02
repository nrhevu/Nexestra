import {
  type AppSettings,
  AppSettingsSchema,
  HarnessIdSchema,
  type MasterProvider,
  MasterProviderSchema,
  SandboxLevelSchema,
} from "@nexestra/core";
import { Button, Checkbox, MonoTable, Select, StatusDot, Tag, TextInput } from "@nexestra/ui-kit";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  useHarnesses,
  useRefreshHarnesses,
  useSaveSettings,
  useSettings,
  useWorkspaces,
} from "../lib/api.js";
import { useUiStore } from "../lib/store.js";

const HARNESS_OPTIONS = HarnessIdSchema.options
  .filter((id) => id === "codex" || id === "opencode")
  .map((id) => ({ value: id, label: id }));
const SANDBOX_OPTIONS = SandboxLevelSchema.options.map((id) => ({ value: id, label: id }));
const PROVIDER_PROTOCOL_OPTIONS = [
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
];

const EMPTY_PROVIDER: MasterProvider = {
  id: "",
  name: "",
  protocol: "openai-responses",
  baseUrl: "https://",
  model: "",
  apiKeyEnv: "",
  enabled: true,
};

/** Reads and writes `/api/settings`, and shows what `discover()` found (M6). */
export function SettingsSurface() {
  const harnesses = useHarnesses();
  const refreshHarnesses = useRefreshHarnesses();
  const workspaces = useWorkspaces();
  const settings = useSettings();
  const saveSettings = useSaveSettings();
  const theme = useUiStore((state) => state.theme);
  const setTheme = useUiStore((state) => state.setTheme);
  const router = useRouter();

  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [providerDraft, setProviderDraft] = useState<MasterProvider>(EMPTY_PROVIDER);
  const [providerError, setProviderError] = useState<string | null>(null);
  useEffect(() => {
    if (settings.data) setDraft(AppSettingsSchema.parse(settings.data));
  }, [settings.data]);

  const workspace = workspaces.data?.[0];
  const dirty =
    draft !== null &&
    settings.data !== undefined &&
    JSON.stringify(draft) !== JSON.stringify(AppSettingsSchema.parse(settings.data));

  const patch = (change: Partial<AppSettings>) =>
    setDraft((current) => (current ? { ...current, ...change } : current));

  const updateProvider = (id: string, change: Partial<MasterProvider>) => {
    if (!draft) return;
    patch({
      masterProviders: draft.masterProviders.map((provider) =>
        provider.id === id ? { ...provider, ...change } : provider,
      ),
    });
  };

  const addProvider = () => {
    if (!draft) return;
    const normalised = {
      ...providerDraft,
      id: providerDraft.id.trim(),
      name: providerDraft.name.trim(),
      baseUrl: providerDraft.baseUrl.trim().replace(/\/+$/, ""),
      model: providerDraft.model.trim(),
      apiKeyEnv: providerDraft.apiKeyEnv?.trim() || undefined,
    };
    const parsed = MasterProviderSchema.safeParse(normalised);
    if (!parsed.success) {
      setProviderError(parsed.error.issues[0]?.message ?? "Invalid provider");
      return;
    }
    if (draft.masterProviders.some((provider) => provider.id === parsed.data.id)) {
      setProviderError(`Provider id "${parsed.data.id}" already exists.`);
      return;
    }
    patch({ masterProviders: [...draft.masterProviders, parsed.data] });
    setProviderDraft(EMPTY_PROVIDER);
    setProviderError(null);
  };

  return (
    <div className="app app--settings">
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

            <h2>Master provider</h2>
            {settings.data ? (
              <div className="provider-status">
                <div className="kv">
                  <span className="kv__k">status</span>
                  <span className="kv__v">
                    <StatusDot
                      tone={settings.data.master.ready ? "done" : "warn"}
                      label={settings.data.master.ready ? "ready" : "configuration required"}
                    />
                  </span>
                  <span className="kv__k">provider</span>
                  <span className="kv__v">
                    {settings.data.master.providerName ?? "No provider selected"}
                  </span>
                  <span className="kv__k">protocol</span>
                  <span className="kv__v">{settings.data.master.protocol ?? "—"}</span>
                  <span className="kv__k">model</span>
                  <span className="kv__v">{settings.data.master.model || "—"}</span>
                  <span className="kv__k">credential</span>
                  <span className="kv__v">
                    {settings.data.master.credentialEnv ? (
                      <>
                        <code>{settings.data.master.credentialEnv}</code>{" "}
                        <Tag tone={settings.data.master.credentialPresent ? "accent" : "warn"}>
                          {settings.data.master.credentialPresent ? "present" : "missing"}
                        </Tag>
                      </>
                    ) : (
                      "not required"
                    )}
                  </span>
                </div>
                {settings.data.master.message ? (
                  <div className="provider-status__message">{settings.data.master.message}</div>
                ) : null}
              </div>
            ) : (
              <div className="nx-muted">loading…</div>
            )}
            <div className="settings__notice">
              ChatGPT subscription OAuth is not exposed to third-party apps. Nexestra therefore uses
              the official OpenAI API with a server-side <code>OPENAI_API_KEY</code>. Choose the
              built-in OpenAI provider with <code>chat-latest</code> to use the model aligned with
              ChatGPT, or change the model to <code>gpt-5.6</code> for the recommended production
              API model. Secrets never enter this page or the database.
            </div>

            {draft ? (
              <>
                <div className="provider-list">
                  {draft.masterProviders.map((provider) => {
                    const active = draft.activeMasterProviderId === provider.id;
                    return (
                      <section
                        className={`provider-card${active ? " provider-card--active" : ""}`}
                        key={provider.id}
                      >
                        <div className="provider-card__head">
                          <div>
                            <strong>{provider.name}</strong>
                            <span>{provider.id}</span>
                          </div>
                          <div className="row">
                            <StatusDot
                              tone={provider.enabled ? "done" : "idle"}
                              label={provider.enabled ? "enabled" : "disabled"}
                            />
                            <Button
                              boxed
                              tone={active ? "primary" : "default"}
                              disabled={!provider.enabled}
                              onClick={() => patch({ activeMasterProviderId: provider.id })}
                            >
                              {active ? "Active" : "Use"}
                            </Button>
                            <Button
                              tone="danger"
                              onClick={() =>
                                patch({
                                  masterProviders: draft.masterProviders.filter(
                                    (entry) => entry.id !== provider.id,
                                  ),
                                  activeMasterProviderId: active
                                    ? null
                                    : draft.activeMasterProviderId,
                                })
                              }
                            >
                              Remove
                            </Button>
                          </div>
                        </div>
                        <div className="provider-card__grid">
                          <Select
                            label="Protocol"
                            value={provider.protocol}
                            options={PROVIDER_PROTOCOL_OPTIONS}
                            onChange={(event) =>
                              updateProvider(provider.id, {
                                protocol: event.target.value as MasterProvider["protocol"],
                              })
                            }
                          />
                          <TextInput
                            label="Model"
                            value={provider.model}
                            onChange={(event) =>
                              updateProvider(provider.id, { model: event.target.value })
                            }
                          />
                          <TextInput
                            label="Base URL"
                            value={provider.baseUrl}
                            onChange={(event) =>
                              updateProvider(provider.id, { baseUrl: event.target.value })
                            }
                          />
                          <TextInput
                            label="Credential env"
                            value={provider.apiKeyEnv ?? ""}
                            placeholder="Optional for a local endpoint"
                            onChange={(event) =>
                              updateProvider(provider.id, {
                                apiKeyEnv: event.target.value || undefined,
                              })
                            }
                          />
                        </div>
                        <Checkbox
                          checked={provider.enabled}
                          label="Provider enabled"
                          onChange={(enabled) => updateProvider(provider.id, { enabled })}
                        />
                      </section>
                    );
                  })}
                </div>

                <section className="provider-new">
                  <div className="provider-new__title">Add custom provider</div>
                  <div className="provider-card__grid">
                    <TextInput
                      label="Provider id"
                      placeholder="company-models"
                      value={providerDraft.id}
                      onChange={(event) =>
                        setProviderDraft((current) => ({ ...current, id: event.target.value }))
                      }
                    />
                    <TextInput
                      label="Display name"
                      placeholder="Company Models"
                      value={providerDraft.name}
                      onChange={(event) =>
                        setProviderDraft((current) => ({ ...current, name: event.target.value }))
                      }
                    />
                    <Select
                      label="Protocol"
                      value={providerDraft.protocol}
                      options={PROVIDER_PROTOCOL_OPTIONS}
                      onChange={(event) =>
                        setProviderDraft((current) => ({
                          ...current,
                          protocol: event.target.value as MasterProvider["protocol"],
                        }))
                      }
                    />
                    <TextInput
                      label="Model"
                      placeholder="model-id"
                      value={providerDraft.model}
                      onChange={(event) =>
                        setProviderDraft((current) => ({ ...current, model: event.target.value }))
                      }
                    />
                    <TextInput
                      label="Base URL"
                      placeholder="https://models.example/v1"
                      value={providerDraft.baseUrl}
                      onChange={(event) =>
                        setProviderDraft((current) => ({ ...current, baseUrl: event.target.value }))
                      }
                    />
                    <TextInput
                      label="Credential env"
                      placeholder="COMPANY_API_KEY"
                      value={providerDraft.apiKeyEnv ?? ""}
                      onChange={(event) =>
                        setProviderDraft((current) => ({
                          ...current,
                          apiKeyEnv: event.target.value,
                        }))
                      }
                    />
                  </div>
                  <div className="row">
                    <Button boxed tone="primary" onClick={addProvider}>
                      Add provider
                    </Button>
                    {providerError ? <span className="form-error">{providerError}</span> : null}
                  </div>
                </section>
              </>
            ) : null}

            <h2>Execution defaults</h2>
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
                <TextInput
                  id="max-attempts"
                  label="Max attempts per task (1–10)"
                  type="number"
                  min={1}
                  max={10}
                  step={1}
                  value={String(draft.maxAttempts)}
                  onChange={(event) =>
                    patch({
                      maxAttempts: Math.min(10, Math.max(1, Number(event.target.value) || 1)),
                    })
                  }
                />
                <Checkbox
                  checked={draft.autoMerge}
                  label="Merge a verified task branch without asking"
                  onChange={(next) => patch({ autoMerge: next })}
                />

                <div className="row" style={{ marginTop: 8 }}>
                  <Button
                    tone="primary"
                    disabled={!dirty || saveSettings.isPending}
                    onClick={() => saveSettings.mutate(draft)}
                  >
                    {saveSettings.isPending ? "Saving…" : "Save changes"}
                  </Button>
                  <Button
                    disabled={!dirty}
                    onClick={() =>
                      setDraft(settings.data ? AppSettingsSchema.parse(settings.data) : null)
                    }
                  >
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
              Real detection: the server runs each adapter's <code>discover()</code> once and caches
              it, because it shells out to <code>codex --version</code> and to an{" "}
              <code>opencode serve</code>. Refresh after installing or authenticating one.
            </div>
            <div className="row" style={{ margin: "6px 0" }}>
              <Button
                disabled={refreshHarnesses.isPending}
                onClick={() => refreshHarnesses.mutate()}
              >
                {refreshHarnesses.isPending ? "Detecting…" : "Refresh detection"}
              </Button>
              {refreshHarnesses.isError ? (
                <span className="form-error">{refreshHarnesses.error.message}</span>
              ) : null}
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
          </div>
        </div>
      </div>
    </div>
  );
}
