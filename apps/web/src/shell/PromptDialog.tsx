import { Button, TextInput } from "@nexestra/ui-kit";
import { type FormEvent, useEffect, useState } from "react";

export interface PromptDialogProps {
  open: boolean;
  title: string;
  label: string;
  hint?: string;
  placeholder?: string;
  initialValue?: string;
  submitLabel?: string;
  /** Rendered under the field, e.g. the server's rejection of a path. */
  error?: string | null;
  busy?: boolean;
  onSubmit: (value: string) => void;
  onClose: () => void;
}

/** One-field modal used for "new workspace" and "new thread". */
export function PromptDialog({
  open,
  title,
  label,
  hint,
  placeholder,
  initialValue = "",
  submitLabel = "Create",
  error = null,
  busy = false,
  onSubmit,
  onClose,
}: PromptDialogProps) {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  if (!open) return null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed) onSubmit(trimmed);
  };

  return (
    <div className="palette-backdrop">
      <button type="button" className="palette__scrim" aria-label="Cancel" onClick={onClose} />
      <form className="dialog" onSubmit={submit} aria-label={title}>
        <div className="dialog__head">{title}</div>
        <div className="dialog__body">
          <TextInput
            id="dialog-value"
            label={label}
            autoFocus
            value={value}
            placeholder={placeholder}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
            }}
          />
          {hint ? <div className="nx-muted">{hint}</div> : null}
          {error ? <div className="dialog__error">{error}</div> : null}
        </div>
        <div className="dialog__foot">
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" type="submit" disabled={busy || value.trim().length === 0}>
            {busy ? "Working…" : submitLabel}
          </Button>
        </div>
      </form>
    </div>
  );
}
