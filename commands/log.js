"use strict";

const { EmbedBuilder, PermissionFlagsBits } = require("discord.js");

async function getOrCreateConfig(LogConfigModel, guildId) {
  let config = await LogConfigModel.findOne({ guildId });
  if (!config) {
    config = await LogConfigModel.create({ guildId });
  }
  return config;
}

function createLogCommand(LogConfigModel) {
  return {
    data: {
      name: "log",
      description: "Manage server logging settings",
      options: [
        {
          name: "set",
          description: "Set the log channel for a category",
          type: 1, // SUB_COMMAND
          options: [
            {
              name: "category",
              description: "The log category to configure",
              type: 3, // STRING
              required: true,
              choices: [
                { name: "Members (Joins/Leaves)", value: "members" },
                { name: "Messages (Edits/Deletes)", value: "messages" },
                { name: "Moderation (Bans/Kicks/Timeouts)", value: "moderation" },
                { name: "Voice (Joins/Leaves/Moves)", value: "voice" },
                { name: "Channels (Creates/Deletes/Updates)", value: "channels" },
                { name: "Boosts (Server Boosts)", value: "boosts" },
              ],
            },
            {
              name: "channel",
              description: "The channel to send logs to",
              type: 7, // CHANNEL
              required: true,
            },
          ],
        },
        {
          name: "remove",
          description: "Remove the log channel for a category",
          type: 1, // SUB_COMMAND
          options: [
            {
              name: "category",
              description: "The log category to remove",
              type: 3, // STRING
              required: true,
              choices: [
                { name: "Members (Joins/Leaves)", value: "members" },
                { name: "Messages (Edits/Deletes)", value: "messages" },
                { name: "Moderation (Bans/Kicks/Timeouts)", value: "moderation" },
                { name: "Voice (Joins/Leaves/Moves)", value: "voice" },
                { name: "Channels (Creates/Deletes/Updates)", value: "channels" },
                { name: "Boosts (Server Boosts)", value: "boosts" },
              ],
            },
          ],
        },
        {
          name: "list",
          description: "List configured log channels and settings",
          type: 1, // SUB_COMMAND
        },
        {
          name: "enable",
          description: "Enable server logging globally",
          type: 1, // SUB_COMMAND
        },
        {
          name: "disable",
          description: "Disable server logging globally",
          type: 1, // SUB_COMMAND
        },
        {
          name: "ignore",
          description: "Ignore or unignore a channel from message logging",
          type: 1, // SUB_COMMAND
          options: [
            {
              name: "channel",
              description: "The channel to ignore/unignore",
              type: 7, // CHANNEL
              required: true,
            },
          ],
        },
        {
          name: "retention",
          description: "Set message cache retention in days",
          type: 1, // SUB_COMMAND
          options: [
            {
              name: "days",
              description: "Number of days (e.g. 1-365)",
              type: 4, // INTEGER
              required: true,
              min_value: 1,
            },
          ],
        },
      ],
    },
    async execute(interaction) {
      if (!interaction.member || !interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({
          content: "❌ You need the **Manage Server** permission to configure server logs.",
          ephemeral: true,
        });
      }

      const subcommand = interaction.options.getSubcommand();

      if (subcommand === "set") {
        const category = interaction.options.getString("category");
        const channel = interaction.options.getChannel("channel");

        if (!channel.isTextBased()) {
          return interaction.reply({
            content: "❌ Please select a text-based channel.",
            ephemeral: true,
          });
        }

        const config = await getOrCreateConfig(LogConfigModel, interaction.guildId);
        if (!config.categories) config.categories = {};
        config.categories[category] = channel.id;
        config.updatedAt = new Date();
        await config.save();

        return interaction.reply({
          content: `✅ Successfully set log category **${category}** to <#${channel.id}>.`,
          ephemeral: true,
        });
      }

      if (subcommand === "remove") {
        const category = interaction.options.getString("category");
        const config = await getOrCreateConfig(LogConfigModel, interaction.guildId);
        if (config.categories) {
          config.categories[category] = null;
        }
        config.updatedAt = new Date();
        await config.save();

        return interaction.reply({
          content: `✅ Successfully removed logging channel for category **${category}**.`,
          ephemeral: true,
        });
      }

      if (subcommand === "list") {
        const config = await getOrCreateConfig(LogConfigModel, interaction.guildId);
        const embed = new EmbedBuilder()
          .setTitle("📋 Server Logs Configuration")
          .setColor(config.enabled ? 0x2ecc71 : 0xe74c3c)
          .addFields(
            { name: "Status", value: config.enabled ? "✅ Enabled" : "❌ Disabled", inline: true },
            { name: "Message Retention", value: `⏳ ${config.retentionDays} Days`, inline: true }
          );

        const cats = config.categories || {};
        const categoriesList = [
          { key: "members", name: "Members (Joins/Leaves)" },
          { key: "messages", name: "Messages (Edits/Deletes)" },
          { key: "moderation", name: "Moderation (Bans/Kicks/Timeouts)" },
          { key: "voice", name: "Voice (Joins/Leaves/Moves)" },
          { key: "channels", name: "Channels (Creates/Deletes/Updates)" },
          { key: "boosts", name: "Boosts (Server Boosts)" },
        ];

        const categoriesText = categoriesList
          .map((c) => `• **${c.name}**: ${cats[c.key] ? `<#${cats[c.key]}>` : "*Not set*"}`)
          .join("\n");
        embed.addFields({ name: "Logged Categories", value: categoriesText });

        const ignoredText = config.ignoredChannels && config.ignoredChannels.length > 0
          ? config.ignoredChannels.map((id) => `<#${id}>`).join(", ")
          : "*None*";
        embed.addFields({ name: "Ignored Channels", value: ignoredText });

        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      if (subcommand === "enable") {
        const config = await getOrCreateConfig(LogConfigModel, interaction.guildId);
        config.enabled = true;
        config.updatedAt = new Date();
        await config.save();

        return interaction.reply({
          content: "✅ Server logging has been enabled globally.",
          ephemeral: true,
        });
      }

      if (subcommand === "disable") {
        const config = await getOrCreateConfig(LogConfigModel, interaction.guildId);
        config.enabled = false;
        config.updatedAt = new Date();
        await config.save();

        return interaction.reply({
          content: "❌ Server logging has been disabled globally.",
          ephemeral: true,
        });
      }

      if (subcommand === "ignore") {
        const channel = interaction.options.getChannel("channel");
        const config = await getOrCreateConfig(LogConfigModel, interaction.guildId);
        
        if (!config.ignoredChannels) {
          config.ignoredChannels = [];
        }
        
        const index = config.ignoredChannels.indexOf(channel.id);
        let msg = "";
        if (index > -1) {
          config.ignoredChannels.splice(index, 1);
          msg = `✅ Channel <#${channel.id}> is no longer ignored for message logs.`;
        } else {
          config.ignoredChannels.push(channel.id);
          msg = `✅ Channel <#${channel.id}> is now ignored for message logs.`;
        }
        config.updatedAt = new Date();
        await config.save();

        return interaction.reply({
          content: msg,
          ephemeral: true,
        });
      }

      if (subcommand === "retention") {
        const days = interaction.options.getInteger("days");
        const config = await getOrCreateConfig(LogConfigModel, interaction.guildId);
        config.retentionDays = days;
        config.updatedAt = new Date();
        await config.save();

        return interaction.reply({
          content: `✅ Message cache retention period set to **${days} days**.`,
          ephemeral: true,
        });
      }
    },
  };
}

module.exports = { createLogCommand };
