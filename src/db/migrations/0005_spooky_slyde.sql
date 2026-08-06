CREATE TABLE `connected_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`external_username` text,
	`connected_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `users` ADD `avatar_data_url` text;--> statement-breakpoint
ALTER TABLE `users` ADD `timezone` text;--> statement-breakpoint
ALTER TABLE `users` ADD `date_format` text;--> statement-breakpoint
ALTER TABLE `users` ADD `week_start` text;--> statement-breakpoint
ALTER TABLE `users` ADD `language` text;--> statement-breakpoint
ALTER TABLE `users` ADD `notify_in_app` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `notify_browser_push` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `notify_telegram` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `session_timeout_minutes` integer;