CREATE TABLE `export_job_service_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`service` text NOT NULL,
	`attempt` integer NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`bytes` integer,
	`sha256` text,
	`error` text,
	FOREIGN KEY (`job_id`) REFERENCES `export_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "export_job_service_attempts_status_check" CHECK("export_job_service_attempts"."status" in ('running', 'succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `export_job_service_attempt_unique_idx` ON `export_job_service_attempts` (`job_id`,`service`,`attempt`);--> statement-breakpoint
CREATE TABLE `export_job_services` (
	`job_id` text NOT NULL,
	`service` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`bytes` integer,
	`sha256` text,
	`last_error` text,
	`started_at` integer,
	`completed_at` integer,
	PRIMARY KEY(`job_id`, `service`),
	FOREIGN KEY (`job_id`) REFERENCES `export_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "export_job_services_status_check" CHECK("export_job_services"."status" in ('pending', 'running', 'succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE `export_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`expires_at` integer,
	`archive_path` text,
	`archive_bytes` integer,
	`lease_id` text,
	`lease_until` integer,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "export_jobs_status_check" CHECK("export_jobs"."status" in ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled', 'expired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `export_jobs_one_active_owner_idx` ON `export_jobs` (`owner_user_id`) WHERE "export_jobs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX `export_jobs_dispatch_idx` ON `export_jobs` (`status`,`lease_until`,`created_at`);--> statement-breakpoint
CREATE INDEX `export_jobs_expiry_idx` ON `export_jobs` (`expires_at`);