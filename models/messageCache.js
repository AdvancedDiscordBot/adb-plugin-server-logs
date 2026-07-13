"use strict";

const { Schema } = require("mongoose");

const MessageCacheSchema = new Schema({
  messageId: { type: String, required: true, index: true },
  guildId: { type: String, required: true, index: true },
  channelId: { type: String, required: true },
  authorId: { type: String, required: true },
  authorTag: { type: String, required: true },
  content: { type: String, default: "" },
  attachments: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now, index: true },
});

module.exports = MessageCacheSchema;
