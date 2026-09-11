import { Check, CircleAlert, GitBranch, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  KNOWLEDGE_BRANCH_NAME_MAX_LENGTH,
  type KnowledgeItem,
  type KnowledgeRepository,
  type KnowledgeRepositoryBranchesResponse,
} from "../shared/contracts.js";
import { ApiError, api } from "./api.js";
import "./RepositoryBranchPicker.css";

type LoadPhase = "loading" | "ready" | "error";

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export function RepositoryBranchPicker({
  item,
  generation,
  disabled = false,
  onPendingChange,
  onChanged,
}: {
  item: KnowledgeRepository;
  generation: number;
  disabled?: boolean;
  onPendingChange: (pending: boolean) => void;
  onChanged: (item: KnowledgeItem, generation: number, notice?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<LoadPhase>("loading");
  const [branches, setBranches] = useState<KnowledgeRepositoryBranchesResponse | null>(null);
  const [branchName, setBranchName] = useState("");
  const [applying, setApplying] = useState(false);
  const [listError, setListError] = useState<string>();
  const [applyError, setApplyError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const applyRef = useRef<HTMLButtonElement>(null);
  const loadRequestRef = useRef(0);
  const applyRequestRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const applyControllerRef = useRef<AbortController | null>(null);
  const applyingRef = useRef(false);
  const pendingApplyKeyRef = useRef<string | null>(null);
  const focusTriggerAfterCommitRef = useRef(false);
  const itemRef = useRef(item);
  itemRef.current = item;
  const generationRef = useRef(generation);
  generationRef.current = generation;
  const inputId = useId();
  const datalistId = useId();
  const panelId = useId();
  const effectiveBranch = item.selectedBranch ?? item.defaultBranch ?? null;
  const applyKey = `${item.id}:${item.sourceVersion ?? 0}:${generation}`;

  const cancelApply = useCallback(() => {
    applyRequestRef.current += 1;
    applyControllerRef.current?.abort();
    applyControllerRef.current = null;
    pendingApplyKeyRef.current = null;
    applyingRef.current = false;
    setApplying(false);
    onPendingChange(false);
  }, [onPendingChange]);

  // Abort anything still pending when the picker unmounts (dialog close or
  // workspace switch) so late responses can never close it or call onChanged.
  useEffect(
    () => () => {
      loadRequestRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
      pendingApplyKeyRef.current = null;
      applyingRef.current = false;
      applyRequestRef.current += 1;
      applyControllerRef.current?.abort();
      applyControllerRef.current = null;
    },
    [],
  );

  const loadBranches = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    const expectedKey = `${item.id}:${item.sourceVersion ?? 0}`;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setPhase("loading");
    setBranches(null);
    setListError(undefined);
    setConflict(false);
    try {
      const value = await api<KnowledgeRepositoryBranchesResponse>(
        `/api/knowledge/${encodeURIComponent(item.id)}/branches`,
        { signal: controller.signal },
      );
      if (requestId !== loadRequestRef.current || controller.signal.aborted) return;
      const currentItem = itemRef.current;
      if (`${currentItem.id}:${currentItem.sourceVersion ?? 0}` !== expectedKey) return;
      setBranches(value);
      setPhase("ready");
    } catch (caught) {
      if (requestId !== loadRequestRef.current || controller.signal.aborted) return;
      setPhase("error");
      setListError(messageFrom(caught));
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [item.id, item.sourceVersion]);

  const closePicker = useCallback(() => {
    loadRequestRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    cancelApply();
    setOpen(false);
    setBranchName("");
    setBranches(null);
    setPhase("loading");
    setListError(undefined);
    setApplyError(undefined);
    setConflict(false);
    focusTriggerAfterCommitRef.current = true;
  }, [cancelApply]);

  // If the repository item, its source version, or the workspace generation
  // changes while an apply is pending, cancel that intent immediately so a
  // late success, failure, or conflict can never touch the current state.
  useEffect(() => {
    if (!applyingRef.current || pendingApplyKeyRef.current === null) return;
    if (disabled) {
      cancelApply();
      return;
    }
    if (applyKey === pendingApplyKeyRef.current) return;
    cancelApply();
  }, [applyKey, cancelApply, disabled]);

  // Focus the trigger only after React commits the enable transition; calling
  // focus() synchronously while the button is still disabled drops the request.
  useEffect(() => {
    if (!focusTriggerAfterCommitRef.current) return;
    if (open || disabled || applying) return;
    if (!triggerRef.current || triggerRef.current.disabled) return;
    focusTriggerAfterCommitRef.current = false;
    triggerRef.current.focus();
  }, [open, disabled, applying]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Inline picker: stop the event before the outer dialog's bubble-phase
      // handler so Escape closes only this picker while it is open.
      event.stopPropagation();
      event.preventDefault();
      closePicker();
    };
    window.addEventListener("keydown", onKey, true);
    void loadBranches();
    return () => {
      window.removeEventListener("keydown", onKey, true);
      loadRequestRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [closePicker, loadBranches, open]);

  const handleApply = async () => {
    const branch = branchName.trim();
    if (disabled || applyingRef.current || conflict || phase !== "ready" || !branch || !branches) {
      return;
    }
    const operationGeneration = generationRef.current;
    const intentKey = `${itemRef.current.id}:${itemRef.current.sourceVersion ?? 0}:${operationGeneration}`;
    const requestId = ++applyRequestRef.current;
    applyControllerRef.current?.abort();
    const controller = new AbortController();
    applyControllerRef.current = controller;
    pendingApplyKeyRef.current = intentKey;
    applyingRef.current = true;
    setApplying(true);
    setApplyError(undefined);
    setConflict(false);
    onPendingChange(true);
    const currentKey = () =>
      `${itemRef.current.id}:${itemRef.current.sourceVersion ?? 0}:${generationRef.current}`;
    try {
      const updated = await api<KnowledgeItem>(
        `/api/knowledge/${encodeURIComponent(itemRef.current.id)}/source-branch`,
        {
          method: "POST",
          body: JSON.stringify({ branch, expectedSourceVersion: branches.sourceVersion }),
          signal: controller.signal,
        },
      );
      if (
        requestId !== applyRequestRef.current ||
        controller.signal.aborted ||
        intentKey !== pendingApplyKeyRef.current ||
        intentKey !== currentKey()
      ) {
        return;
      }
      if (updated.kind !== "repository") {
        setApplyError("The server returned an unexpected knowledge item.");
        return;
      }
      if (updated.refreshError) {
        setApplyError(updated.refreshError);
        return;
      }
      pendingApplyKeyRef.current = null;
      applyingRef.current = false;
      setApplying(false);
      setOpen(false);
      setBranchName("");
      onPendingChange(false);
      focusTriggerAfterCommitRef.current = true;
      onChanged(
        updated,
        operationGeneration,
        `Source branch set to ${updated.selectedBranch ?? branch}.`,
      );
    } catch (caught) {
      if (
        requestId !== applyRequestRef.current ||
        controller.signal.aborted ||
        intentKey !== pendingApplyKeyRef.current ||
        intentKey !== currentKey()
      ) {
        return;
      }
      if (caught instanceof ApiError && caught.status === 409) {
        setConflict(true);
      } else {
        setApplyError(messageFrom(caught));
      }
    } finally {
      if (applyControllerRef.current === controller) applyControllerRef.current = null;
      if (
        requestId === applyRequestRef.current &&
        intentKey === pendingApplyKeyRef.current &&
        intentKey === currentKey()
      ) {
        pendingApplyKeyRef.current = null;
        applyingRef.current = false;
        setApplying(false);
        onPendingChange(false);
      }
    }
  };

  const selectBranch = (name: string) => {
    setBranchName(name);
    setApplyError(undefined);
    applyRef.current?.focus();
  };

  if (item.status !== "ready") return null;

  return (
    <div className="repository-branch-picker">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        disabled={disabled || applying}
        onClick={() => setOpen(true)}
      >
        <GitBranch size={14} />
        Change branch
      </button>
      {open && (
        <section id={panelId} className="branch-picker-panel" aria-label="Change source branch">
          <label htmlFor={inputId}>Branch name</label>
          <div className="branch-picker-input-row">
            <input
              ref={inputRef}
              id={inputId}
              list={datalistId}
              maxLength={KNOWLEDGE_BRANCH_NAME_MAX_LENGTH}
              value={branchName}
              disabled={disabled || applying}
              placeholder={effectiveBranch ?? "Type a branch name"}
              onChange={(event) => {
                setBranchName(event.target.value);
                setApplyError(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                if (
                  !disabled &&
                  !applying &&
                  !conflict &&
                  phase === "ready" &&
                  branchName.trim() !== ""
                ) {
                  void handleApply();
                }
              }}
            />
            <button
              ref={applyRef}
              type="button"
              className="primary-button"
              disabled={
                disabled || applying || conflict || phase !== "ready" || branchName.trim() === ""
              }
              onClick={() => void handleApply()}
            >
              {applying ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}
              {applying ? "Applying…" : "Apply branch"}
            </button>
          </div>
          {phase === "loading" && !branches && (
            <p className="branch-picker-muted">
              <LoaderCircle className="spin" size={14} />
              Loading branches…
            </p>
          )}
          {phase === "error" && (
            <div className="branch-picker-alert" role="alert">
              <p className="form-error">
                <CircleAlert size={14} />
                {listError}
              </p>
              <button type="button" disabled={disabled} onClick={() => void loadBranches()}>
                Retry
              </button>
            </div>
          )}
          {branches && (
            <>
              <p className="branch-picker-muted">
                Current source branch: {branches.selectedBranch ?? "Not available"}
              </p>
              {branches.branches.length === 0 ? (
                <p className="branch-picker-muted">
                  No branches were returned. Type a branch name above.
                </p>
              ) : (
                <ul className="branch-picker-options" aria-label="Available branches">
                  {branches.branches.map((branch) => {
                    const active = branchName.trim() === branch.name;
                    return (
                      <li key={`${branch.name}:${branch.commit}`}>
                        <button
                          type="button"
                          className={active ? "active" : undefined}
                          disabled={disabled || applying}
                          onClick={() => selectBranch(branch.name)}
                        >
                          <GitBranch size={14} />
                          <span>{branch.name}</span>
                          <code title={branch.commit}>{branch.commit.slice(0, 7)}</code>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {branches.truncated && (
                <p className="branch-picker-muted">
                  Showing the first {branches.branches.length} branches. You can type another branch
                  name manually.
                </p>
              )}
            </>
          )}
          {applyError && (
            <p className="form-error" role="alert">
              <CircleAlert size={14} />
              {applyError}
            </p>
          )}
          {conflict && (
            <div className="branch-picker-conflict" role="alert">
              <strong>Source version changed</strong>
              <p>
                The repository changed while you were applying. Reload the branch list, then apply
                your choice again.
              </p>
              <button type="button" disabled={disabled} onClick={() => void loadBranches()}>
                Reload branches
              </button>
            </div>
          )}
          <div className="branch-picker-actions">
            <button type="button" onClick={closePicker}>
              Cancel
            </button>
          </div>
        </section>
      )}
      <datalist id={datalistId}>
        {branches?.branches.map((branch) => (
          <option key={`${branch.name}:${branch.commit}`} value={branch.name} />
        ))}
      </datalist>
    </div>
  );
}
