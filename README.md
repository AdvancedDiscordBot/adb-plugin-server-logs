# adb-plugin-server-logs

Comprehensive, high-performance server logging plugin for [Advanced Discord Bot](https://github.com/AdvancedDiscordBot/Advanced-Discord-Bot) (ADB). 

Logs server activity to designated channels using clean, color-coded embeds. Tracks members, messages, moderation actions, voice state changes, channel events, and server boosts.

## Features

- **Detailed Event Tracking**:
  - **Members**: User joins, leaves, and roles held upon leaving.
  - **Messages**: Message edits (showing old vs. new content), message deletions, and bulk deletes. Uses a MongoDB message cache fallback to log message deletions/edits even if the messages aren't in the Discord.js client memory.
  - **Moderation**: Kicks, bans, unbans, and timeouts (or timeout removals) with reasons and executing moderator fetched directly from audit logs.
  - **Voice**: Voice channel joins, leaves, and moves.
  - **Channels**: Channel creations, deletions, and name/topic/NSFW/parent updates.
  - **Server Boosts**: Start/stop boosting events, and guild boost count/tier updates.
- **Ignored Channels**: Toggle channels to exclude from message logging.
- **Cache Retention**: Custom retention duration (in days) for cached message documents to optimize database storage. Automatic hourly pruning cleans up old logs.

## Commands

All configuration commands require the **Manage Server** (`ManageGuild`) permission.

- `/log set [category] [#channel]`  
  Set the target log channel for a specific event category.
- `/log remove [category]`  
  Disable logging for a specific category.
- `/log list`  
  List all configured channels, global status, ignore list, and retention settings.
- `/log enable`  
  Enable logging globally for the guild.
- `/log disable`  
  Disable logging globally for the guild (preserves channel configuration).
- `/log ignore [#channel]`  
  Toggle ignoring a channel from message edit/delete logs.
- `/log retention [days]`  
  Set how many days deleted/edited message content should be kept in the database cache (default: `30` days).

## Log Categories

1. `members` (Member Joins/Leaves)
2. `messages` (Message Edits/Deletes)
3. `moderation` (Bans/Kicks/Timeouts)
4. `voice` (Voice Joins/Leaves/Moves)
5. `channels` (Creates/Deletes/Updates)
6. `boosts` (Server Boosts/Tier Upgrades)

## MongoDB Schemas

The plugin defines two MongoDB collections per server:

### LogConfig (`plugin_adb-plugin-server-logs_logconfig`)
Stores the logging channel configuration, global enable toggle, ignored channel IDs list, and retention setting per guild.

### MessageCache (`plugin_adb-plugin-server-logs_messagecache`)
Caches text and attachment URLs of active messages to provide full edit/delete diffs. Documents are automatically pruned hourly based on each guild's retention setting.

## Local Testing

Run unit tests offline:

```bash
npm install
npm test
```

## License

GNU Affero General Public License v3.0. See the `LICENSE` file for details.
