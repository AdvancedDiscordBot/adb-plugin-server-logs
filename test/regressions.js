"use strict";

const assert = require("node:assert/strict");
const { Client, Collection, AuditLogEvent, GuildAuditLogsEntry } = require("discord.js");
const cron = require("node-cron");
const { load } = require("../index");
const { createMockCtx } = require("./mock-ctx");

async function setup() {
	const mock = createMockCtx();
	const sent = [];
	const errors = [];
	let prune;
	let stopped = false;
	mock.ctx.logger.error = (...args) => errors.push(args);
	mock.ctx.client.channels.fetch = async () => ({
		guildId: "guild",
		isTextBased: () => true,
		send: async ({ embeds }) => {
			const data = embeds[0].toJSON();
			assert.ok(embeds[0].length <= 6000, "embed must fit Discord's total limit");
			sent.push(data);
		},
	});
	const schedule = cron.schedule;
	cron.schedule = (expression, callback) => {
		assert.equal(expression, "0 * * * *");
		prune = callback;
		return { stop: () => { stopped = true; } };
	};
	try {
		await load(mock.ctx);
	} finally {
		cron.schedule = schedule;
	}
	await mock.ctx.db.updatePluginConfig("guild", "adb-plugin-server-logs", {
		enabled: true,
		membersChannelId: "logs", moderationChannelId: "logs", voiceChannelId: "logs",
		messagesChannelId: "logs", channelsChannelId: "logs", boostsChannelId: "logs",
	});
	const guild = { id: "guild", memberCount: 10, fetchAuditLogs: async () => ({ entries: new Collection() }) };
	return {
		...mock, guild, sent, errors, prune, stopped: () => stopped,
		cache: mock.models.get("plugin_adb-plugin-server-logs_MessageCache"),
	};
}

function member(guild) {
	return {
		id: "member", guild, communicationDisabledUntilTimestamp: null, premiumSinceTimestamp: null,
		user: { id: "member", tag: "Member", displayAvatarURL: () => null },
		roles: { cache: new Collection() },
	};
}

function message(guild) {
	return {
		id: "message", guild, channel: { id: "chat" }, content: "Before",
		author: { id: "author", tag: "Author", bot: false }, attachments: new Collection(),
		url: "https://discord.com/channels/guild/chat/message",
	};
}

module.exports = async function regressions() {
	let passed = 0;
	const failures = [];
	async function test(name, run) {
		try {
			await run();
			passed++;
			console.log(`PASS ${name}`);
		} catch (error) {
			failures.push(name);
			console.error(`FAIL ${name}: ${error.stack}`);
		}
	}

	await test("equal-count role swaps log both additions and removals", async () => {
		const { guild, sent, emitEvent } = await setup();
		const oldMember = member(guild);
		const newMember = member(guild);
		oldMember.roles.cache.set("old", { id: "old", toString: () => "Old Role" });
		newMember.roles.cache.set("new", { id: "new", toString: () => "New Role" });
		await emitEvent("guildMemberUpdate", oldMember, newMember);
		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0].fields.map((field) => field.value), ["New Role", "Old Role"]);
		await emitEvent("guildMemberUpdate", newMember, newMember);
		assert.equal(sent.length, 1, "identical role sets must not log");
	});

	await test("partial member leaves keep the member identity without throwing", async () => {
		const { guild, sent, emitEvent } = await setup();
		await emitEvent("guildMemberRemove", { id: "member", guild, partial: true });
		assert.equal(sent.length, 1);
		assert.match(sent[0].description, /member/);
	});

	await test("partial member snapshots do not invent timeout, boost or role changes", async () => {
		const { guild, sent, emitEvent } = await setup();
		const newMember = member(guild);
		newMember.communicationDisabledUntilTimestamp = Date.now() + 60000;
		newMember.premiumSinceTimestamp = Date.now();
		newMember.roles.cache.set("role", { id: "role", toString: () => "Role" });
		await emitEvent("guildMemberUpdate", { id: "member", partial: true, roles: { cache: new Collection() } }, newMember);
		assert.equal(sent.length, 0);
	});

	await test("log destinations cannot send guild activity to a different guild", async () => {
		const { ctx, guild, emitEvent } = await setup();
		const client = new Client({ intents: [] });
		const otherGuild = client.guilds._add({ id: "100000000000000001", name: "Other guild", roles: [] });
		const channel = client.channels._add({ id: "100000000000000002", name: "other-logs", type: 0 }, otherGuild);
		const deliveries = [];
		channel.send = async (payload) => { deliveries.push(payload); };
		ctx.client.channels.fetch = async () => channel;
		try {
			await emitEvent("guildMemberAdd", member(guild));
			assert.equal(deliveries.length, 0, "raw client channel lookup must not cross the source guild boundary");
		} finally {
			client.destroy();
		}
	});

	await test("voice joins tolerate an uncached channel", async () => {
		const { guild, sent, emitEvent } = await setup();
		await emitEvent("voiceStateUpdate", { channelId: null }, { guild, member: member(guild), channelId: "voice", channel: null });
		assert.equal(sent.length, 1);
		assert.match(sent[0].description, /<#voice>/);
	});

	await test("role updates tolerate missing old color and permissions", async () => {
		const { guild, sent, emitEvent } = await setup();
		await emitEvent("roleUpdate", { id: "role" }, { id: "role", guild, color: 1, permissions: { bitfield: 1n } });
		assert.equal(sent.length, 0, "unknown old fields are not changes");
	});

	await test("partial message updates hydrate and compare against stored content", async () => {
		const { guild, sent, emitEvent, cache } = await setup();
		const original = message(guild);
		await emitEvent("messageCreate", original);
		const partial = { ...original, partial: true, author: null, content: null };
		await emitEvent("messageUpdate", partial, {
			...partial, fetch: async () => ({ ...original, content: "After", partial: false }),
		});
		assert.equal(sent.length, 1);
		assert.equal(sent[0].fields.find((field) => field.name === "Before").value, "Before");
		assert.equal((await cache.findOne({ messageId: original.id })).content, "After");
	});

	await test("unavailable partial updates do not erase cached content or attachments", async () => {
		const { guild, sent, emitEvent, cache } = await setup();
		const original = message(guild);
		original.attachments.set("file", { url: "https://example.com/file" });
		await emitEvent("messageCreate", original);
		await emitEvent("messageUpdate", original, {
			...original, content: null, attachments: undefined, partial: true,
			fetch: async () => { throw new Error("deleted before fetch"); },
		});
		await emitEvent("messageUpdate", original, { ...original, content: undefined, attachments: undefined });
		const cached = await cache.findOne({ messageId: original.id });
		assert.equal(cached.content, "Before");
		assert.deepEqual(cached.attachments, ["https://example.com/file"]);
		assert.equal(sent.length, 0);
	});

	await test("attachment-only edits refresh the cache used by message deletion", async () => {
		const { guild, sent, emitEvent, cache } = await setup();
		const original = message(guild);
		original.attachments.set("old", { url: "https://example.com/old" });
		await emitEvent("messageCreate", original);
		const edited = { ...original, attachments: new Collection([["new", { url: "https://example.com/new" }]]) };
		await emitEvent("messageUpdate", original, edited);
		assert.deepEqual((await cache.findOne({ messageId: original.id })).attachments, ["https://example.com/new"]);
		await emitEvent("messageDelete", { ...original, partial: true, content: null, attachments: new Collection() });
		assert.equal(sent.at(-1).fields.find((field) => field.name === "Attachments").value, "https://example.com/new");
	});

	await test("messageCreate ignores missing authors", async () => {
		const { guild, emitEvent, cache } = await setup();
		await emitEvent("messageCreate", { ...message(guild), author: null });
		assert.equal(await cache.countDocuments({}), 0);
	});

	for (const event of ["ban", "unban", "kick", "timeout", "untimeout"]) {
		await test(`${event} logs bound long audit reasons before embed validation`, async () => {
			const { guild, sent, emitEvent } = await setup();
			const target = member(guild);
			guild.fetchAuditLogs = async ({ type }) => ({ entries: new Collection(
				event === "kick" && type === AuditLogEvent.MemberBanAdd ? [] : [["audit", {
					targetId: target.id, createdTimestamp: Date.now(), reason: "r".repeat(2000),
					changes: [{ key: "communication_disabled_until" }],
				}]],
			) });
			if (event === "ban" || event === "unban") {
				await emitEvent(event === "ban" ? "guildBanAdd" : "guildBanRemove", { guild, user: target.user });
			} else if (event === "kick") {
				await emitEvent("guildMemberRemove", target);
			} else {
				const timed = { ...target, communicationDisabledUntilTimestamp: Date.now() + 60000 };
				await emitEvent("guildMemberUpdate", event === "timeout" ? target : timed, event === "timeout" ? timed : target);
			}
			assert.equal(sent.length, 1);
			assert.ok(sent[0].fields.find((field) => field.name === "Reason").value.length <= 1024);
		});
	}

	for (const event of ["ban", "unban", "timeout", "untimeout", "roleCreate", "roleDelete", "roleUpdate"]) {
		await test(`${event} attributes only recent audit entries for the actual target and change`, async () => {
			const { guild, sent, emitEvent } = await setup();
			const client = new Client({ intents: [] });
			guild.client = client;
			guild.roles = { cache: new Collection() };
			const executor = client.users._add({ id: "100000000000000001", username: "Moderator", discriminator: "0" });
			const target = member(guild);
			const timed = { ...target, communicationDisabledUntilTimestamp: Date.now() + 60000 };
			const role = { id: "role", name: "Role", guild };
			const targetId = event.startsWith("role") ? role.id : target.id;
			const cases = ["other-target", "old-entry", "future-entry", ...(event.includes("timeout") ? ["nickname-change"] : []), "matching"];
			try {
				for (const scenario of cases) {
					const timestamp = Date.now() + (scenario === "old-entry" ? -60000 : scenario === "future-entry" ? 60000 : 0);
					guild.fetchAuditLogs = async ({ type }) => ({ entries: new Collection([["entry", new GuildAuditLogsEntry(guild, {
						id: String((BigInt(timestamp) - 1420070400000n) << 22n), action_type: type,
						target_id: scenario === "other-target" ? "other" : targetId, user_id: executor.id, reason: "Audit reason",
						changes: [{ key: scenario === "nickname-change" ? "nick" : "communication_disabled_until", new_value: event === "untimeout" ? null : new Date(timed.communicationDisabledUntilTimestamp).toISOString() }],
					})]]) });
					sent.length = 0;
					if (event === "ban" || event === "unban") await emitEvent(event === "ban" ? "guildBanAdd" : "guildBanRemove", { guild, user: target.user });
					else if (event === "timeout" || event === "untimeout") await emitEvent("guildMemberUpdate", event === "timeout" ? target : timed, event === "timeout" ? timed : target);
					else if (event === "roleUpdate") await emitEvent(event, { ...role, name: "Old role" }, role);
					else await emitEvent(event, role);
					assert.equal(sent.length, 1);
					const attributed = JSON.stringify(sent[0].fields || []);
					assert.equal(attributed.includes(executor.id), scenario === "matching", `${event}: ${scenario} must not blame an unrelated moderator`);
					if (!event.startsWith("role")) assert.equal(attributed.includes("Audit reason"), scenario === "matching");
				}
			} finally {
				client.destroy();
			}
		});
	}

	await test("long attachment lists are valid embeds and still clear deleted cache entries", async () => {
		const { guild, sent, emitEvent, cache } = await setup();
		const original = message(guild);
		for (let i = 0; i < 10; i++) original.attachments.set(String(i), { url: `https://example.com/${i}/${"a".repeat(250)}` });
		await emitEvent("messageCreate", original);
		await emitEvent("messageDelete", original);
		assert.equal(sent.length, 1);
		assert.ok(sent[0].fields.find((field) => field.name === "Attachments").value.length <= 1024);
		assert.equal(await cache.countDocuments({}), 0);
	});

	await test("long forum topics cannot overflow a channel update embed", async () => {
		const { guild, sent, emitEvent } = await setup();
		await emitEvent("channelUpdate", { topic: "a".repeat(4096) }, { id: "forum", name: "Forum", guild, topic: "b".repeat(4096) });
		assert.equal(sent.length, 1);
		assert.ok(sent[0].description.length <= 4096);
		assert.match(sent[0].description, /aaa/);
		assert.match(sent[0].description, /bbb/);
	});

	await test("scheduled pruning covers dashboard-only guilds and defaults, even when logging is disabled", async () => {
		const { ctx, cache, prune, stopped } = await setup();
		await ctx.db.updatePluginConfig("explicit", "adb-plugin-server-logs", { enabled: false, retentionDays: 2 });
		const old = new Date(Date.now() - 40 * 86400000);
		for (const guildId of ["explicit", "default"]) {
			await cache.create({ messageId: `${guildId}-old`, guildId, createdAt: old });
			await cache.create({ messageId: `${guildId}-new`, guildId, createdAt: new Date() });
		}
		await prune();
		assert.equal(await cache.countDocuments({}), 2);
		assert.equal(await cache.findOne({ messageId: "explicit-old" }), null);
		assert.equal(await cache.findOne({ messageId: "default-old" }), null);
		await ctx.hooks.emitHook("onPluginUnload", { pluginName: "other" });
		assert.equal(stopped(), false);
		await ctx.hooks.emitHook("onPluginUnload", { pluginName: "adb-plugin-server-logs" });
		assert.equal(stopped(), true);
	});

	console.log(`Server logs regressions: ${passed} passed, ${failures.length} failed`);
	assert.deepEqual(failures, []);
};
