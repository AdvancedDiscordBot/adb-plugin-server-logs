# Server Logs Plugin

A comprehensive logging system for tracking server activity and administration events. Keep your server secure and transparent with beautiful, color-coded embed logs.

## Log Categories & Events

- **Joins & Leaves** (Category: `members`): Log new members joining the server (with account age details) and leaving the server (listing the roles they held).
- **Message Updates** (Category: `messages`): Track message deletions, edits (showing full before/after content diffs), and bulk message deletions. Supports a MongoDB fallback cache to log uncached messages.
- **Moderation Actions** (Category: `moderation`): Log bans, unbans, kicks, and timeouts. It fetches the moderator and reason directly from the server's audit logs.
- **Voice Events** (Category: `voice`): Log voice channel joins, leaves, and moves between channels.
- **Channel Updates** (Category: `channels`): Keep track of channel creations, deletions, and configuration updates (name, topic, NSFW state, and category parent).
- **Server Boosts** (Category: `boosts`): Celebrate server boosters when they start/stop boosting and log boost tier/count upgrades.

## Slash Commands

Requires the **Manage Server** permission to configure.

- `/log set [category] [#channel]` — Route a log category to a text channel.
- `/log remove [category]` — Disable routing for a category.
- `/log list` — Display the status of all categories and settings.
- `/log enable` / `/log disable` — Toggle server logging globally.
- `/log ignore [#channel]` — Exclude a channel from message edit/delete tracking.
- `/log retention [days]` — Configure how long message cache documents are retained.
