// Run with: npm test (or) node test/local-harness.js
// Tests all /log commands and gateway events.

const assert = require("node:assert");
const { load } = require("../index.js");
const { createMockCtx } = require("./mock-ctx");

function fakeInteraction(options = {}) {
  const replies = [];
  return {
    guildId: options._guildId ?? "test-guild",
    user: options._user ?? { id: "test-user", tag: "test-user#1234" },
    member: options._member ?? {
      permissions: {
        has: () => true, // Authorized
      },
    },
    options: {
      getString: (name) => options[name] ?? null,
      getInteger: (name) => options[name] ?? null,
      getUser: (name) => options[name] ?? null,
      getChannel: (name) => options[name] ?? null,
      getSubcommand: () => options._subcommand ?? null,
    },
    reply: async (payload) => {
      replies.push(payload);
      return payload;
    },
    replies,
  };
}

async function main() {
  const { ctx, registeredCommands, emitEvent, models } = createMockCtx({
    pluginName: "adb-plugin-server-logs",
  });

  // Mock channels.fetch to track logged embeds
  const loggedEmbeds = [];
  ctx.client.channels.fetch = async (id) => {
    return {
      id,
      isTextBased: () => true,
      send: async (payload) => {
        loggedEmbeds.push({ channelId: id, payload });
        return payload;
      },
    };
  };

  // Load the plugin
  await load(ctx);

  // 1. Verify /log command is registered
  assert.ok(registeredCommands.has("log"), "expected /log command to be registered");
  const logCmd = registeredCommands.get("log");

  const LogConfig = models.get("plugin_adb-plugin-server-logs_LogConfig");
  const MessageCache = models.get("plugin_adb-plugin-server-logs_MessageCache");

  assert.ok(LogConfig, "LogConfig model should be registered");
  assert.ok(MessageCache, "MessageCache model should be registered");

  // Helper to execute slash command subcommand
  async function execSubcommand(opts) {
    const interaction = fakeInteraction(opts);
    await logCmd.execute(interaction);
    return interaction;
  }

  console.log("Testing /log enable...");
  let int = await execSubcommand({ _subcommand: "enable" });
  assert.match(int.replies[0].content, /enabled globally/i);
  let config = await LogConfig.findOne({ guildId: "test-guild" });
  assert.strictEqual(config.enabled, true);

  console.log("Testing /log disable...");
  int = await execSubcommand({ _subcommand: "disable" });
  assert.match(int.replies[0].content, /disabled globally/i);
  config = await LogConfig.findOne({ guildId: "test-guild" });
  assert.strictEqual(config.enabled, false);

  // Enable it back
  await execSubcommand({ _subcommand: "enable" });

  console.log("Testing /log set [category] [#channel]...");
  const mockChannel = { id: "log-channel-123", isTextBased: () => true };
  int = await execSubcommand({
    _subcommand: "set",
    category: "members",
    channel: mockChannel,
  });
  assert.match(int.replies[0].content, /successfully set log category/i);
  config = await LogConfig.findOne({ guildId: "test-guild" });
  assert.strictEqual(config.categories.members, "log-channel-123");

  console.log("Testing /log set [category] [#channel] (invalid channel)...");
  const badChannel = { id: "bad-channel", isTextBased: () => false };
  int = await execSubcommand({
    _subcommand: "set",
    category: "members",
    channel: badChannel,
  });
  assert.match(int.replies[0].content, /please select a text-based channel/i);

  console.log("Testing /log remove [category]...");
  int = await execSubcommand({
    _subcommand: "remove",
    category: "members",
  });
  assert.match(int.replies[0].content, /successfully removed/i);
  config = await LogConfig.findOne({ guildId: "test-guild" });
  assert.strictEqual(config.categories.members, null);

  // Setup channels for events testing
  await execSubcommand({
    _subcommand: "set",
    category: "members",
    channel: { id: "members-log", isTextBased: () => true },
  });
  await execSubcommand({
    _subcommand: "set",
    category: "messages",
    channel: { id: "messages-log", isTextBased: () => true },
  });
  await execSubcommand({
    _subcommand: "set",
    category: "moderation",
    channel: { id: "moderation-log", isTextBased: () => true },
  });

  console.log("Testing /log ignore [#channel]...");
  int = await execSubcommand({
    _subcommand: "ignore",
    channel: { id: "ignored-channel" },
  });
  assert.match(int.replies[0].content, /ignored/i);
  config = await LogConfig.findOne({ guildId: "test-guild" });
  assert.ok(config.ignoredChannels.includes("ignored-channel"));

  // Toggle ignore back off
  int = await execSubcommand({
    _subcommand: "ignore",
    channel: { id: "ignored-channel" },
  });
  assert.match(int.replies[0].content, /no longer ignored/i);
  config = await LogConfig.findOne({ guildId: "test-guild" });
  assert.ok(!config.ignoredChannels.includes("ignored-channel"));

  console.log("Testing /log retention [days]...");
  int = await execSubcommand({
    _subcommand: "retention",
    days: 45,
  });
  assert.match(int.replies[0].content, /retention period set to.*45 days/i);
  config = await LogConfig.findOne({ guildId: "test-guild" });
  assert.strictEqual(config.retentionDays, 45);

  console.log("Testing /log list...");
  int = await execSubcommand({ _subcommand: "list" });
  assert.ok(int.replies[0].embeds.length > 0);
  const listEmbed = int.replies[0].embeds[0];
  assert.strictEqual(listEmbed.data.title, "📋 Server Logs Configuration");

  // --- Events Testing ---

  console.log("Testing Event: guildMemberAdd...");
  loggedEmbeds.length = 0;
  const mockMember = {
    guild: { id: "test-guild", memberCount: 42 },
    user: { id: "member-1", tag: "newbie#0001", createdTimestamp: Date.now() - 100000, displayAvatarURL: () => "https://example.com/avatar.png" },
  };
  await emitEvent("guildMemberAdd", mockMember);
  assert.strictEqual(loggedEmbeds.length, 1);
  assert.strictEqual(loggedEmbeds[0].channelId, "members-log");
  assert.strictEqual(loggedEmbeds[0].payload.embeds[0].data.title, "📥 Member Joined");

  console.log("Testing Event: guildMemberRemove (Leave)...");
  loggedEmbeds.length = 0;
  mockMember.roles = {
    cache: {
      filter: () => ({
        map: () => ({
          join: () => "Role1, Role2",
        }),
      }),
    },
  };
  // Mock fetchAuditLogs returning empty
  mockMember.guild.fetchAuditLogs = async () => ({ entries: { first: () => null } });
  await emitEvent("guildMemberRemove", mockMember);
  assert.strictEqual(loggedEmbeds.length, 1);
  assert.strictEqual(loggedEmbeds[0].channelId, "members-log");
  assert.strictEqual(loggedEmbeds[0].payload.embeds[0].data.title, "📤 Member Left");

  console.log("Testing Event: Message Edit and Delete (Message Cache)...");
  loggedEmbeds.length = 0;
  const mockMessage = {
    id: "msg-123",
    guild: { id: "test-guild" },
    channel: { id: "general-channel" },
    author: { id: "author-1", tag: "author#1111", bot: false },
    content: "Original Message Text",
    attachments: { values: () => [] },
  };

  // 1. Message Create should cache it
  await emitEvent("messageCreate", mockMessage);
  let cachedMsg = await MessageCache.findOne({ messageId: "msg-123" });
  assert.ok(cachedMsg, "Message should be cached in DB");
  assert.strictEqual(cachedMsg.content, "Original Message Text");

  // 2. Message Edit should log old vs new and update cache
  const editedMessage = {
    ...mockMessage,
    content: "Edited Message Text",
    url: "https://discord.com/channels/test-guild/general-channel/msg-123",
  };
  await emitEvent("messageUpdate", mockMessage, editedMessage);
  assert.strictEqual(loggedEmbeds.length, 1);
  assert.strictEqual(loggedEmbeds[0].channelId, "messages-log");
  assert.strictEqual(loggedEmbeds[0].payload.embeds[0].data.title, "✏️ Message Edited");
  
  cachedMsg = await MessageCache.findOne({ messageId: "msg-123" });
  assert.strictEqual(cachedMsg.content, "Edited Message Text");

  // 3. Message Delete should log and clear cache
  loggedEmbeds.length = 0;
  await emitEvent("messageDelete", editedMessage);
  assert.strictEqual(loggedEmbeds.length, 1);
  assert.strictEqual(loggedEmbeds[0].channelId, "messages-log");
  assert.strictEqual(loggedEmbeds[0].payload.embeds[0].data.title, "🗑️ Message Deleted");
  
  cachedMsg = await MessageCache.findOne({ messageId: "msg-123" });
  assert.strictEqual(cachedMsg, null, "Message cache should be cleared on delete");

  console.log("OK: all server-logs checks passed");
}

main().catch((error) => {
  console.error("Local harness failed:", error);
  process.exit(1);
});
process.exit(0);
