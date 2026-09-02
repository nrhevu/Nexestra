CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`workspaceId` text NOT NULL,
	`threadId` text NOT NULL,
	`taskId` text,
	`runId` text,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`risk` text DEFAULT 'low' NOT NULL,
	`status` text NOT NULL,
	`requestedAt` text NOT NULL,
	`resolvedAt` text,
	`resolvedBy` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `approvals_workspace_idx` ON `approvals` (`workspaceId`,`status`);--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspaceId` text NOT NULL,
	`threadId` text NOT NULL,
	`taskId` text,
	`runId` text,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`path` text NOT NULL,
	`mimeType` text DEFAULT 'text/plain' NOT NULL,
	`sizeBytes` integer DEFAULT 0 NOT NULL,
	`preview` text DEFAULT '' NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `artifacts_thread_idx` ON `artifacts` (`threadId`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspaceId` text NOT NULL,
	`threadId` text,
	`runId` text,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_thread_seq_idx` ON `events` (`threadId`,`seq`);--> statement-breakpoint
CREATE INDEX `events_workspace_seq_idx` ON `events` (`workspaceId`,`seq`);--> statement-breakpoint
CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`workspaceId` text NOT NULL,
	`threadId` text,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`source` text,
	`tags` text NOT NULL,
	`authoredBy` text DEFAULT 'master' NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `memories_workspace_idx` ON `memories` (`workspaceId`);--> statement-breakpoint
CREATE TABLE `memory_links` (
	`sourceId` text NOT NULL,
	`targetId` text NOT NULL,
	`type` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`workspaceId` text NOT NULL,
	`createdAt` text NOT NULL,
	PRIMARY KEY(`sourceId`, `targetId`, `type`)
);
--> statement-breakpoint
CREATE INDEX `memory_links_target_idx` ON `memory_links` (`targetId`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`workspaceId` text NOT NULL,
	`threadId` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`references` text NOT NULL,
	`toolCalls` text NOT NULL,
	`attachments` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `messages_thread_idx` ON `messages` (`threadId`,`createdAt`);--> statement-breakpoint
CREATE TABLE `plans` (
	`id` text PRIMARY KEY NOT NULL,
	`workspaceId` text NOT NULL,
	`threadId` text NOT NULL,
	`specId` text NOT NULL,
	`version` integer NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`taskIds` text NOT NULL,
	`edges` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `plans_thread_idx` ON `plans` (`threadId`);--> statement-breakpoint
CREATE TABLE `run_events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspaceId` text NOT NULL,
	`threadId` text NOT NULL,
	`runId` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `run_events_run_idx` ON `run_events` (`runId`,`seq`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspaceId` text NOT NULL,
	`threadId` text NOT NULL,
	`taskId` text NOT NULL,
	`kind` text NOT NULL,
	`harness` text NOT NULL,
	`sessionRef` text,
	`worktreePath` text,
	`status` text NOT NULL,
	`exitCode` integer,
	`usage` text NOT NULL,
	`startedAt` text NOT NULL,
	`endedAt` text,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `runs_thread_idx` ON `runs` (`threadId`,`startedAt`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `specs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspaceId` text NOT NULL,
	`threadId` text NOT NULL,
	`version` integer NOT NULL,
	`goal` text NOT NULL,
	`scope` text NOT NULL,
	`constraints` text NOT NULL,
	`expectedOutcome` text DEFAULT '' NOT NULL,
	`acceptanceCriteria` text NOT NULL,
	`openQuestions` text NOT NULL,
	`decisions` text NOT NULL,
	`frozen` integer DEFAULT false NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `specs_thread_idx` ON `specs` (`threadId`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`workspaceId` text NOT NULL,
	`threadId` text NOT NULL,
	`planId` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`dependsOn` text NOT NULL,
	`assignedHarness` text,
	`harnessConfig` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`maxAttempts` integer DEFAULT 3 NOT NULL,
	`acceptanceCriteriaIds` text NOT NULL,
	`costUSD` real DEFAULT 0 NOT NULL,
	`order` integer DEFAULT 0 NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tasks_thread_idx` ON `tasks` (`threadId`,`order`);--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`workspaceId` text NOT NULL,
	`title` text NOT NULL,
	`phase` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`specId` text,
	`planId` text,
	`budgetUSD` real DEFAULT 20 NOT NULL,
	`costUSD` real DEFAULT 0 NOT NULL,
	`lastActivityAt` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `threads_workspace_idx` ON `threads` (`workspaceId`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`rootPath` text NOT NULL,
	`shortLabel` text NOT NULL,
	`defaultBranch` text DEFAULT 'main' NOT NULL,
	`settings` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
