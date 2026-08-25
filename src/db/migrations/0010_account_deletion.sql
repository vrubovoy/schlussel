CREATE TABLE `deletion_job_targets` (
	`job_id` text NOT NULL,
	`service` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`lease_id` text,
	`lease_until` integer,
	`delivered_at` integer,
	`last_error` text,
	PRIMARY KEY(`job_id`, `service`),
	FOREIGN KEY (`job_id`) REFERENCES `deletion_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "deletion_targets_status_check" CHECK("deletion_job_targets"."status" in ('pending', 'inflight', 'delivered', 'permanent'))
);
--> statement-breakpoint
CREATE INDEX `deletion_targets_dispatch_idx` ON `deletion_job_targets` (`status`,`next_attempt_at`,`lease_until`);--> statement-breakpoint
CREATE TABLE `deletion_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`initiated_by` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	CONSTRAINT "deletion_jobs_status_check" CHECK("deletion_jobs"."status" in ('pending', 'running', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `deletion_jobs_status_idx` ON `deletion_jobs` (`status`,`created_at`);