CREATE TABLE `master_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`workspaceId` text NOT NULL,
	`threadId` text NOT NULL,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`createdAt` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `master_messages_thread_idx` ON `master_messages` (`threadId`,`seq`);--> statement-breakpoint
CREATE TABLE `master_state` (
	`threadId` text PRIMARY KEY NOT NULL,
	`workspaceId` text NOT NULL,
	`state` text NOT NULL,
	`updatedAt` text NOT NULL
);
