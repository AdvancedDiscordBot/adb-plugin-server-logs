"use strict";

const { Schema } = require("mongoose");

const LogConfigSchema = new Schema({
  guildId: { type: String, required: true, unique: true, index: true },
  enabled: { type: Boolean, default: true },
  categories: {
    members: { type: String, default: null },
    messages: { type: String, default: null },
    moderation: { type: String, default: null },
    voice: { type: String, default: null },
    channels: { type: String, default: null },
    boosts: { type: String, default: null },
  },
  ignoredChannels: { type: [String], default: [] },
  retentionDays: { type: Number, default: 30 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = LogConfigSchema;
