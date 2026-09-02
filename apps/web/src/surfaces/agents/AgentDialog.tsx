import type { AgentHarness, MasterProvider } from "@nexestra/core";
import { Button, Select, TextInput } from "@nexestra/ui-kit";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useCreateAgent, useHarnesses, useProviderModels, useSettings } from "../../lib/api.js";

const HARNESS_OPTIONS = [
  { value: "codex", label: "Codex" },
  { value: "opencode", label: "OpenCode" },
  { value: "nexestra", label: "Nexestra (Master)" },
];

interface AgentForm {
  name: string;
  description: string;
  instructions: string;
  harness: AgentHarness;
  providerId: string;
  model: string;
}

const EMPTY_FORM: AgentForm = {
  name: "",
  description: "",
  instructions: "",
  harness: "codex",
  providerId: "",
  model: "",
};

export function AgentDialog({
  open,
  workspaceId,
  onClose,
}: {
  open: boolean;
  workspaceId: string;
  onClose: () => void;
}) {
  const createAgent = useCreateAgent(workspaceId);
  const harnesses = useHarnesses();
  const settings = useSettings();
  const [form, setForm] = useState<AgentForm>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);

  const providers = (settings.data?.masterProviders ?? []).filter((provider) => provider.enabled);
  const provider = providers.find((entry) => entry.id === form.providerId);
  const providerModels = useProviderModels(
    form.providerId,
    open && form.harness === "nexestra" && form.providerId.length > 0,
  );
  const modelOptions = useMemo(
    () => modelsFor(form.harness, provider, providerModels.data?.models, harnesses.data),
    [form.harness, provider, providerModels.data?.models, harnesses.data],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: initialise each dialog opening only
  useEffect(() => {
    if (!open) return;
    setForm(EMPTY_FORM);
    setError(null);
    createAgent.reset();
  }, [open]);

  useEffect(() => {
    if (!open || form.harness !== "nexestra" || form.model || modelOptions.length === 0) return;
    setForm((current) => ({ ...current, model: modelOptions[0]?.value ?? "" }));
  }, [open, form.harness, form.model, modelOptions]);

  if (!open) return null;

  const setHarness = (harness: AgentHarness) => {
    const providerId = harness === "nexestra" ? (providers[0]?.id ?? "") : "";
    setForm((current) => ({ ...current, harness, providerId, model: "" }));
    setError(null);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const name = form.name.trim();
    if (!name) {
      setError("Enter an agent name.");
      return;
    }
    if (form.harness === "nexestra" && (!form.providerId || !form.model)) {
      setError("Select a configured provider and model for the Nexestra agent.");
      return;
    }
    createAgent.mutate(
      {
        name,
        description: form.description.trim(),
        instructions: form.instructions.trim(),
        harness: form.harness,
        ...(form.harness === "nexestra" ? { providerId: form.providerId } : {}),
        ...(form.model ? { model: form.model } : {}),
        enabled: true,
      },
      { onSuccess: onClose },
    );
  };

  return (
    <div className="palette-backdrop">
      <button type="button" className="palette__scrim" aria-label="Cancel" onClick={onClose} />
      <form
        className="dialog custom-provider-dialog agent-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Create agent"
        onSubmit={submit}
      >
        <div className="custom-provider-dialog__head">
          <span className="custom-provider-dialog__mark" aria-hidden="true">
            @
          </span>
          <div>
            <strong>Create an agent</strong>
            <span>Choose where it runs, then pin it to a model.</span>
          </div>
        </div>

        <div className="custom-provider-dialog__body nx-scroll">
          <TextInput
            id="agent-name"
            label="Name"
            autoFocus
            value={form.name}
            placeholder="Research lead"
            onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
          />
          <TextInput
            id="agent-description"
            label="Description"
            value={form.description}
            placeholder="What this agent is responsible for"
            onChange={(event) =>
              setForm((current) => ({ ...current, description: event.target.value }))
            }
          />
          <Select
            id="agent-harness"
            label="Harness"
            value={form.harness}
            options={HARNESS_OPTIONS}
            onChange={(event) => setHarness(event.target.value as AgentHarness)}
          />

          {form.harness === "nexestra" ? (
            <>
              {providers.length > 0 ? (
                <Select
                  id="agent-provider"
                  label="Provider"
                  value={form.providerId}
                  options={providers.map((entry) => ({ value: entry.id, label: entry.name }))}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      providerId: event.target.value,
                      model: "",
                    }))
                  }
                />
              ) : (
                <div className="card card--error">
                  Add and enable a provider in Settings before creating a Nexestra agent.
                </div>
              )}
              <Select
                id="agent-model"
                label="Model"
                value={form.model}
                options={
                  modelOptions.length > 0
                    ? modelOptions
                    : [{ value: "", label: providerModels.isPending ? "Loading…" : "No models" }]
                }
                disabled={modelOptions.length === 0}
                onChange={(event) =>
                  setForm((current) => ({ ...current, model: event.target.value }))
                }
              />
              {providerModels.isError ? (
                <div className="form-error">
                  {providerModels.error.message} The provider's configured model remains available
                  as a fallback.
                </div>
              ) : null}
            </>
          ) : (
            <>
              <Select
                id="agent-model"
                label="Model"
                value={form.model}
                options={[{ value: "", label: "Harness default" }, ...modelOptions]}
                onChange={(event) =>
                  setForm((current) => ({ ...current, model: event.target.value }))
                }
              />
              <HarnessStatus harness={form.harness} harnesses={harnesses.data ?? []} />
            </>
          )}

          <label className="nx-field" htmlFor="agent-instructions">
            <span className="nx-field__label">Instructions</span>
            <textarea
              id="agent-instructions"
              className="nx-textarea agent-dialog__instructions"
              rows={6}
              value={form.instructions}
              placeholder="Persistent role and working instructions for this agent"
              onChange={(event) =>
                setForm((current) => ({ ...current, instructions: event.target.value }))
              }
            />
          </label>

          {error ? <div className="form-error">{error}</div> : null}
          {createAgent.isError ? (
            <div className="form-error">{createAgent.error.message}</div>
          ) : null}
        </div>

        <div className="dialog__foot">
          <Button type="button" onClick={onClose} disabled={createAgent.isPending}>
            Cancel
          </Button>
          <Button tone="primary" type="submit" disabled={createAgent.isPending}>
            {createAgent.isPending ? "Creating…" : "Create agent"}
          </Button>
        </div>
      </form>
    </div>
  );
}

function modelsFor(
  harness: AgentHarness,
  provider: MasterProvider | undefined,
  providerModels: readonly string[] | undefined,
  harnesses: readonly { id: string; models: string[] }[] | undefined,
) {
  const models =
    harness === "nexestra"
      ? providerModels && providerModels.length > 0
        ? providerModels
        : provider?.model
          ? [provider.model]
          : []
      : (harnesses?.find((entry) => entry.id === harness)?.models ?? []);
  return [...new Set(models)].map((model) => ({ value: model, label: model }));
}

function HarnessStatus({
  harness,
  harnesses,
}: {
  harness: "codex" | "opencode";
  harnesses: readonly { id: string; available: boolean; authOk: boolean; warnings: string[] }[];
}) {
  const info = harnesses.find((entry) => entry.id === harness);
  if (!info) return <span className="nx-muted">Detecting this harness…</span>;
  if (!info.available) return <span className="form-error">{harness} is not installed.</span>;
  if (!info.authOk) return <span className="form-error">{harness} is not authenticated.</span>;
  return <span className="nx-muted">{harness} is installed and authenticated.</span>;
}
