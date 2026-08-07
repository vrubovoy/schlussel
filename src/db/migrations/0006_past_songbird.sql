CREATE TABLE `notification_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`user_id` text NOT NULL,
	`payload` text NOT NULL,
	`correlation_id` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`lease_id` text,
	`lease_until` integer,
	`delivered_at` integer,
	`last_error` text,
	CONSTRAINT "notification_outbox_state_check" CHECK("notification_outbox"."state" in ('pending', 'inflight', 'delivered', 'permanent'))
);
--> statement-breakpoint
CREATE INDEX `notification_outbox_dispatch_idx` ON `notification_outbox` (`state`,`next_attempt_at`,`lease_until`,`created_at`);