ALTER TABLE `model_aliases` ADD `max_attempts` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `model_aliases` ADD `retry_delay_seconds` integer DEFAULT 0 NOT NULL;