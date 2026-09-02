import { type MasterProvider, type MasterProviderAuth, MasterProviderSchema } from "@nexestra/core";
import { Button, Checkbox, Select, TextInput } from "@nexestra/ui-kit";
import { type FormEvent, useEffect, useState } from "react";
import { useCreateMasterProvider } from "../lib/api.js";

const PROTOCOL_OPTIONS = [
  { value: "openai-responses", label: "OpenAI Responses API" },
  { value: "anthropic-messages", label: "Anthropic Messages API" },
];

const AUTH_OPTIONS = [
  { value: "api-key", label: "API key" },
  { value: "none", label: "No authentication" },
];

interface ProviderForm {
  providerId: string;
  name: string;
  protocol: MasterProvider["protocol"];
  baseUrl: string;
  auth: MasterProviderAuth;
  apiKey: string;
  model: string;
  activate: boolean;
}

const EMPTY_FORM: ProviderForm = {
  providerId: "",
  name: "",
  protocol: "openai-responses",
  baseUrl: "",
  auth: "api-key",
  apiKey: "",
  model: "",
  activate: true,
};

export interface CustomProviderDialogProps {
  open: boolean;
  existingProviderIds: ReadonlySet<string>;
  onClose: () => void;
}

/** OpenCode-inspired one-step connection flow for a custom Master provider. */
export function CustomProviderDialog({
  open,
  existingProviderIds,
  onClose,
}: CustomProviderDialogProps) {
  const createProvider = useCreateMasterProvider();
  const [form, setForm] = useState<ProviderForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setForm(EMPTY_FORM);
    setErrors({});
  }, [open]);

  if (!open) return null;

  const setField = <K extends keyof ProviderForm>(field: K, value: ProviderForm[K]) => {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  };

  const close = () => {
    createProvider.reset();
    onClose();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (createProvider.isPending) return;

    const provider = {
      id: form.providerId.trim(),
      name: form.name.trim(),
      protocol: form.protocol,
      baseUrl: form.baseUrl.trim().replace(/\/+$/, ""),
      model: form.model.trim(),
      auth: form.auth,
      enabled: true,
    };
    const parsed = MasterProviderSchema.safeParse(provider);
    const nextErrors: Record<string, string> = {};
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === "id") nextErrors.providerId ??= issue.message;
        else if (typeof field === "string") nextErrors[field] ??= issue.message;
      }
    }
    if (existingProviderIds.has(provider.id)) {
      nextErrors.providerId = `Provider id "${provider.id}" already exists.`;
    }
    if (form.auth === "api-key" && !form.apiKey.trim()) {
      nextErrors.apiKey = "Enter the API key for this provider.";
    }
    if (Object.keys(nextErrors).length > 0 || !parsed.success) {
      setErrors(nextErrors);
      return;
    }

    createProvider.mutate(
      {
        provider: { ...parsed.data, auth: form.auth },
        ...(form.auth === "api-key" ? { credential: form.apiKey.trim() } : {}),
        activate: form.activate,
      },
      { onSuccess: close },
    );
  };

  return (
    <div className="palette-backdrop">
      <button type="button" className="palette__scrim" aria-label="Cancel" onClick={close} />
      <form
        className="dialog custom-provider-dialog"
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-label="Add custom provider"
      >
        <div className="custom-provider-dialog__head">
          <span className="custom-provider-dialog__mark" aria-hidden="true">
            ✦
          </span>
          <div>
            <strong>Add custom provider</strong>
            <span>Connect a compatible endpoint to the Master.</span>
          </div>
        </div>

        <div className="custom-provider-dialog__body nx-scroll">
          <p className="custom-provider-dialog__intro">
            Provider configuration and credentials are saved separately. The API key is write-only
            and will not be shown again after you connect.
          </p>

          <div className="custom-provider-dialog__fields">
            <div>
              <TextInput
                id="custom-provider-id"
                label="Provider ID"
                autoFocus
                value={form.providerId}
                placeholder="my-provider"
                aria-invalid={Boolean(errors.providerId)}
                onChange={(event) => setField("providerId", event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") close();
                }}
              />
              <span className="nx-muted">Unique lowercase ID used in settings and logs.</span>
              {errors.providerId ? <span className="form-error">{errors.providerId}</span> : null}
            </div>

            <div>
              <TextInput
                id="custom-provider-name"
                label="Display name"
                value={form.name}
                placeholder="My AI Provider"
                aria-invalid={Boolean(errors.name)}
                onChange={(event) => setField("name", event.target.value)}
              />
              {errors.name ? <span className="form-error">{errors.name}</span> : null}
            </div>

            <div>
              <Select
                id="custom-provider-protocol"
                label="API protocol"
                value={form.protocol}
                options={PROTOCOL_OPTIONS}
                onChange={(event) =>
                  setField("protocol", event.target.value as MasterProvider["protocol"])
                }
              />
              <span className="nx-muted">
                Select the wire protocol the endpoint actually implements.
              </span>
            </div>

            <div>
              <TextInput
                id="custom-provider-url"
                label="Base URL"
                value={form.baseUrl}
                placeholder="https://api.provider.com/v1"
                aria-invalid={Boolean(errors.baseUrl)}
                onChange={(event) => setField("baseUrl", event.target.value)}
              />
              {errors.baseUrl ? <span className="form-error">{errors.baseUrl}</span> : null}
            </div>

            <div>
              <Select
                id="custom-provider-auth"
                label="Authentication"
                value={form.auth}
                options={AUTH_OPTIONS}
                onChange={(event) => setField("auth", event.target.value as MasterProviderAuth)}
              />
              {form.auth === "none" ? (
                <span className="nx-muted">Use only with a trusted local endpoint.</span>
              ) : null}
            </div>

            {form.auth === "api-key" ? (
              <div>
                <TextInput
                  id="custom-provider-key"
                  label="API key"
                  type="password"
                  autoComplete="new-password"
                  value={form.apiKey}
                  placeholder="Paste API key"
                  aria-invalid={Boolean(errors.apiKey)}
                  onChange={(event) => setField("apiKey", event.target.value)}
                />
                <span className="nx-muted">Stored locally with current-user-only permissions.</span>
                {errors.apiKey ? <span className="form-error">{errors.apiKey}</span> : null}
              </div>
            ) : null}
          </div>

          <div className="custom-provider-dialog__section">
            <span className="custom-provider-dialog__label">Master model</span>
            <TextInput
              id="custom-provider-model"
              label="Model ID"
              value={form.model}
              placeholder="provider-model-id"
              aria-invalid={Boolean(errors.model)}
              onChange={(event) => setField("model", event.target.value)}
            />
            <span className="nx-muted">The exact model identifier sent to this endpoint.</span>
            {errors.model ? <span className="form-error">{errors.model}</span> : null}
          </div>

          <Checkbox
            checked={form.activate}
            label="Use this provider after connecting"
            onChange={(activate) => setField("activate", activate)}
          />

          {createProvider.isError ? (
            <div className="dialog__error">{createProvider.error.message}</div>
          ) : null}
        </div>

        <div className="dialog__foot">
          <Button type="button" onClick={close} disabled={createProvider.isPending}>
            Cancel
          </Button>
          <Button tone="primary" type="submit" disabled={createProvider.isPending}>
            {createProvider.isPending ? "Connecting…" : "Add provider"}
          </Button>
        </div>
      </form>
    </div>
  );
}
