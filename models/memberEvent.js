"use strict";

const { Schema } = require("mongoose");

// Per-user event records backing the platform member page (/me/activity).
// The platform's member-scope query is {guildId, userId}, so both fields are
// required and indexed.
const MemberEventSchema = new Schema({
	guildId: { type: String, required: true, index: true },
	userId: { type: String, required: true, index: true },
	category: { type: String, required: true },
	description: { type: String, default: "" },
	createdAt: { type: Date, default: Date.now },
});

module.exports = MemberEventSchema;
