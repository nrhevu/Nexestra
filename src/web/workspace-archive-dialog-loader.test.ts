import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_ARCHIVE_DIALOG_LOAD_TIMEOUT_MS,
  type WorkspaceArchiveDialogComponent,
} from "./workspace-archive-dialog-contracts.js";

const exportFixture: WorkspaceArchiveDialogComponent = () => null;
const inspectionFixture: WorkspaceArchiveDialogComponent = () => null;
const staleFixture: WorkspaceArchiveDialogComponent = () => null;
const retriedFixture: WorkspaceArchiveDialogComponent = () => null;

type MockModule = Record<string, unknown>;

function deferredModule() {
  let resolveModule!: (module: MockModule) => void;
  let rejectModule!: (error: unknown) => void;
  const modulePromise = new Promise<MockModule>((resolve, reject) => {
    resolveModule = resolve;
    rejectModule = reject;
  });
  return { modulePromise, resolveModule, rejectModule };
}

async function loadLoader() {
  const { loadWorkspaceArchiveDialog, WorkspaceArchiveDialogLoadError } = await import(
    "./workspace-archive-dialog-loader.js"
  );
  return { loadWorkspaceArchiveDialog, WorkspaceArchiveDialogLoadError };
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  vi.doUnmock("./WorkspaceExportDialog.js");
  vi.doUnmock("./WorkspaceArchiveInspectionDialog.js");
});

describe("workspace archive dialog loader", () => {
  it("does not import dialog modules while only loading the registry", async () => {
    const exportFactory = vi.fn(() => ({ WorkspaceExportDialog: exportFixture }));
    vi.doMock("./WorkspaceExportDialog.js", exportFactory);

    await import("./workspace-archive-dialog-loader.js");
    expect(exportFactory).not.toHaveBeenCalled();

    const { loadWorkspaceArchiveDialog } = await loadLoader();
    await expect(loadWorkspaceArchiveDialog("export")).resolves.toBe(exportFixture);
    expect(exportFactory).toHaveBeenCalledTimes(1);
  });

  it("selects the named component for each kind", async () => {
    const exportFactory = vi.fn(() => ({ WorkspaceExportDialog: exportFixture }));
    const inspectionFactory = vi.fn(() => ({
      WorkspaceArchiveInspectionDialog: inspectionFixture,
    }));
    vi.doMock("./WorkspaceExportDialog.js", exportFactory);
    vi.doMock("./WorkspaceArchiveInspectionDialog.js", inspectionFactory);

    const { loadWorkspaceArchiveDialog } = await loadLoader();
    await expect(loadWorkspaceArchiveDialog("export")).resolves.toBe(exportFixture);
    await expect(loadWorkspaceArchiveDialog("inspection")).resolves.toBe(inspectionFixture);
    expect(exportFactory).toHaveBeenCalledTimes(1);
    expect(inspectionFactory).toHaveBeenCalledTimes(1);
  });

  it("caches a ready component and coalesces concurrent in-flight loads", async () => {
    const exportFactory = vi.fn(() => ({ WorkspaceExportDialog: exportFixture }));
    vi.doMock("./WorkspaceExportDialog.js", exportFactory);

    const { loadWorkspaceArchiveDialog } = await loadLoader();
    const first = loadWorkspaceArchiveDialog("export");
    const second = loadWorkspaceArchiveDialog("export");
    expect(first).toBe(second);
    await expect(first).resolves.toBe(exportFixture);
    await expect(loadWorkspaceArchiveDialog("export")).resolves.toBe(exportFixture);
    expect(exportFactory).toHaveBeenCalledTimes(1);
  });

  it("keeps separate in-flight promises per kind and loads both", async () => {
    const exportFactory = vi.fn(() => ({ WorkspaceExportDialog: exportFixture }));
    const inspectionFactory = vi.fn(() => ({
      WorkspaceArchiveInspectionDialog: inspectionFixture,
    }));
    vi.doMock("./WorkspaceExportDialog.js", exportFactory);
    vi.doMock("./WorkspaceArchiveInspectionDialog.js", inspectionFactory);

    const { loadWorkspaceArchiveDialog } = await loadLoader();
    const exportPromise = loadWorkspaceArchiveDialog("export");
    const inspectionPromise = loadWorkspaceArchiveDialog("inspection");
    expect(exportPromise).not.toBe(inspectionPromise);
    await expect(exportPromise).resolves.toBe(exportFixture);
    await expect(inspectionPromise).resolves.toBe(inspectionFixture);
    expect(exportFactory).toHaveBeenCalledTimes(1);
    expect(inspectionFactory).toHaveBeenCalledTimes(1);
  });

  it("rejects with reason load and starts a fresh attempt on retry", async () => {
    let accesses = 0;
    const exportModule = {
      get WorkspaceExportDialog() {
        accesses += 1;
        if (accesses === 1) {
          throw new Error("module exploded");
        }
        return exportFixture;
      },
    };
    vi.doMock("./WorkspaceExportDialog.js", () => exportModule);

    const { loadWorkspaceArchiveDialog } = await loadLoader();
    await expect(loadWorkspaceArchiveDialog("export")).rejects.toMatchObject({
      reason: "load",
    });
    await expect(loadWorkspaceArchiveDialog("export")).resolves.toBe(exportFixture);
    expect(accesses).toBe(2);
  });

  it("fails a missing named component with reason load", async () => {
    vi.doMock("./WorkspaceExportDialog.js", () => ({}));
    const { loadWorkspaceArchiveDialog } = await loadLoader();
    await expect(loadWorkspaceArchiveDialog("export")).rejects.toMatchObject({
      reason: "load",
    });
  });

  it("times out after the registry deadline and forgets the attempt", async () => {
    vi.useFakeTimers();
    let resolveModule!: (module: MockModule) => void;
    const pendingModule = new Promise<MockModule>((resolve) => {
      resolveModule = resolve;
    });
    vi.doMock("./WorkspaceExportDialog.js", () => pendingModule);

    const { loadWorkspaceArchiveDialog } = await loadLoader();
    const loading = loadWorkspaceArchiveDialog("export");
    const assertion = expect(loading).rejects.toMatchObject({ reason: "timeout" });
    await vi.advanceTimersByTimeAsync(WORKSPACE_ARCHIVE_DIALOG_LOAD_TIMEOUT_MS + 1);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);

    resolveModule({ WorkspaceExportDialog: exportFixture });
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("repairs a timed-out attempt once the module finishes unless retried", async () => {
    vi.useFakeTimers();
    let resolveModule!: (module: MockModule) => void;
    const pendingModule = new Promise<MockModule>((resolve) => {
      resolveModule = resolve;
    });
    vi.doMock("./WorkspaceExportDialog.js", () => pendingModule);

    const { loadWorkspaceArchiveDialog } = await loadLoader();
    const loading = loadWorkspaceArchiveDialog("export");
    const assertion = expect(loading).rejects.toMatchObject({ reason: "timeout" });
    await vi.advanceTimersByTimeAsync(WORKSPACE_ARCHIVE_DIALOG_LOAD_TIMEOUT_MS + 1);
    await assertion;

    resolveModule({ WorkspaceExportDialog: exportFixture });
    await Promise.resolve();
    await expect(loadWorkspaceArchiveDialog("export")).resolves.toBe(exportFixture);
  });

  it("lets a retry supersede a timed-out attempt and caches only the retried module result", async () => {
    vi.useFakeTimers();
    let readsFirst = true;
    const exportModule = {
      get WorkspaceExportDialog() {
        const component = readsFirst ? staleFixture : retriedFixture;
        readsFirst = false;
        return component;
      },
    };
    let resolveModule!: (module: MockModule) => void;
    const pendingModule = new Promise<MockModule>((resolve) => {
      resolveModule = resolve;
    });
    const moduleFactory = vi.fn(() => pendingModule);
    vi.doMock("./WorkspaceExportDialog.js", moduleFactory);

    const { loadWorkspaceArchiveDialog } = await loadLoader();
    const firstLoad = loadWorkspaceArchiveDialog("export");
    const firstAssertion = expect(firstLoad).rejects.toMatchObject({
      reason: "timeout",
    });
    await vi.advanceTimersByTimeAsync(WORKSPACE_ARCHIVE_DIALOG_LOAD_TIMEOUT_MS + 1);
    await firstAssertion;

    const retriedLoad = loadWorkspaceArchiveDialog("export");
    expect(moduleFactory).toHaveBeenCalledTimes(1);

    resolveModule(exportModule);
    await expect(retriedLoad).resolves.toBe(retriedFixture);
    await expect(loadWorkspaceArchiveDialog("export")).resolves.toBe(retriedFixture);
    expect(moduleFactory).toHaveBeenCalledTimes(1);
  });

  it("surfaces a late module rejection to the superseding retry and keeps the registry fresh", async () => {
    vi.useFakeTimers();
    let rejectModule!: (error: unknown) => void;
    const pendingModule = new Promise<MockModule>((_resolve, reject) => {
      rejectModule = reject;
    });
    const moduleFactory = vi.fn(() => pendingModule);
    vi.doMock("./WorkspaceExportDialog.js", moduleFactory);

    const { loadWorkspaceArchiveDialog } = await loadLoader();
    const firstLoad = loadWorkspaceArchiveDialog("export");
    const firstAssertion = expect(firstLoad).rejects.toMatchObject({
      reason: "timeout",
    });
    await vi.advanceTimersByTimeAsync(WORKSPACE_ARCHIVE_DIALOG_LOAD_TIMEOUT_MS + 1);
    await firstAssertion;

    const retriedLoad = loadWorkspaceArchiveDialog("export");
    expect(moduleFactory).toHaveBeenCalledTimes(1);

    rejectModule(new Error("late module failure"));
    await expect(retriedLoad).rejects.toMatchObject({ reason: "load" });

    const nextModule = deferredModule();
    moduleFactory.mockReturnValue(nextModule.modulePromise);
    const nextLoad = loadWorkspaceArchiveDialog("export");
    expect(moduleFactory).toHaveBeenCalledTimes(2);
    nextModule.resolveModule({ WorkspaceExportDialog: retriedFixture });
    await expect(nextLoad).resolves.toBe(retriedFixture);
  });

  it("maps unknown load errors to a safe bounded reason", async () => {
    vi.doMock("./WorkspaceExportDialog.js", () => {
      throw "not an Error";
    });
    const { loadWorkspaceArchiveDialog, WorkspaceArchiveDialogLoadError } = await loadLoader();
    await expect(loadWorkspaceArchiveDialog("export")).rejects.toBeInstanceOf(
      WorkspaceArchiveDialogLoadError,
    );
    await expect(loadWorkspaceArchiveDialog("export")).rejects.toMatchObject({
      reason: "load",
      message: "The archive dialog could not be loaded.",
    });
  });
});
