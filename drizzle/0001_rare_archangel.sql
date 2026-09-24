CREATE TABLE `pageviews` (
	`id` varchar(36) NOT NULL,
	`path` varchar(500) NOT NULL,
	`post_id` varchar(36),
	`referrer_host` varchar(255),
	`visitor_hash` char(64) NOT NULL,
	`device` varchar(16) NOT NULL,
	`created_at` timestamp NOT NULL,
	CONSTRAINT `pageviews_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `pageviews` ADD CONSTRAINT `pageviews_post_id_posts_id_fk` FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `pageviews_created_at_idx` ON `pageviews` (`created_at`);--> statement-breakpoint
CREATE INDEX `pageviews_post_id_idx` ON `pageviews` (`post_id`);--> statement-breakpoint
-- Hand-appended (not generated): grant the new `view_analytics` permission to the existing system admin/editor roles. Fresh installs get it from SYSTEM_ROLES in lib/install-ops.ts; the NOT JSON_CONTAINS guard keeps this idempotent. Re-running `db:generate` will not touch this already-generated file.
UPDATE `roles` SET `permissions` = JSON_ARRAY_APPEND(`permissions`, '$', 'view_analytics') WHERE `slug` IN ('admin','editor') AND `system` = 1 AND NOT JSON_CONTAINS(`permissions`, '"view_analytics"');
