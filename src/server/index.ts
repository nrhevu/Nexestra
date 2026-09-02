import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { FileStore } from "./store.js";

const store = await FileStore.open();
const app = createApp({
  store,
  productionAssets: process.env.NEXESTRA_DEV !== "1",
});
const port = Number.parseInt(process.env.NEXESTRA_PORT ?? "4242", 10);

serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
  process.stdout.write(
    `${[
      `Nexestra → http://127.0.0.1:${info.port}`,
      `Workspace → ${store.workspacePath}`,
      `Data → ${store.root}`,
    ].join("\n")}\n`,
  );
});
