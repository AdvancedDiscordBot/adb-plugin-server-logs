"use strict";

const cron = require("node-cron");
const { EmbedBuilder, AuditLogEvent } = require("discord.js");

const { createLogCommand } = require("./commands/log");
const logConfigSchema = require("./models/logConfig");
const messageCacheSchema = require("./models/messageCache");

async function sendLog(ctx, LogConfigModel, guildId, category, embed) {
  try {
    const config = await LogConfigModel.findOne({ guildId });
    if (!config || !config.enabled) return;

    const channelId = config.categories && config.categories[category];
    if (!channelId) return;

    const channel = await ctx.client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;

    await channel.send({ embeds: [embed] }).catch(() => {});
  } catch (err) {
    ctx.logger.error(`Error sending log for category ${category} in guild ${guildId}:`, err);
  }
}

async function pruneMessageCaches(ctx, LogConfigModel, MessageCacheModel) {
  try {
    const configs = await LogConfigModel.find({});
    for (const config of configs) {
      const cutoff = new Date(Date.now() - config.retentionDays * 24 * 60 * 60 * 1000);
      const result = await MessageCacheModel.deleteMany({
        guildId: config.guildId,
        createdAt: { $lt: cutoff },
      });
      if (result.deletedCount > 0) {
        ctx.logger.info(`Pruned ${result.deletedCount} cached messages for guild ${config.guildId}`);
      }
    }
  } catch (err) {
    ctx.logger.error("Failed to prune message caches:", err);
  }
}

async function load(ctx) {
  const LogConfigModel = ctx.defineModel("LogConfig", logConfigSchema);
  const MessageCacheModel = ctx.defineModel("MessageCache", messageCacheSchema);

  // Register command
  ctx.registerCommand(createLogCommand(LogConfigModel));

  // Schedule pruning hourly
  const task = cron.schedule("0 * * * *", async () => {
    await pruneMessageCaches(ctx, LogConfigModel, MessageCacheModel);
  });

  ctx.hooks.on("onPluginUnload", async ({ pluginName }) => {
    if (pluginName === "adb-plugin-server-logs") {
      task.stop();
    }
  });

  // --- Gateway Event Listeners ---

  // 1. Member Joins
  ctx.registerEvent("guildMemberAdd", async (member) => {
    const embed = new EmbedBuilder()
      .setTitle("📥 Member Joined")
      .setColor(0x2ecc71)
      .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
      .setDescription(`**${member.user.tag}** (${member.user}) has joined the server.`)
      .addFields(
        { name: "Account Age", value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
        { name: "Member Count", value: `${member.guild.memberCount}`, inline: true }
      )
      .setTimestamp();

    await sendLog(ctx, LogConfigModel, member.guild.id, "members", embed);
  });

  // 2. Member Leaves & Kicks
  ctx.registerEvent("guildMemberRemove", async (member) => {
    // Check if member was banned. If so, let guildBanAdd handle it.
    const banLogs = await member.guild.fetchAuditLogs({
      limit: 1,
      type: AuditLogEvent.MemberBanAdd,
    }).catch(() => null);

    const banLog = banLogs?.entries.first();
    const isBan = banLog && banLog.targetId === member.id && (Date.now() - banLog.createdTimestamp) < 10000;
    if (isBan) return;

    // Check if member was kicked.
    const kickLogs = await member.guild.fetchAuditLogs({
      limit: 1,
      type: AuditLogEvent.MemberKick,
    }).catch(() => null);

    const kickLog = kickLogs?.entries.first();
    const isKick = kickLog && kickLog.targetId === member.id && (Date.now() - kickLog.createdTimestamp) < 10000;

    if (isKick) {
      const executor = kickLog.executor;
      const reason = kickLog.reason || "No reason provided";
      const embed = new EmbedBuilder()
        .setTitle("👢 Member Kicked")
        .setColor(0xe67e22)
        .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
        .setDescription(`**${member.user.tag}** was kicked from the server.`)
        .addFields(
          { name: "Kicked By", value: executor ? `${executor.tag} (${executor})` : "Unknown", inline: true },
          { name: "Reason", value: reason }
        )
        .setTimestamp();

      await sendLog(ctx, LogConfigModel, member.guild.id, "moderation", embed);
    } else {
      const rolesJoined = member.roles.cache
        .filter((r) => r.id !== member.guild.id)
        .map((r) => r.toString())
        .join(", ") || "*None*";

      const embed = new EmbedBuilder()
        .setTitle("📤 Member Left")
        .setColor(0xe74c3c)
        .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
        .setDescription(`**${member.user.tag}** (${member.user}) has left the server.`)
        .addFields(
          { name: "Joined At", value: member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : "Unknown", inline: true },
          { name: "Member Count", value: `${member.guild.memberCount}`, inline: true },
          { name: "Roles Held", value: rolesJoined.length > 1024 ? rolesJoined.slice(0, 1021) + "..." : rolesJoined }
        )
        .setTimestamp();

      await sendLog(ctx, LogConfigModel, member.guild.id, "members", embed);
    }
  });

  // 3. Moderation: Bans
  ctx.registerEvent("guildBanAdd", async (ban) => {
    const auditLogs = await ban.guild.fetchAuditLogs({
      limit: 1,
      type: AuditLogEvent.MemberBanAdd,
    }).catch(() => null);

    const banLog = auditLogs?.entries.first();
    const executor = banLog ? banLog.executor : null;
    const reason = ban.reason || banLog?.reason || "No reason provided";

    const embed = new EmbedBuilder()
      .setTitle("🔨 Member Banned")
      .setColor(0xe74c3c)
      .setDescription(`**${ban.user.tag}** (${ban.user.id}) was banned from the server.`)
      .addFields(
        { name: "Banned By", value: executor ? `${executor.tag} (${executor})` : "Unknown", inline: true },
        { name: "Reason", value: reason }
      )
      .setTimestamp();

    await sendLog(ctx, LogConfigModel, ban.guild.id, "moderation", embed);
  });

  // 4. Moderation: Unbans
  ctx.registerEvent("guildBanRemove", async (ban) => {
    const auditLogs = await ban.guild.fetchAuditLogs({
      limit: 1,
      type: AuditLogEvent.MemberBanRemove,
    }).catch(() => null);

    const unbanLog = auditLogs?.entries.first();
    const executor = unbanLog ? unbanLog.executor : null;
    const reason = unbanLog?.reason || "No reason provided";

    const embed = new EmbedBuilder()
      .setTitle("🔓 Member Unbanned")
      .setColor(0x2ecc71)
      .setDescription(`**${ban.user.tag}** (${ban.user.id}) was unbanned.`)
      .addFields(
        { name: "Unbanned By", value: executor ? `${executor.tag} (${executor})` : "Unknown", inline: true },
        { name: "Reason", value: reason }
      )
      .setTimestamp();

    await sendLog(ctx, LogConfigModel, ban.guild.id, "moderation", embed);
  });

  // 5. Moderation (Timeouts), Server Boosts & Role Updates (guildMemberUpdate)
  ctx.registerEvent("guildMemberUpdate", async (oldMember, newMember) => {
    // Timeout detection
    const oldTimeout = oldMember.communicationDisabledUntilTimestamp;
    const newTimeout = newMember.communicationDisabledUntilTimestamp;

    if (oldTimeout !== newTimeout) {
      if (newTimeout && newTimeout > Date.now()) {
        const auditLogs = await newMember.guild.fetchAuditLogs({
          limit: 1,
          type: AuditLogEvent.MemberUpdate,
        }).catch(() => null);

        const timeoutLog = auditLogs?.entries.first();
        const executor = timeoutLog ? timeoutLog.executor : null;
        const reason = timeoutLog?.reason || "No reason provided";

        const embed = new EmbedBuilder()
          .setTitle("🔇 Member Timed Out")
          .setColor(0xf39c12)
          .setDescription(`**${newMember.user.tag}** has been timed out.`)
          .addFields(
            { name: "Until", value: `<t:${Math.floor(newTimeout / 1000)}:F> (<t:${Math.floor(newTimeout / 1000)}:R>)`, inline: true },
            { name: "Timed Out By", value: executor ? `${executor.tag} (${executor})` : "Unknown", inline: true },
            { name: "Reason", value: reason }
          )
          .setTimestamp();

        await sendLog(ctx, LogConfigModel, newMember.guild.id, "moderation", embed);
      } else if (!newTimeout && oldTimeout) {
        const auditLogs = await newMember.guild.fetchAuditLogs({
          limit: 1,
          type: AuditLogEvent.MemberUpdate,
        }).catch(() => null);

        const untimeoutLog = auditLogs?.entries.first();
        const executor = untimeoutLog ? untimeoutLog.executor : null;
        const reason = untimeoutLog?.reason || "No reason provided";

        const embed = new EmbedBuilder()
          .setTitle("🔊 Member Timeout Removed")
          .setColor(0x3498db)
          .setDescription(`**${newMember.user.tag}**'s timeout was removed.`)
          .addFields(
            { name: "Removed By", value: executor ? `${executor.tag} (${executor})` : "Unknown", inline: true },
            { name: "Reason", value: reason }
          )
          .setTimestamp();

        await sendLog(ctx, LogConfigModel, newMember.guild.id, "moderation", embed);
      }
    }

    // Boost detection
    const oldBoost = oldMember.premiumSinceTimestamp;
    const newBoost = newMember.premiumSinceTimestamp;

    if (oldBoost !== newBoost) {
      if (!oldBoost && newBoost) {
        const embed = new EmbedBuilder()
          .setTitle("✨ Server Boosted!")
          .setColor(0xf47fff)
          .setThumbnail(newMember.user.displayAvatarURL({ dynamic: true }))
          .setDescription(`**${newMember.user.tag}** (${newMember}) just boosted the server! 🚀`)
          .setTimestamp();

        await sendLog(ctx, LogConfigModel, newMember.guild.id, "boosts", embed);
      } else if (oldBoost && !newBoost) {
        const embed = new EmbedBuilder()
          .setTitle("📉 Server Boost Removed")
          .setColor(0x95a5a6)
          .setThumbnail(newMember.user.displayAvatarURL({ dynamic: true }))
          .setDescription(`**${newMember.user.tag}** is no longer boosting the server.`)
          .setTimestamp();

        await sendLog(ctx, LogConfigModel, newMember.guild.id, "boosts", embed);
      }
    }

    // Role changes detection
    const oldRoles = oldMember.roles?.cache;
    const newRoles = newMember.roles?.cache;

    if (oldRoles && newRoles && oldRoles.size !== newRoles.size) {
      const addedRoles = newRoles.filter((r) => !oldRoles.has(r.id));
      const removedRoles = oldRoles.filter((r) => !newRoles.has(r.id));

      if (addedRoles.size > 0 || removedRoles.size > 0) {
        const embed = new EmbedBuilder()
          .setTitle("🛡️ Member Roles Updated")
          .setColor(0x3498db)
          .setThumbnail(newMember.user?.displayAvatarURL({ dynamic: true }) || null)
          .setDescription(`Roles updated for **${newMember.user?.tag || "Unknown User"}** (${newMember}).`)
          .setTimestamp();

        if (addedRoles.size > 0) {
          const rolesText = addedRoles.map((r) => r.toString()).join(", ");
          embed.addFields({
            name: `🟢 Role(s) Added [${addedRoles.size}]`,
            value: rolesText.length > 1024 ? rolesText.slice(0, 1021) + "..." : rolesText,
          });
        }

        if (removedRoles.size > 0) {
          const rolesText = removedRoles.map((r) => r.toString()).join(", ");
          embed.addFields({
            name: `🔴 Role(s) Removed [${removedRoles.size}]`,
            value: rolesText.length > 1024 ? rolesText.slice(0, 1021) + "..." : rolesText,
          });
        }

        await sendLog(ctx, LogConfigModel, newMember.guild.id, "members", embed);
      }
    }
  });

  // 6. Server Boost Tier/Count Changes (guildUpdate)
  ctx.registerEvent("guildUpdate", async (oldGuild, newGuild) => {
    const oldTier = oldGuild.premiumTier;
    const newTier = newGuild.premiumTier;
    const oldBoosts = oldGuild.premiumSubscriptionCount;
    const newBoosts = newGuild.premiumSubscriptionCount;

    if (oldTier !== newTier) {
      const embed = new EmbedBuilder()
        .setTitle("🚀 Server Boost Tier Updated")
        .setColor(0xf47fff)
        .setDescription(`The server has reached **Tier ${newTier}**! (Previous: Tier ${oldTier})`)
        .addFields({ name: "Total Boosts", value: `${newBoosts}`, inline: true })
        .setTimestamp();

      await sendLog(ctx, LogConfigModel, newGuild.id, "boosts", embed);
    } else if (oldBoosts !== newBoosts) {
      const embed = new EmbedBuilder()
        .setTitle("✨ Server Boost Count Updated")
        .setColor(0xf47fff)
        .setDescription(`Total server boosts changed: **${oldBoosts}** ➔ **${newBoosts}**`)
        .setTimestamp();

      await sendLog(ctx, LogConfigModel, newGuild.id, "boosts", embed);
    }
  });

  // 7. Voice events (voiceStateUpdate)
  ctx.registerEvent("voiceStateUpdate", async (oldState, newState) => {
    const guildId = newState.guild.id;
    const member = newState.member;
    if (!member) return;

    const oldChannelId = oldState.channelId;
    const newChannelId = newState.channelId;

    if (oldChannelId !== newChannelId) {
      if (!oldChannelId && newChannelId) {
        const channel = newState.channel;
        const embed = new EmbedBuilder()
          .setTitle("🔊 Voice Channel Join")
          .setColor(0x2ecc71)
          .setDescription(`**${member.user.tag}** (${member}) joined voice channel **${channel.name}** (<#${channel.id}>).`)
          .setTimestamp();

        await sendLog(ctx, LogConfigModel, guildId, "voice", embed);
      } else if (oldChannelId && !newChannelId) {
        const channel = oldState.channel;
        const embed = new EmbedBuilder()
          .setTitle("🔇 Voice Channel Leave")
          .setColor(0xe74c3c)
          .setDescription(`**${member.user.tag}** (${member}) left voice channel **${channel ? channel.name : "Unknown"}** (<#${oldChannelId}>).`)
          .setTimestamp();

        await sendLog(ctx, LogConfigModel, guildId, "voice", embed);
      } else if (oldChannelId && newChannelId) {
        const oldChannel = oldState.channel;
        const newChannel = newState.channel;
        const embed = new EmbedBuilder()
          .setTitle("🔄 Voice Channel Move")
          .setColor(0x3498db)
          .setDescription(`**${member.user.tag}** (${member}) moved voice channels.`)
          .addFields(
            { name: "From", value: oldChannel ? `${oldChannel.name} (<#${oldChannel.id}>)` : `<#${oldChannelId}>`, inline: true },
            { name: "To", value: newChannel ? `${newChannel.name} (<#${newChannel.id}>)` : `<#${newChannelId}>`, inline: true }
          )
          .setTimestamp();

        await sendLog(ctx, LogConfigModel, guildId, "voice", embed);
      }
    }
  });

  // 8. Channel Creation (channelCreate)
  ctx.registerEvent("channelCreate", async (channel) => {
    if (!channel.guild) return;
    const typeNames = {
      0: "Text",
      2: "Voice",
      4: "Category",
      5: "Announcement",
      13: "Stage",
      15: "Forum",
    };
    const typeStr = typeNames[channel.type] || "Unknown";

    const embed = new EmbedBuilder()
      .setTitle("📁 Channel Created")
      .setColor(0x2ecc71)
      .setDescription(`New channel **${channel.name}** has been created.`)
      .addFields(
        { name: "Type", value: typeStr, inline: true },
        { name: "ID", value: channel.id, inline: true }
      )
      .setTimestamp();

    if (channel.parent) {
      embed.addFields({ name: "Category", value: channel.parent.name, inline: true });
    }

    await sendLog(ctx, LogConfigModel, channel.guild.id, "channels", embed);
  });

  // 9. Channel Deletion (channelDelete)
  ctx.registerEvent("channelDelete", async (channel) => {
    if (!channel.guild) return;
    const typeNames = {
      0: "Text",
      2: "Voice",
      4: "Category",
      5: "Announcement",
      13: "Stage",
      15: "Forum",
    };
    const typeStr = typeNames[channel.type] || "Unknown";

    const embed = new EmbedBuilder()
      .setTitle("🗑️ Channel Deleted")
      .setColor(0xe74c3c)
      .setDescription(`Channel **${channel.name}** has been deleted.`)
      .addFields(
        { name: "Type", value: typeStr, inline: true },
        { name: "ID", value: channel.id, inline: true }
      )
      .setTimestamp();

    if (channel.parent) {
      embed.addFields({ name: "Category", value: channel.parent.name, inline: true });
    }

    await sendLog(ctx, LogConfigModel, channel.guild.id, "channels", embed);
  });

  // 10. Channel Updates (channelUpdate)
  ctx.registerEvent("channelUpdate", async (oldChannel, newChannel) => {
    if (!newChannel.guild) return;

    const changes = [];
    if (oldChannel.name !== newChannel.name) {
      changes.push(`• **Name**: \`${oldChannel.name}\` ➔ \`${newChannel.name}\``);
    }
    if (oldChannel.topic !== newChannel.topic) {
      changes.push(`• **Topic**: \n*Old:* ${oldChannel.topic || "*None*"}\n*New:* ${newChannel.topic || "*None*"}`);
    }
    if (oldChannel.nsfw !== newChannel.nsfw) {
      changes.push(`• **NSFW**: \`${oldChannel.nsfw}\` ➔ \`${newChannel.nsfw}\``);
    }
    if (oldChannel.parentId !== newChannel.parentId) {
      const oldParent = oldChannel.parent ? oldChannel.parent.name : "None";
      const newParent = newChannel.parent ? newChannel.parent.name : "None";
      changes.push(`• **Category**: \`${oldParent}\` ➔ \`${newParent}\``);
    }

    if (changes.length === 0) return;

    const embed = new EmbedBuilder()
      .setTitle("✏️ Channel Updated")
      .setColor(0x3498db)
      .setDescription(`Channel **${newChannel.name}** (<#${newChannel.id}>) was updated.\n\n${changes.join("\n")}`)
      .setTimestamp();

    await sendLog(ctx, LogConfigModel, newChannel.guild.id, "channels", embed);
  });

  // 11. Message caching (messageCreate)
  ctx.registerEvent("messageCreate", async (message) => {
    if (!message.guild || message.author.bot) return;

    const config = await LogConfigModel.findOne({ guildId: message.guild.id });
    if (!config || !config.enabled || !config.categories || !config.categories.messages) return;

    if (config.ignoredChannels && config.ignoredChannels.includes(message.channel.id)) return;

    const attachments = Array.from(message.attachments.values()).map((a) => a.url);
    await MessageCacheModel.create({
      messageId: message.id,
      guildId: message.guild.id,
      channelId: message.channel.id,
      authorId: message.author.id,
      authorTag: message.author.tag,
      content: message.content || "",
      attachments,
    }).catch((err) => {
      ctx.logger.error(`Error caching message ${message.id}:`, err);
    });
  });

  // 12. Message Deletes (messageDelete)
  ctx.registerEvent("messageDelete", async (message) => {
    if (!message.guild) return;

    const config = await LogConfigModel.findOne({ guildId: message.guild.id });
    if (!config || !config.enabled || !config.categories || !config.categories.messages) return;

    if (config.ignoredChannels && config.ignoredChannels.includes(message.channel.id)) return;

    let cached = await MessageCacheModel.findOne({ messageId: message.id, guildId: message.guild.id });

    const authorTag = cached ? cached.authorTag : (message.author ? message.author.tag : "Unknown User");
    const authorId = cached ? cached.authorId : (message.author ? message.author.id : null);
    const content = cached ? cached.content : (message.content || "*Content uncached/empty*");
    const attachments = cached ? cached.attachments : Array.from(message.attachments || []).map((a) => a[1].url);

    const embed = new EmbedBuilder()
      .setTitle("🗑️ Message Deleted")
      .setColor(0xe74c3c)
      .setDescription(`A message was deleted in <#${message.channel.id}>.`)
      .addFields(
        { name: "Author", value: authorId ? `<@${authorId}> (${authorTag})` : authorTag, inline: true },
        { name: "Content", value: content.trim() ? content.slice(0, 1024) : "*Empty*" }
      )
      .setTimestamp();

    if (attachments && attachments.length > 0) {
      embed.addFields({ name: "Attachments", value: attachments.join("\n") });
    }

    await sendLog(ctx, LogConfigModel, message.guild.id, "messages", embed);

    if (cached) {
      await MessageCacheModel.deleteOne({ _id: cached._id }).catch(() => {});
    }
  });

  // 13. Message Edits (messageUpdate)
  ctx.registerEvent("messageUpdate", async (oldMessage, newMessage) => {
    if (!newMessage.guild || newMessage.author?.bot) return;

    const config = await LogConfigModel.findOne({ guildId: newMessage.guild.id });
    if (!config || !config.enabled || !config.categories || !config.categories.messages) return;

    if (config.ignoredChannels && config.ignoredChannels.includes(newMessage.channel.id)) return;

    if (oldMessage.content === newMessage.content) return;

    let cached = await MessageCacheModel.findOne({ messageId: newMessage.id, guildId: newMessage.guild.id });
    const oldContent = (oldMessage.content !== null && oldMessage.content !== undefined)
      ? oldMessage.content
      : (cached ? cached.content : null);

    if (oldContent === newMessage.content) return;

    const author = newMessage.author || (cached ? { tag: cached.authorTag, id: cached.authorId } : null);
    const authorTag = author ? author.tag : "Unknown User";
    const authorId = author ? author.id : null;

    const embed = new EmbedBuilder()
      .setTitle("✏️ Message Edited")
      .setColor(0x3498db)
      .setDescription(`A message was edited in <#${newMessage.channel.id}>. [Jump to Message](${newMessage.url})`)
      .addFields(
        { name: "Author", value: authorId ? `<@${authorId}> (${authorTag})` : authorTag, inline: true },
        { name: "Before", value: (oldContent && oldContent.trim()) ? oldContent.slice(0, 1024) : "*Unknown/Empty*" },
        { name: "After", value: (newMessage.content && newMessage.content.trim()) ? newMessage.content.slice(0, 1024) : "*Empty*" }
      )
      .setTimestamp();

    await sendLog(ctx, LogConfigModel, newMessage.guild.id, "messages", embed);

    const attachments = Array.from(newMessage.attachments.values()).map((a) => a.url);
    if (cached) {
      cached.content = newMessage.content || "";
      cached.attachments = attachments;
      await cached.save().catch(() => {});
    } else {
      await MessageCacheModel.create({
        messageId: newMessage.id,
        guildId: newMessage.guild.id,
        channelId: newMessage.channel.id,
        authorId: authorId || "Unknown",
        authorTag,
        content: newMessage.content || "",
        attachments,
      }).catch(() => {});
    }
  });

  // 14. Bulk Message Deletes (messageDeleteBulk)
  ctx.registerEvent("messageDeleteBulk", async (messages) => {
    const firstMsg = messages.first();
    if (!firstMsg || !firstMsg.guild) return;

    const config = await LogConfigModel.findOne({ guildId: firstMsg.guild.id });
    if (!config || !config.enabled || !config.categories || !config.categories.messages) return;

    if (config.ignoredChannels && config.ignoredChannels.includes(firstMsg.channel.id)) return;

    const embed = new EmbedBuilder()
      .setTitle("🗑️ Bulk Messages Deleted")
      .setColor(0x992d22)
      .setDescription(`**${messages.size}** messages were deleted in <#${firstMsg.channel.id}>.`)
      .setTimestamp();

    await sendLog(ctx, LogConfigModel, firstMsg.guild.id, "messages", embed);

    const msgIds = Array.from(messages.keys());
    await MessageCacheModel.deleteMany({ messageId: { $in: msgIds }, guildId: firstMsg.guild.id }).catch(() => {});
  });

  // 15. Role Creation (roleCreate)
  ctx.registerEvent("roleCreate", async (role) => {
    if (!role.guild) return;

    const auditLogs = await role.guild.fetchAuditLogs({
      limit: 1,
      type: AuditLogEvent.RoleCreate,
    }).catch(() => null);

    const logEntry = auditLogs?.entries.first();
    const executor = logEntry ? logEntry.executor : null;

    const embed = new EmbedBuilder()
      .setTitle("🛡️ Role Created")
      .setColor(0x2ecc71)
      .setDescription(`Role **${role.name}** was created.`)
      .addFields(
        { name: "Name", value: role.name, inline: true },
        { name: "ID", value: role.id, inline: true }
      )
      .setTimestamp();

    if (executor) {
      embed.addFields({ name: "Created By", value: `${executor.tag} (${executor})`, inline: true });
    }

    await sendLog(ctx, LogConfigModel, role.guild.id, "moderation", embed);
  });

  // 16. Role Deletion (roleDelete)
  ctx.registerEvent("roleDelete", async (role) => {
    if (!role.guild) return;

    const auditLogs = await role.guild.fetchAuditLogs({
      limit: 1,
      type: AuditLogEvent.RoleDelete,
    }).catch(() => null);

    const logEntry = auditLogs?.entries.first();
    const executor = logEntry ? logEntry.executor : null;

    const embed = new EmbedBuilder()
      .setTitle("🗑️ Role Deleted")
      .setColor(0xe74c3c)
      .setDescription(`Role **${role.name}** was deleted.`)
      .addFields(
        { name: "Name", value: role.name, inline: true },
        { name: "ID", value: role.id, inline: true }
      )
      .setTimestamp();

    if (executor) {
      embed.addFields({ name: "Deleted By", value: `${executor.tag} (${executor})`, inline: true });
    }

    await sendLog(ctx, LogConfigModel, role.guild.id, "moderation", embed);
  });

  // 17. Role Updates (roleUpdate)
  ctx.registerEvent("roleUpdate", async (oldRole, newRole) => {
    if (!newRole.guild) return;

    const changes = [];
    if (oldRole.name !== newRole.name) {
      changes.push(`• **Name**: \`${oldRole.name}\` ➔ \`${newRole.name}\``);
    }
    if (oldRole.color !== newRole.color) {
      changes.push(`• **Color**: \`#${oldRole.color.toString(16).padStart(6, "0")}\` ➔ \`#${newRole.color.toString(16).padStart(6, "0")}\``);
    }
    if (oldRole.hoist !== newRole.hoist) {
      changes.push(`• **Show members separately**: \`${oldRole.hoist}\` ➔ \`${newRole.hoist}\``);
    }
    if (oldRole.mentionable !== newRole.mentionable) {
      changes.push(`• **Mentionable**: \`${oldRole.mentionable}\` ➔ \`${newRole.mentionable}\``);
    }
    if (oldRole.permissions.bitfield !== newRole.permissions.bitfield) {
      changes.push(`• **Permissions Updated**`);
    }

    if (changes.length === 0) return;

    const auditLogs = await newRole.guild.fetchAuditLogs({
      limit: 1,
      type: AuditLogEvent.RoleUpdate,
    }).catch(() => null);

    const logEntry = auditLogs?.entries.first();
    const executor = logEntry ? logEntry.executor : null;

    const embed = new EmbedBuilder()
      .setTitle("✏️ Role Updated")
      .setColor(0x3498db)
      .setDescription(`Role **${newRole.name}** (${newRole}) was updated.\n\n${changes.join("\n")}`)
      .setTimestamp();

    if (executor) {
      embed.addFields({ name: "Updated By", value: `${executor.tag} (${executor})`, inline: true });
    }

    await sendLog(ctx, LogConfigModel, newRole.guild.id, "moderation", embed);
  });

  ctx.logger.info("Server Logs plugin loaded successfully");
}

module.exports = { load };
