CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`workspaceId` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`harness` text NOT NULL,
	`providerId` text,
	`model` text,
	`enabled` integer DEFAULT true NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agents_workspace_idx` ON `agents` (`workspaceId`,`createdAt`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `agentId` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `agentId` text;