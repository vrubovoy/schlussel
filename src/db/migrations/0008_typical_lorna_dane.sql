CREATE TABLE `export_job_events` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`event_type` text NOT NULL,
	`created_at` integer NOT NULL,
	`metadata` text,
	FOREIGN KEY (`job_id`) REFERENCES `export_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "export_job_events_type_check" CHECK("export_job_events"."event_type" in ('created', 'create_reused', 'retried', 'cancelled', 'downloaded'))
);
--> statement-breakpoint
CREATE INDEX `export_job_events_job_idx` ON `export_job_events` (`job_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `export_job_services` ADD `snapshot_path` text;--> statement-breakpoint
ALTER TABLE `export_jobs` ADD `last_error` text;