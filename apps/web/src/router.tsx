import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { useThreads, useWorkspaces } from "./lib/api.js";
import { SettingsSurface } from "./settings/SettingsSurface.js";
import { AppShell } from "./shell/AppShell.js";
import { EmptyWorkspace } from "./shell/EmptyWorkspace.js";
import { SURFACE_ROUTES } from "./shell/surfaces.js";
import { BoardSurface } from "./surfaces/board/BoardSurface.js";
import { ChatSurface } from "./surfaces/chat/ChatSurface.js";
import { EditorSurface } from "./surfaces/editor/EditorSurface.js";
import { MemorySurface } from "./surfaces/memory/MemorySurface.js";

const rootRoute = createRootRoute({ component: Outlet });

/**
 * `/` picks the first workspace and its first thread, then lands on Chat. With
 * a workspace but no thread it falls through to `/w/:workspaceId`, which offers
 * to create one; with no workspace at all it says so instead of spinning.
 */
function IndexRedirect() {
  const workspaces = useWorkspaces();
  const workspaceId = workspaces.data?.[0]?.id;
  const threads = useThreads(workspaceId ?? "");
  const threadId = threads.data?.[0]?.id;
  const navigate = useNavigate();

  useEffect(() => {
    if (!workspaceId) return;
    if (threadId) {
      void navigate({
        to: SURFACE_ROUTES.chat,
        params: { workspaceId, threadId },
        replace: true,
      });
    } else if (!threads.isPending) {
      void navigate({ to: "/w/$workspaceId", params: { workspaceId }, replace: true });
    }
  }, [workspaceId, threadId, threads.isPending, navigate]);

  if (workspaces.isError) {
    return <div className="state">could not reach the Nexestra server on /api</div>;
  }
  if (!workspaces.isPending && !workspaceId) {
    return <EmptyWorkspace workspaceId="" />;
  }
  return <div className="state">connecting to the Nexestra server…</div>;
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: IndexRedirect,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsSurface,
});

/** `/w/:workspaceId` — a workspace with no thread selected (or none at all). */
const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/w/$workspaceId",
  component: function WorkspaceRoute() {
    const { workspaceId } = workspaceRoute.useParams();
    return <EmptyWorkspace workspaceId={workspaceId} />;
  },
});

const threadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/w/$workspaceId/t/$threadId",
  component: Outlet,
});

const chatRoute = createRoute({
  getParentRoute: () => threadRoute,
  path: "chat",
  component: function ChatRoute() {
    const { workspaceId, threadId } = chatRoute.useParams();
    return (
      <AppShell workspaceId={workspaceId} threadId={threadId} surface="chat">
        <ChatSurface workspaceId={workspaceId} threadId={threadId} />
      </AppShell>
    );
  },
});

const boardRoute = createRoute({
  getParentRoute: () => threadRoute,
  path: "board",
  component: function BoardRoute() {
    const { workspaceId, threadId } = boardRoute.useParams();
    return (
      <AppShell workspaceId={workspaceId} threadId={threadId} surface="board">
        <BoardSurface workspaceId={workspaceId} threadId={threadId} />
      </AppShell>
    );
  },
});

const editorRoute = createRoute({
  getParentRoute: () => threadRoute,
  path: "editor",
  component: function EditorRoute() {
    const { workspaceId, threadId } = editorRoute.useParams();
    return (
      <AppShell workspaceId={workspaceId} threadId={threadId} surface="editor">
        <EditorSurface workspaceId={workspaceId} threadId={threadId} />
      </AppShell>
    );
  },
});

const memoryRoute = createRoute({
  getParentRoute: () => threadRoute,
  path: "memory",
  component: function MemoryRoute() {
    const { workspaceId, threadId } = memoryRoute.useParams();
    return (
      <AppShell workspaceId={workspaceId} threadId={threadId} surface="memory">
        <MemorySurface workspaceId={workspaceId} threadId={threadId} />
      </AppShell>
    );
  },
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  settingsRoute,
  workspaceRoute,
  threadRoute.addChildren([chatRoute, boardRoute, editorRoute, memoryRoute]),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: false,
  defaultNotFoundComponent: () => <div className="state">route not found</div>,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
