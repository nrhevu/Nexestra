import type { ComponentType } from "react";
import type { Workspace } from "../shared/contracts.js";

export const WORKSPACE_ARCHIVE_DIALOG_LOAD_TIMEOUT_MS = 15_000;

export type WorkspaceArchiveDialogKind = "export" | "inspection";

export interface WorkspaceArchiveDialogContentProps {
  workspace: Pick<Workspace, "id" | "name">;
  onClose: () => void;
}

export type WorkspaceArchiveDialogComponent = ComponentType<WorkspaceArchiveDialogContentProps>;

export interface WorkspaceArchiveDialogProps extends WorkspaceArchiveDialogContentProps {
  kind: WorkspaceArchiveDialogKind;
}

export interface WorkspaceArchiveDialogLoadingProps {
  kind: WorkspaceArchiveDialogKind;
  failure: "load" | "timeout" | null;
  onRetry: () => void;
  onClose: () => void;
}
