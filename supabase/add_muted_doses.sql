-- Per-user reminder muting for the Telegram bot's /mute command.
-- Holds the dose indexes (0=בוקר, 1=צהריים, 2=ערב, 3=לילה) the user
-- doesn't want reminders for. Stays muted until toggled off again.
alter table telegram_users
  add column if not exists muted_doses int[] not null default '{}';
