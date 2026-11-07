// ⚠️ ملف الموقع فقط (بدون بوت). البوت يشتغل من bot_21.js على استضافة ثانية وعلى نفس MONGO_URI.
const IS_BOT = false;
// =====================================================================================
// فلاش — نظام المواطنين والعسكر (النسخة المدنية)  |  app_21.js
// مواطن + عسكري في موقع واحد. التسجيل من البوت فقط. مربوط ببنك فلاش (بنك المواطنين).
// المتغيرات المطلوبة في Render: MONGO_URI, SESSION_SECRET, BOT_TOKEN, GUILD_ID, SENIOR_IDS,
//   INTERNAL_API_KEY (نفس القيمة في البنك), BANK_URL, SITE_URL
// اختيارية: REVIEW_CHANNEL_ID, CITIZEN_ROLE_ID, MILITARY_ROLE_ID, SENIOR_ROLE_ID, ADMIN_ROLE_ID, OWNER_IDS
// =====================================================================================
const express = require("express");
const mongoose = require("mongoose");
const session = require("express-session");
const crypto = require("crypto");
const {
    Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, EmbedBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
    StringSelectMenuBuilder,
} = require("discord.js");

const csv = (v) => String(v || "").split(",").map(x => x.trim()).filter(Boolean);
const CONFIG = {
    SITE_NAME: "فلاش",
    PORT: process.env.PORT || 7800,
    MONGO_URI: String(process.env.MONGO_URI || "").trim(),
    SESSION_SECRET: process.env.SESSION_SECRET || "غيّر_هذا_السر_2026",
    BOT_TOKEN: String(process.env.BOT_TOKEN || "").trim().replace(/^["']+|["']+$/g, ""),
    GUILD_ID: process.env.GUILD_ID || "",
    SITE_URL: String(process.env.SITE_URL || "").replace(/\/+$/, ""),
    OWNER_IDS: csv(process.env.OWNER_IDS),
    SENIOR_IDS: csv(process.env.SENIOR_IDS || process.env.BOT_ADMIN_IDS),
    SENIOR_ROLE_ID: process.env.SENIOR_ROLE_ID || "",
    ADMIN_ROLE_ID: process.env.ADMIN_ROLE_ID || "",
    REVIEW_CHANNEL_ID: process.env.REVIEW_CHANNEL_ID || "",
    CITIZEN_ROLE_ID: process.env.CITIZEN_ROLE_ID || "",
    MILITARY_ROLE_ID: process.env.MILITARY_ROLE_ID || "",
    INTERNAL_API_KEY: String(process.env.INTERNAL_API_KEY || "").trim(),
    BANK_URL: String(process.env.BANK_URL || "").replace(/\/+$/, ""),
    MILITARY_RANKS: [
        "جندي", "جندي اول", "عريف", "وكيل رقيب", "رقيب", "رقيب اول", "رئيس رقباء",
        "ملازم", "ملازم اول", "نقيب", "رائد", "مقدم", "عقيد", "عميد", "لواء", "فريق", "فريق اول",
    ],
    MAX_LICENSES: 3,
    MAX_PHOTO_BYTES: 1400000,
};
const UID_RE = /^\d{15,25}$/;
const DEFAULT_VIOLATIONS = [
    ["speed", "تجاوز السرعة المحددة", 500], ["reverse", "القيادة العكسية", 700],
    ["drift", "التفحيط / القيادة المتهورة", 1000], ["tint_black", "تظليل كتم", 400],
    ["tint_nickel", "تظليل نيكل", 300], ["crash", "صدم مركبات امنيه/مواطنين", 1500],
    ["flee", "هروب من رجال الامن", 2000], ["checkpoint", "الهروب من نقطة تفتيش", 1800],
];

if (!CONFIG.MONGO_URI) console.log("❌ MONGO_URI غير مضبوط — أضفه في Environment على Render");
mongoose.connect(CONFIG.MONGO_URI).then(async () => { console.log("✅ MongoDB connected"); await bootstrap(); }).catch(e => console.log("❌ MongoDB error:", e.message));

// ───────────────────────── الموديلات ─────────────────────────
const AccountSchema = new mongoose.Schema({
    uid: { type: String, required: true, unique: true },            // آيدي ديسكورد
    discordTag: String,
    kind: { type: String, enum: ["citizen", "military"], required: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true }, // وهمي
    passwordHash: String,
    fullName: String,
    age: Number,
    answers: [{ q: String, a: String, _id: false }],
    status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
    rejectReason: String, reviewedBy: String, reviewedByTag: String, reviewedAt: Date,
    reviewMsg: String,
    roleSenior: { type: Boolean, default: false },   // يزامنها البوت من رتب ديسكورد
    roleAdmin: { type: Boolean, default: false },
    // مواطن
    civilId: { type: String, default: null, index: true },          // 4-5 أرقام
    job: { type: String, default: null },
    // عسكري
    rank: { type: String, default: null },
    // صلاحيات
    isAdmin: { type: Boolean, default: false },
    isSenior: { type: Boolean, default: false },
    suspended: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
});
const Account = mongoose.model("Account", AccountSchema);

const LicenseSchema = new mongoose.Schema({
    ownerUid: { type: String, index: true }, ownerName: String, civilId: String,
    number: { type: String, index: true },
    vehicleName: String, vehicleKey: String,
    answers: [{ q: String, a: String, _id: false }],
    photo: { type: String, default: null },
    status: { type: String, enum: ["pending", "approved", "rejected", "revoked"], default: "pending" },
    rejectReason: String, reviewedBy: String, reviewedByTag: String, reviewedAt: Date,
    createdAt: { type: Date, default: Date.now },
});
const License = mongoose.model("License", LicenseSchema);

const VehicleSchema = new mongoose.Schema({
    key: { type: String, unique: true }, name: String, firstOwnerUid: String,
    aliases: { type: [String], default: [] }, createdAt: { type: Date, default: Date.now },
});
const Vehicle = mongoose.model("Vehicle", VehicleSchema);

const ViolationTypeSchema = new mongoose.Schema({
    key: { type: String, unique: true }, label: String, price: { type: Number, default: 0 }, active: { type: Boolean, default: true },
    sort: { type: Number, default: 0 },
});
const ViolationType = mongoose.model("ViolationType", ViolationTypeSchema);

const FineSchema = new mongoose.Schema({
    citizenUid: { type: String, index: true }, citizenName: String, civilId: { type: String, index: true },
    byUid: String, byName: String, byRank: String,
    typeKey: String, typeLabel: String, price: Number,
    vehicle: String, plate: String, note: String,
    status: { type: String, enum: ["unpaid", "paid", "cancelled"], default: "unpaid" },
    paidAt: Date, cancelledBy: String, cancelReason: String,
    createdAt: { type: Date, default: Date.now },
});
FineSchema.index({ citizenUid: 1, status: 1, createdAt: -1 });
const Fine = mongoose.model("Fine", FineSchema);

const JobSchema = new mongoose.Schema({ label: { type: String, unique: true }, sort: { type: Number, default: 0 } });
const Job = mongoose.model("Job", JobSchema);

const SettingsSchema = new mongoose.Schema({ civilIdDigits: { type: Number, default: 4 }, maintenance: { type: Boolean, default: false } });
const Settings = mongoose.model("Settings", SettingsSchema);
async function getSettings() { let s = await Settings.findOne(); if (!s) s = await Settings.create({}); return s; }

const BotJob = mongoose.model("BotJob", new mongoose.Schema({
    type: String, uid: String, text: String, roleId: String, claimed: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now, index: { expireAfterSeconds: 86400 } },
}));
const LogModel = mongoose.model("Log", new mongoose.Schema({ action: String, actor: String, actorName: String, target: String, details: String, at: { type: Date, default: Date.now } }));
async function logEvent(o) { try { await LogModel.create({ action: o.action, actor: o.actor || null, actorName: o.actorName || null, target: o.target || null, details: o.details || null }); } catch (e) {} }

const SessionDoc = mongoose.model("AppSession", new mongoose.Schema({ _id: String, data: Object, exp: { type: Date, index: { expireAfterSeconds: 0 } } }, { versionKey: false }));
class MongoStore extends session.Store {
    get(sid, cb) { SessionDoc.findById(sid).lean().then(d => cb(null, d && d.exp > new Date() ? d.data : null)).catch(cb); }
    set(sid, sess, cb) { const exp = new Date(Date.now() + ((sess && sess.cookie && sess.cookie.maxAge) || 14 * 864e5)); SessionDoc.updateOne({ _id: sid }, { data: sess, exp }, { upsert: true }).then(() => cb && cb()).catch(e => cb && cb(e)); }
    destroy(sid, cb) { SessionDoc.deleteOne({ _id: sid }).then(() => cb && cb()).catch(e => cb && cb(e)); }
    touch(sid, sess, cb) { this.set(sid, sess, cb); }
}

// ───────────────────────── أدوات ─────────────────────────
function hashPassword(pw) { const salt = crypto.randomBytes(16); return salt.toString("hex") + ":" + crypto.scryptSync(pw, salt, 64).toString("hex"); }
function verifyPassword(pw, stored) {
    try { const [s, h] = String(stored || "").split(":"); const x = crypto.scryptSync(pw, Buffer.from(s, "hex"), 64); const y = Buffer.from(h, "hex"); return x.length === y.length && crypto.timingSafeEqual(x, y); } catch (e) { return false; }
}
const rl = new Map();
function rateLimit(key, max, ms) { const now = Date.now(); const a = (rl.get(key) || []).filter(t => now - t < ms); if (a.length >= max) { rl.set(key, a); return false; } a.push(now); rl.set(key, a); return true; }
setInterval(() => { const now = Date.now(); for (const [k, a] of rl) { if (!a.some(t => now - t < 3600000)) rl.delete(k); } }, 600000).unref();
const clip = (s, n) => String(s == null ? "" : s).trim().slice(0, n);
const arNum = (s) => String(s || "").replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/[۰-۹]/g, d => "۰۱۲۳۴۵۶۷۸۹".indexOf(d));

// ── ذكاء المركبات: نفس السيارة بكتابات مختلفة = سيارة وحدة، والأقدم تفوز ──
function vehKey(s) {
    s = arNum(String(s || "")).toLowerCase();
    s = s.replace(/[\u064B-\u065F\u0640\u0670]/g, "").replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/ؤ/g, "و").replace(/ئ/g, "ي");
    s = s.replace(/ا/g, "");                 // الألف تختلف بالكتابة: كامري / كمري
    return s.replace(/[^a-z0-9\u0621-\u064A]/g, "");
}
function lev(a, b) {
    if (a === b) return 0; const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
    return prev[n];
}
function vehSimilar(k1, k2) { if (k1 === k2) return true; if (Math.min(k1.length, k2.length) < 5) return false; return lev(k1, k2) <= 1; }
// يرجّع الاسم الصحيح (الأقدم) للمركبة، وينشئها لو جديدة
async function canonicalVehicle(rawName, ownerUid) {
    const name = clip(rawName, 40); const key = vehKey(name);
    if (key.length < 2) return null;
    const all = await Vehicle.find().sort({ createdAt: 1 });
    let hit = all.find(v => v.key === key) || all.find(v => vehSimilar(v.key, key));
    if (hit) { if (name !== hit.name && !hit.aliases.includes(name)) { hit.aliases.push(name); await hit.save().catch(() => {}); } return hit; }
    try { return await Vehicle.create({ key, name, firstOwnerUid: ownerUid || null }); }
    catch (e) { if (e && e.code === 11000) return await Vehicle.findOne({ key }); throw e; }
}
// يدمج المكرر: يبقي الأقدم ويحذف الباقي ويحدّث الرخص والمخالفات
async function dedupeVehicles() {
    const all = await Vehicle.find().sort({ createdAt: 1 }); const dead = new Set(); let merged = 0;
    for (let i = 0; i < all.length; i++) {
        if (dead.has(String(all[i]._id))) continue;
        for (let j = i + 1; j < all.length; j++) {
            if (dead.has(String(all[j]._id))) continue;
            if (!vehSimilar(all[i].key, all[j].key)) continue;
            const keep = all[i], drop = all[j];
            await License.updateMany({ vehicleKey: drop.key }, { $set: { vehicleName: keep.name, vehicleKey: keep.key } });
            await Fine.updateMany({ vehicle: drop.name }, { $set: { vehicle: keep.name } });
            const al = Array.from(new Set([...(keep.aliases || []), drop.name, ...(drop.aliases || [])])).filter(x => x !== keep.name);
            await Vehicle.updateOne({ _id: keep._id }, { $set: { aliases: al } });
            await Vehicle.deleteOne({ _id: drop._id }); dead.add(String(drop._id)); merged++;
        }
    }
    return merged;
}

// ── الهوية المدنية ──
async function genCivilId() {
    const s = await getSettings(); const d = s.civilIdDigits === 5 ? 5 : 4; const lo = Math.pow(10, d - 1), hi = Math.pow(10, d) - 1;
    for (let i = 0; i < 60; i++) {
        const n = String(lo + crypto.randomInt(hi - lo + 1));
        if (!(await Account.exists({ civilId: n }))) return n;
    }
    for (let n = lo; n <= hi; n++) { if (!(await Account.exists({ civilId: String(n) }))) return String(n); }
    throw new Error("خلصت أرقام الهويات — زِد عدد الخانات إلى 5");
}
async function genLicenseNumber() {
    for (let i = 0; i < 40; i++) { const n = "L" + (10000 + crypto.randomInt(90000)); if (!(await License.exists({ number: n }))) return n; }
    return "L" + Date.now().toString().slice(-8);
}

// ── الصلاحيات ──
let guildCache = null;
function memberOf(uid) { try { return guildCache && guildCache.members.cache.get(uid) || null; } catch (e) { return null; } }
function isOwnerUid(uid) { return CONFIG.OWNER_IDS.includes(uid); }
async function roleInfo(uid) {
    const a = await Account.findOne({ uid }, { isSenior: 1, isAdmin: 1, roleSenior: 1, roleAdmin: 1 }).lean();
    const m = memberOf(uid);
    const senior = isOwnerUid(uid) || CONFIG.SENIOR_IDS.includes(uid) || !!(a && (a.isSenior || a.roleSenior)) || !!(m && CONFIG.SENIOR_ROLE_ID && m.roles.cache.has(CONFIG.SENIOR_ROLE_ID));
    const admin = senior || !!(a && (a.isAdmin || a.roleAdmin)) || !!(m && CONFIG.ADMIN_ROLE_ID && m.roles.cache.has(CONFIG.ADMIN_ROLE_ID));
    return { senior, admin, owner: isOwnerUid(uid) };
}

// ───────────────────────── البوت: التقديم والمراجعة ─────────────────────────
const client = IS_BOT ? new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel],
}) : null;
const drafts = new Map(); // uid -> { kind, rank, step1, at }
setInterval(() => { const now = Date.now(); for (const [k, d] of drafts) if (now - d.at > 20 * 60000) drafts.delete(k); }, 120000).unref();

const RULES = {
    citizen: "📜 **قوانين التقديم — مواطن**\n• المعلومات لازم تكون صحيحة وبدون تلاعب.\n• البريد وهمي (مو بريدك الحقيقي) وكلمة المرور تحفظها عندك.\n• ممنوع تفتح أكثر من حساب.\n• أي تلاعب أو إساءة = رفض أو حظر.\n\nبالضغط على «أوافق وأكمل» فأنت موافق على قوانين السيرفر.",
    military: "🪖 **قوانين التقديم — عسكري**\n• اختر رتبتك المسجّلة بشكل صحيح، وأي رتبة غير حقيقية = رفض.\n• البريد وهمي وكلمة المرور تحفظها عندك.\n• الالتزام بالأنظمة والانضباط العسكري.\n• ممنوع تفتح أكثر من حساب.\n\nبالضغط على «أوافق وأكمل» فأنت موافق على القوانين والأنظمة.",
};
const Q2 = {
    citizen: ["اسم شخصيتك داخل اللعبة؟", "وش ناوي تسوي بالسيرفر (وظيفة / نشاط)؟", "لو شفت مخالفة مرورية قدامك وش تسوي؟"],
    military: ["ليش تبي تنضم للسلك العسكري؟", "هل عندك خبرة سابقة؟ اشرحها باختصار", "كم ساعة تقدر تتفاعل باليوم؟"],
};
const kindLabel = (k) => k === "military" ? "عسكري" : "مواطن";

function panelEmbed(kind) {
    const mil = kind === "military";
    return new EmbedBuilder().setColor(mil ? 0x1d4ed8 : 0x3b82f6)
        .setTitle(mil ? "🪖 التقديم العسكري — فلاش" : "🪪 التقديم للمواطنين — فلاش")
        .setDescription(mil ? "للانضمام للسلك العسكري اضغط الزر وعبّي بياناتك ورتبتك المسجّلة.\nبعد القبول يفتح لك حسابك بالموقع تلقائياً على رتبتك."
            : "لإنشاء حساب مواطن اضغط الزر وعبّي بياناتك.\nبعد القبول تستلم هويتك المدنية وتدخل الموقع.");
}
function reviewEmbed(a) {
    const e = new EmbedBuilder().setColor(a.status === "approved" ? 0x22c55e : a.status === "rejected" ? 0xef4444 : 0xeab308)
        .setTitle("📥 طلب تقديم " + kindLabel(a.kind) + (a.status === "pending" ? "" : a.status === "approved" ? " — ✅ مقبول" : " — ❌ مرفوض"))
        .addFields(
            { name: "المتقدم", value: "<@" + a.uid + "> (" + (a.discordTag || a.uid) + ")", inline: true },
            { name: "الاسم", value: a.fullName || "-", inline: true },
            { name: "العمر", value: String(a.age || "-"), inline: true },
            { name: "البريد", value: a.email || "-", inline: true },
        ).setTimestamp(a.createdAt);
    if (a.kind === "military") e.addFields({ name: "الرتبة", value: a.rank || "-", inline: true });
    for (const x of (a.answers || [])) e.addFields({ name: clip(x.q, 250), value: clip(x.a, 1000) || "-" });
    if (a.status === "rejected" && a.rejectReason) e.addFields({ name: "سبب الرفض", value: clip(a.rejectReason, 500) });
    return e;
}
function reviewButtons(uid, disabled) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("app_ok_" + uid).setLabel("قبول").setStyle(ButtonStyle.Success).setEmoji("✅").setDisabled(!!disabled),
        new ButtonBuilder().setCustomId("app_no_" + uid).setLabel("رفض").setStyle(ButtonStyle.Danger).setEmoji("❌").setDisabled(!!disabled),
    );
}
// الموقع ما عنده بوت: يحط المهمة في الداتابيس والبوت (الملف الثاني) ينفذها خلال ثواني
async function dm(uid, content) {
    if (!IS_BOT) { await BotJob.create({ type: "dm", uid, text: String(content).slice(0, 1900) }).catch(() => {}); return true; }
    try { const u = await client.users.fetch(uid); await u.send(content); return true; } catch (e) { return false; }
}
async function giveRole(uid, roleId) {
    if (!roleId) return;
    if (!IS_BOT) { await BotJob.create({ type: "role", uid, roleId }).catch(() => {}); return; }
    if (!guildCache) return;
    try { const m = await guildCache.members.fetch(uid); await m.roles.add(roleId); } catch (e) { console.log("⚠️ تعذر إعطاء الرتبة:", e.message); }
}
async function editReviewMsg(a) {
    if (!IS_BOT) { await BotJob.create({ type: "review", uid: a.uid }).catch(() => {}); return; }
    try { if (!a.reviewMsg || !CONFIG.REVIEW_CHANNEL_ID) return; const ch = await client.channels.fetch(CONFIG.REVIEW_CHANNEL_ID); const m = await ch.messages.fetch(a.reviewMsg); await m.edit({ embeds: [reviewEmbed(a)], components: [reviewButtons(a.uid, true)] }); } catch (e) {}
}
async function approveAccount(uid, by) {
    const a = await Account.findOne({ uid });
    if (!a) return { ok: false, msg: "الطلب غير موجود" };
    if (a.status !== "pending") return { ok: false, msg: "الطلب تمت مراجعته من قبل" };
    if (a.kind === "citizen") a.civilId = await genCivilId();
    a.status = "approved"; a.reviewedBy = by.id; a.reviewedByTag = by.tag; a.reviewedAt = new Date();
    await a.save();
    await giveRole(uid, a.kind === "military" ? CONFIG.MILITARY_ROLE_ID : CONFIG.CITIZEN_ROLE_ID);
    await dm(uid, "✅ **تم قبول تقديمك في فلاش (" + kindLabel(a.kind) + ")**\n" + (a.kind === "citizen" ? "🪪 رقم هويتك المدنية: **" + a.civilId + "**\n" : "🎖️ رتبتك: **" + a.rank + "**\n") + "ادخل الموقع بالبريد وكلمة المرور اللي سجلتها" + (CONFIG.SITE_URL ? ":\n" + CONFIG.SITE_URL : "."));
    await logEvent({ action: "قبول تقديم", actor: by.id, actorName: by.tag, target: uid, details: a.kind });
    return { ok: true, account: a };
}
async function rejectAccount(uid, by, reason) {
    const a = await Account.findOne({ uid });
    if (!a) return { ok: false, msg: "الطلب غير موجود" };
    if (a.status !== "pending") return { ok: false, msg: "الطلب تمت مراجعته من قبل" };
    a.status = "rejected"; a.rejectReason = clip(reason, 500); a.reviewedBy = by.id; a.reviewedByTag = by.tag; a.reviewedAt = new Date();
    await a.save();
    await dm(uid, "❌ **تم رفض تقديمك في فلاش (" + kindLabel(a.kind) + ")**\nالسبب: " + (a.rejectReason || "غير محدد") + "\nتقدر تقدّم من جديد بعد ما تتواصل مع الإدارة.");
    await logEvent({ action: "رفض تقديم", actor: by.id, actorName: by.tag, target: uid, details: a.rejectReason });
    return { ok: true, account: a };
}
async function postForReview(a) {
    if (!CONFIG.REVIEW_CHANNEL_ID) return;
    try {
        const ch = await client.channels.fetch(CONFIG.REVIEW_CHANNEL_ID);
        const msg = await ch.send({ embeds: [reviewEmbed(a)], components: [reviewButtons(a.uid)] });
        await Account.updateOne({ uid: a.uid }, { $set: { reviewMsg: msg.id } }).catch(() => {});
    } catch (e) { console.log("⚠️ تعذر إرسال الطلب لروم المراجعة:", e.message); }
}

if (IS_BOT) {
client.once("ready", async () => {
    console.log("🤖 البوت شغّال: " + client.user.tag);
    try { guildCache = await client.guilds.fetch(CONFIG.GUILD_ID); await guildCache.members.fetch().catch(() => {}); } catch (e) { console.log("⚠️ تعذر جلب السيرفر:", e.message); }
    try {
        const cmds = [
            new SlashCommandBuilder().setName("نشر-التقديم").setDescription("نشر لوحة التقديم (مواطن + عسكري) في هذا الروم").toJSON(),
        ];
        await new REST({ version: "10" }).setToken(CONFIG.BOT_TOKEN).put(Routes.applicationGuildCommands(client.user.id, CONFIG.GUILD_ID), { body: cmds });
    } catch (e) { console.log("⚠️ فشل تسجيل الأوامر:", e.message); }
});

function modal1(kind) {
    const m = new ModalBuilder().setCustomId("m1_" + kind).setTitle("تقديم " + kindLabel(kind) + " — بياناتك");
    const f = (id, label, style, ph, min, max) => new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setPlaceholder(ph || "").setRequired(true).setMinLength(min || 1).setMaxLength(max || 60));
    m.addComponents(
        f("name", "الاسم (اسمك في اللعبة)", TextInputStyle.Short, "مثال: خالد محمد العتيبي", 3, 60),
        f("email", "البريد الإلكتروني (وهمي)", TextInputStyle.Short, "مثال: khalid@flash.sa", 5, 120),
        f("pass", "كلمة المرور", TextInputStyle.Short, "6 أحرف أو أكثر — لا تستخدم كلمة مرور حقيقية", 6, 64),
        f("age", "العمر (في اللعبة)", TextInputStyle.Short, "مثال: 25", 1, 2),
    );
    return m;
}
function modal2(kind) {
    const m = new ModalBuilder().setCustomId("m2_" + kind).setTitle("تقديم " + kindLabel(kind) + " — الأسئلة");
    Q2[kind].forEach((q, i) => m.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("q" + i).setLabel(q.slice(0, 45)).setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(3).setMaxLength(400))));
    return m;
}

client.on("interactionCreate", async (i) => {
    try {
        // ── أمر نشر اللوحة ──
        if (i.isChatInputCommand() && i.commandName === "نشر-التقديم") {
            const r = await roleInfo(i.user.id);
            if (!r.senior) return i.reply({ content: "🚫 هذا الأمر لكبار المسؤولين فقط.", ephemeral: true });
            await i.channel.send({ embeds: [panelEmbed("citizen")], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("apply_citizen").setLabel("تقديم مواطن").setStyle(ButtonStyle.Primary).setEmoji("🪪"))] });
            await i.channel.send({ embeds: [panelEmbed("military")], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("apply_military").setLabel("تقديم عسكري").setStyle(ButtonStyle.Success).setEmoji("🪖"))] });
            return i.reply({ content: "✅ تم نشر لوحتي التقديم.", ephemeral: true });
        }

        // ── بدء التقديم ──
        if (i.isButton() && (i.customId === "apply_citizen" || i.customId === "apply_military")) {
            const kind = i.customId === "apply_military" ? "military" : "citizen";
            const ex = await Account.findOne({ uid: i.user.id }).lean();
            if (ex) {
                const msg = ex.status === "pending" ? "⏳ عندك طلب قيد المراجعة، انتظر القبول." : ex.status === "approved" ? "✅ عندك حساب مفعّل أصلاً (" + kindLabel(ex.kind) + ")." : "❌ تم رفض طلبك سابقاً، تواصل مع الإدارة.";
                return i.reply({ content: msg, ephemeral: true });
            }
            drafts.set(i.user.id, { kind, at: Date.now() });
            const rows = [];
            if (kind === "military") rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId("rank_pick").setPlaceholder("اختر رتبتك المسجّلة").addOptions(CONFIG.MILITARY_RANKS.map(r => ({ label: r, value: r })))));
            rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("agree_" + kind).setLabel("أوافق وأكمل").setStyle(ButtonStyle.Success).setEmoji("✅")));
            return i.reply({ embeds: [new EmbedBuilder().setColor(0x3b82f6).setDescription(RULES[kind])], components: rows, ephemeral: true });
        }
        if (i.isStringSelectMenu() && i.customId === "rank_pick") {
            const d = drafts.get(i.user.id); if (!d) return i.reply({ content: "انتهت الجلسة، اضغط زر التقديم من جديد.", ephemeral: true });
            d.rank = i.values[0]; d.at = Date.now();
            return i.reply({ content: "🎖️ الرتبة المختارة: **" + d.rank + "** — اضغط «أوافق وأكمل».", ephemeral: true });
        }
        if (i.isButton() && i.customId.startsWith("agree_")) {
            const kind = i.customId.slice(6); const d = drafts.get(i.user.id);
            if (!d || d.kind !== kind) return i.reply({ content: "انتهت الجلسة، اضغط زر التقديم من جديد.", ephemeral: true });
            if (kind === "military" && !d.rank) return i.reply({ content: "⚠️ اختر رتبتك من القائمة أولاً.", ephemeral: true });
            return i.showModal(modal1(kind));
        }
        if (i.isModalSubmit() && i.customId.startsWith("m1_")) {
            const kind = i.customId.slice(3); const d = drafts.get(i.user.id);
            if (!d || d.kind !== kind) return i.reply({ content: "انتهت الجلسة، اضغط زر التقديم من جديد.", ephemeral: true });
            const fullName = clip(i.fields.getTextInputValue("name"), 60), email = clip(i.fields.getTextInputValue("email"), 120).toLowerCase();
            const pass = String(i.fields.getTextInputValue("pass") || ""), age = parseInt(arNum(i.fields.getTextInputValue("age")), 10);
            if (fullName.length < 3) return i.reply({ content: "⚠️ اكتب اسمك كامل.", ephemeral: true });
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return i.reply({ content: "⚠️ اكتب بريد بصيغة صحيحة (وهمي عادي).", ephemeral: true });
            if (pass.length < 6) return i.reply({ content: "⚠️ كلمة المرور لازم 6 أحرف على الأقل.", ephemeral: true });
            if (!Number.isFinite(age) || age < 10 || age > 99) return i.reply({ content: "⚠️ اكتب عمر صحيح.", ephemeral: true });
            if (await Account.exists({ email })) return i.reply({ content: "⚠️ هذا البريد مستخدم، اختر بريد ثاني.", ephemeral: true });
            d.step1 = { fullName, email, pass, age }; d.at = Date.now();
            return i.reply({ content: "✅ تم حفظ الخطوة الأولى. اضغط للخطوة الثانية (الأسئلة):", ephemeral: true,
                components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("step2_" + kind).setLabel("الخطوة الثانية").setStyle(ButtonStyle.Primary).setEmoji("📝"))] });
        }
        if (i.isButton() && i.customId.startsWith("step2_")) {
            const kind = i.customId.slice(6); const d = drafts.get(i.user.id);
            if (!d || d.kind !== kind || !d.step1) return i.reply({ content: "انتهت الجلسة، اضغط زر التقديم من جديد.", ephemeral: true });
            return i.showModal(modal2(kind));
        }
        if (i.isModalSubmit() && i.customId.startsWith("m2_")) {
            const kind = i.customId.slice(3); const d = drafts.get(i.user.id);
            if (!d || d.kind !== kind || !d.step1) return i.reply({ content: "انتهت الجلسة، اضغط زر التقديم من جديد.", ephemeral: true });
            if (await Account.exists({ uid: i.user.id })) { drafts.delete(i.user.id); return i.reply({ content: "عندك طلب مسجّل أصلاً.", ephemeral: true }); }
            const answers = Q2[kind].map((q, n) => ({ q, a: clip(i.fields.getTextInputValue("q" + n), 400) }));
            let a;
            try {
                a = await Account.create({
                    uid: i.user.id, discordTag: i.user.username, kind, email: d.step1.email, passwordHash: hashPassword(d.step1.pass),
                    fullName: d.step1.fullName, age: d.step1.age, answers, rank: kind === "military" ? d.rank : null, status: "pending",
                });
            } catch (e) { return i.reply({ content: e && e.code === 11000 ? "⚠️ البريد أو الحساب مسجّل من قبل." : "❌ صار خطأ، حاول من جديد.", ephemeral: true }); }
            drafts.delete(i.user.id);
            await logEvent({ action: "تقديم جديد", actor: i.user.id, actorName: i.user.username, details: kind });
            await postForReview(a);
            return i.reply({ content: "📨 تم إرسال تقديمك (" + kindLabel(kind) + ") للإدارة. بيوصلك رد على الخاص.\n⚠️ افتح الخاص عشان توصلك النتيجة.", ephemeral: true });
        }

        // ── مراجعة الطلب من ديسكورد ──
        if (i.isButton() && (i.customId.startsWith("app_ok_") || i.customId.startsWith("app_no_"))) {
            const r = await roleInfo(i.user.id);
            if (!r.admin) return i.reply({ content: "🚫 المراجعة للإدارة وكبار المسؤولين فقط.", ephemeral: true });
            const ok = i.customId.startsWith("app_ok_"); const uid = i.customId.slice(7);
            if (!ok) {
                const m = new ModalBuilder().setCustomId("appno_" + uid).setTitle("سبب الرفض");
                m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("reason").setLabel("اكتب سبب الرفض").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)));
                return i.showModal(m);
            }
            await i.deferUpdate();
            const res = await approveAccount(uid, { id: i.user.id, tag: i.user.username });
            if (!res.ok) return i.followUp({ content: "⚠️ " + res.msg, ephemeral: true });
            return i.message.edit({ embeds: [reviewEmbed(res.account)], components: [reviewButtons(uid, true)] });
        }
        if (i.isModalSubmit() && i.customId.startsWith("appno_")) {
            const r = await roleInfo(i.user.id);
            if (!r.admin) return i.reply({ content: "🚫 غير مصرح.", ephemeral: true });
            await i.deferUpdate();
            const res = await rejectAccount(i.customId.slice(6), { id: i.user.id, tag: i.user.username }, i.fields.getTextInputValue("reason"));
            if (!res.ok) return i.followUp({ content: "⚠️ " + res.msg, ephemeral: true });
            return i.message.edit({ embeds: [reviewEmbed(res.account)], components: [reviewButtons(res.account.uid, true)] });
        }
    } catch (e) {
        console.error("❌ interaction:", e.message);
        try { if (!i.replied && !i.deferred) await i.reply({ content: "❌ صار خطأ غير متوقع.", ephemeral: true }); } catch (e2) {}
    }
});

}

// ───────────────────────── السيرفر والـ API ─────────────────────────
const app = express();
app.set("trust proxy", 1);
app.get("/healthz", (req, res) => res.type("text").send("ok"));
app.use(express.json({ limit: "3mb" }));
app.use(session({
    name: "flash_sid", store: new MongoStore(), secret: CONFIG.SESSION_SECRET, resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", secure: "auto", maxAge: 14 * 864e5 },
}));
const clientIp = (req) => String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e => { console.error("❌", req.path, e.message); if (!res.headersSent) res.status(500).json({ error: "صار خطأ بالسيرفر" }); });

async function loadAuth(req, res, next) {
    const uid = req.session && req.session.uid;
    if (!uid) return res.status(401).json({ error: "سجّل دخولك أولاً" });
    const a = await Account.findOne({ uid });
    if (!a || a.status !== "approved") { req.session.destroy(() => {}); return res.status(401).json({ error: "الحساب غير مفعّل" }); }
    if (a.suspended) return res.status(403).json({ error: "⛔ حسابك موقوف من الإدارة", suspended: true });
    req.acc = a; req.role = await roleInfo(uid);
    if (!req.role.admin) { const s = await getSettings(); if (s.maintenance) return res.status(503).json({ error: "🚧 الموقع تحت الصيانة حالياً", maintenance: true }); }
    next();
}
const need = (kind) => (req, res, next) => (req.acc.kind === kind || req.role.admin) ? next() : res.status(403).json({ error: "هذا القسم مو لك" });
const needCitizen = (req, res, next) => req.acc.kind === "citizen" ? next() : res.status(403).json({ error: "هذا القسم للمواطنين فقط" });
const needMilitary = (req, res, next) => (req.acc.kind === "military" || req.role.admin) ? next() : res.status(403).json({ error: "هذا القسم للعسكر فقط" });
const needStaff = (req, res, next) => req.role.admin ? next() : res.status(403).json({ error: "للإدارة وكبار المسؤولين فقط" });
const needSenior = (req, res, next) => req.role.senior ? next() : res.status(403).json({ error: "لكبار المسؤولين فقط" });

app.post("/auth/login", wrap(async (req, res) => {
    if (!rateLimit("login:" + clientIp(req), 30, 10 * 60000)) return res.status(429).json({ error: "محاولات كثيرة، انتظر شوي" });
    const email = clip((req.body || {}).email, 120).toLowerCase(), password = String((req.body || {}).password || "");
    if (!email || !password) return res.status(400).json({ error: "اكتب البريد وكلمة المرور" });
    const a = await Account.findOne({ email });
    if (!a || !verifyPassword(password, a.passwordHash)) return res.status(401).json({ error: "البريد أو كلمة المرور غير صحيحة" });
    if (a.status === "pending") return res.status(403).json({ error: "تقديمك قيد المراجعة، انتظر القبول" });
    if (a.status === "rejected") return res.status(403).json({ error: "تم رفض تقديمك" + (a.rejectReason ? " — السبب: " + a.rejectReason : "") });
    if (a.suspended) return res.status(403).json({ error: "⛔ حسابك موقوف" });
    req.session.regenerate((err) => {
        if (err) return res.status(500).json({ error: "تعذر تسجيل الدخول" });
        req.session.uid = a.uid; req.session.save(() => res.json({ ok: true }));
    });
}));
app.get("/auth/logout", (req, res) => req.session.destroy(() => res.redirect("/")));

app.get("/api/me", wrap(async (req, res) => {
    const uid = req.session && req.session.uid;
    if (!uid) return res.json({ loggedIn: false });
    const a = await Account.findOne({ uid }).lean();
    if (!a || a.status !== "approved") return res.json({ loggedIn: false });
    if (a.suspended) return res.json({ loggedIn: true, blocked: true, reason: "⛔ حسابك موقوف من الإدارة." });
    const r = await roleInfo(uid);
    const s = await getSettings();
    if (s.maintenance && !r.admin) return res.json({ loggedIn: true, blocked: true, reason: "🚧 الموقع تحت الصيانة حالياً." });
    res.json({ loggedIn: true, uid, kind: a.kind, name: a.fullName, rank: a.rank, civilId: a.civilId, job: a.job, age: a.age, createdAt: a.createdAt, senior: r.senior, admin: r.admin, owner: r.owner, bank: !!(CONFIG.INTERNAL_API_KEY && CONFIG.BANK_URL) });
}));

// ── المواطن ──
const LIC_QUESTIONS = [
    "كيف توقف على اليمين وتتجنب الحوادث؟",
    "كيف تغيّر مسارك؟",
    "إذا شفت تنظيم قدامك هل تتجاوزه أو توقف لين يفتح الطريق؟",
    "في حال كنت بتاخذ يوتيرن وش تسوي؟",
    "في حال كان فيه حالة طارئة وراك، ايش التصرف اللي بتسويه عشان تبعد وما تعطل السير؟",
];
const licOut = (l) => ({ id: l._id, number: l.number, vehicle: l.vehicleName, status: l.status, rejectReason: l.rejectReason, createdAt: l.createdAt, reviewedAt: l.reviewedAt });
app.get("/api/citizen/card", loadAuth, needCitizen, wrap(async (req, res) => {
    const lic = await License.find({ ownerUid: req.acc.uid }, { photo: 0, answers: 0 }).sort({ createdAt: -1 }).lean();
    res.json({ name: req.acc.fullName, civilId: req.acc.civilId, job: req.acc.job, since: req.acc.reviewedAt || req.acc.createdAt, age: req.acc.age, licenses: lic.map(licOut), questions: LIC_QUESTIONS, max: CONFIG.MAX_LICENSES });
}));
app.post("/api/citizen/license", loadAuth, needCitizen, wrap(async (req, res) => {
    const b = req.body || {};
    const vehicleName = clip(b.vehicleName, 40);
    if (vehKey(vehicleName).length < 2) return res.status(400).json({ error: "اكتب نوع المركبة" });
    const ans = Array.isArray(b.answers) ? b.answers.map(x => clip(x, 400)) : [];
    if (ans.length !== LIC_QUESTIONS.length || ans.some(x => x.length < 3)) return res.status(400).json({ error: "عبّي كل الأسئلة ولا تترك سؤال فاضي" });
    const photo = String(b.photo || "");
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo)) return res.status(400).json({ error: "ارفق صورة للمركبة" });
    if (photo.length > CONFIG.MAX_PHOTO_BYTES) return res.status(400).json({ error: "الصورة كبيرة، صغّرها شوي" });
    const active = await License.countDocuments({ ownerUid: req.acc.uid, status: { $in: ["pending", "approved"] } });
    if (active >= CONFIG.MAX_LICENSES) return res.status(400).json({ error: "وصلت الحد الأقصى للرخص (" + CONFIG.MAX_LICENSES + ")" });
    const dupe = await License.findOne({ ownerUid: req.acc.uid, vehicleKey: vehKey(vehicleName), status: { $in: ["pending", "approved"] } }).lean();
    if (dupe) return res.status(400).json({ error: "عندك رخصة لهذي المركبة أو طلب قيد المراجعة" });
    if (await License.exists({ ownerUid: req.acc.uid, status: "pending" })) return res.status(400).json({ error: "عندك طلب رخصة قيد المراجعة، انتظر" });
    await License.create({ ownerUid: req.acc.uid, ownerName: req.acc.fullName, civilId: req.acc.civilId, vehicleName, vehicleKey: vehKey(vehicleName), answers: LIC_QUESTIONS.map((q, i) => ({ q, a: ans[i] })), photo, status: "pending" });
    await logEvent({ action: "طلب رخصة", actor: req.acc.uid, actorName: req.acc.fullName, details: vehicleName });
    res.json({ ok: true });
}));
app.get("/api/license/:id/photo", loadAuth, wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).end();
    const l = await License.findById(req.params.id, { photo: 1, ownerUid: 1 }).lean();
    if (!l || !l.photo || (l.ownerUid !== req.acc.uid && !req.role.admin)) return res.status(404).end();
    const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(l.photo); if (!m) return res.status(404).end();
    res.set("Content-Type", m[1]).set("Cache-Control", "private, max-age=3600").send(Buffer.from(m[2], "base64"));
}));
const fineOut = (f) => ({ id: f._id, type: f.typeLabel, price: f.price, vehicle: f.vehicle, plate: f.plate, note: f.note, by: f.byName, byRank: f.byRank, status: f.status, createdAt: f.createdAt, paidAt: f.paidAt, citizen: f.citizenName, civilId: f.civilId });
app.get("/api/citizen/fines", loadAuth, needCitizen, wrap(async (req, res) => {
    const list = await Fine.find({ citizenUid: req.acc.uid, status: { $ne: "cancelled" } }).sort({ createdAt: -1 }).limit(200).lean();
    res.json({ fines: list.map(fineOut), unpaidTotal: list.filter(f => f.status === "unpaid").reduce((s, f) => s + (f.price || 0), 0) });
}));

// ── البنك (للمواطن: سداد المخالفات بالبطاقة) ──
function bankHeaders() { return { "x-internal-key": CONFIG.INTERNAL_API_KEY, "Content-Type": "application/json" }; }
async function bankCall(path, opts) {
    if (!CONFIG.INTERNAL_API_KEY || !CONFIG.BANK_URL) throw new Error("البنك غير مربوط بعد");
    const r = await fetch(CONFIG.BANK_URL + path, Object.assign({ headers: bankHeaders(), signal: AbortSignal.timeout(25000) }, opts || {}));
    const t = await r.text(); try { return JSON.parse(t); } catch (e) { throw new Error("رد غير متوقع من البنك"); }
}
const payLock = new Set();
app.post("/api/citizen/fines/pay", loadAuth, needCitizen, wrap(async (req, res) => {
    const uid = req.acc.uid; const b = req.body || {};
    if (payLock.has(uid)) return res.status(429).json({ error: "في عملية سداد شغّالة، انتظر" });
    if (!rateLimit("pay:" + uid, 12, 10 * 60000)) return res.status(429).json({ error: "محاولات كثيرة، انتظر شوي" });
    const cardNumber = clip(b.cardNumber, 30), cardPIN = clip(b.cardPIN, 12);
    if (!cardNumber || !cardPIN) return res.status(400).json({ error: "اكتب رقم البطاقة والرقم السري" });
    const ids = Array.isArray(b.ids) ? b.ids.filter(x => mongoose.isValidObjectId(x)) : [];
    const q = { citizenUid: uid, status: "unpaid" }; if (!b.all) { if (!ids.length) return res.status(400).json({ error: "اختر مخالفة للسداد" }); q._id = { $in: ids }; }
    const fines = await Fine.find(q);
    if (!fines.length) return res.status(400).json({ error: "ما فيه مخالفات للسداد" });
    const total = fines.reduce((s, f) => s + (f.price || 0), 0);
    if (!(total > 0)) return res.status(400).json({ error: "مبلغ غير صالح" });
    payLock.add(uid);
    try {
        const r = await bankCall("/api/flash/violations/pay", { method: "POST", body: JSON.stringify({ discordId: uid, cardNumber, cardPIN, amount: total, reason: "سداد " + fines.length + " مخالفة — هوية " + (req.acc.civilId || "") }) });
        if (!r.success) return res.status(400).json({ error: r.msg || "فشل السداد" });
        await Fine.updateMany({ _id: { $in: fines.map(f => f._id) }, status: "unpaid" }, { $set: { status: "paid", paidAt: new Date() } });
        await logEvent({ action: "سداد مخالفات", actor: uid, actorName: req.acc.fullName, details: fines.length + " مخالفة = " + total });
        res.json({ ok: true, total, newBalance: r.newBalance });
    } catch (e) { res.status(502).json({ error: e.message || "تعذر الاتصال بالبنك" }); }
    finally { payLock.delete(uid); }
}));
app.get("/api/citizen/balance", loadAuth, needCitizen, wrap(async (req, res) => {
    try { const r = await bankCall("/api/flash/balance/" + encodeURIComponent(req.acc.uid)); res.json(r); } catch (e) { res.json({ success: false, msg: e.message }); }
}));

// ── العسكري ──
app.get("/api/mil/types", loadAuth, needMilitary, wrap(async (req, res) => {
    res.json(await ViolationType.find({ active: true }, { key: 1, label: 1, price: 1 }).sort({ sort: 1, label: 1 }).lean());
}));
app.get("/api/mil/lookup", loadAuth, needMilitary, wrap(async (req, res) => {
    const id = arNum(clip(req.query.civilId, 8));
    if (!/^\d{4,5}$/.test(id)) return res.status(400).json({ error: "اكتب رقم هوية صحيح (4 أو 5 أرقام)" });
    const c = await Account.findOne({ civilId: id, kind: "citizen", status: "approved" }, { uid: 1, fullName: 1, civilId: 1, suspended: 1 }).lean();
    if (!c) return res.status(404).json({ error: "ما فيه مواطن بهذا الرقم" });
    const lic = await License.find({ ownerUid: c.uid, status: "approved" }, { vehicleName: 1, number: 1 }).lean();
    const vehicles = Array.from(new Set(lic.map(l => l.vehicleName)));   // المكرر يذوب والأقدم يفوز
    const unpaid = await Fine.countDocuments({ citizenUid: c.uid, status: "unpaid" });
    res.json({ name: c.fullName, civilId: c.civilId, vehicles, hasLicense: lic.length > 0, unpaid });
}));
app.post("/api/mil/fine", loadAuth, needMilitary, wrap(async (req, res) => {
    if (!rateLimit("fine:" + req.acc.uid, 40, 10 * 60000)) return res.status(429).json({ error: "سجّلت مخالفات كثيرة، انتظر شوي" });
    const b = req.body || {}; const id = arNum(clip(b.civilId, 8));
    const c = await Account.findOne({ civilId: id, kind: "citizen", status: "approved" }).lean();
    if (!c) return res.status(404).json({ error: "رقم الهوية غير صحيح" });
    const t = await ViolationType.findOne({ key: String(b.typeKey || ""), active: true }).lean();
    if (!t) return res.status(400).json({ error: "نوع المخالفة غير صحيح" });
    const lic = await License.find({ ownerUid: c.uid, status: "approved" }, { vehicleName: 1 }).lean();
    const vlist = Array.from(new Set(lic.map(l => l.vehicleName)));
    let vehicle = clip(b.vehicle, 40);
    if (vlist.length) { if (!vlist.includes(vehicle)) return res.status(400).json({ error: "اختر مركبة من مركبات المواطن المسجّلة" }); }
    else vehicle = "بدون رخصة مسجّلة";
    const f = await Fine.create({
        citizenUid: c.uid, citizenName: c.fullName, civilId: c.civilId, byUid: req.acc.uid, byName: req.acc.fullName, byRank: req.acc.rank || (req.role.admin ? "إدارة" : ""),
        typeKey: t.key, typeLabel: t.label, price: t.price, vehicle, plate: clip(b.plate, 20), note: clip(b.note, 300), status: "unpaid",
    });
    await logEvent({ action: "تسجيل مخالفة", actor: req.acc.uid, actorName: req.acc.fullName, target: c.uid, details: t.label + " = " + t.price + " | هوية " + c.civilId });
    await dm(c.uid, "🚨 **تم تسجيل مخالفة عليك**\nالمخالفة: " + t.label + "\nالمبلغ: **" + t.price + "**\nالمركبة: " + vehicle + "\nادخل فلاش وسدّدها من تاب «مخالفاتي».");
    res.json({ ok: true, fine: fineOut(f) });
}));
app.get("/api/mil/my", loadAuth, needMilitary, wrap(async (req, res) => {
    res.json((await Fine.find({ byUid: req.acc.uid }).sort({ createdAt: -1 }).limit(80).lean()).map(fineOut));
}));

// ── الإدارة والكبار ──
app.get("/api/staff/applications", loadAuth, needStaff, wrap(async (req, res) => {
    const st = ["pending", "approved", "rejected"].includes(req.query.status) ? req.query.status : "pending";
    const list = await Account.find({ status: st }, { passwordHash: 0 }).sort({ createdAt: -1 }).limit(100).lean();
    res.json(list.map(a => ({ uid: a.uid, tag: a.discordTag, kind: a.kind, name: a.fullName, age: a.age, email: a.email, rank: a.rank, answers: a.answers, status: a.status, rejectReason: a.rejectReason, createdAt: a.createdAt, by: a.reviewedByTag })));
}));
app.post("/api/staff/applications/:uid/approve", loadAuth, needStaff, wrap(async (req, res) => {
    const r = await approveAccount(req.params.uid, { id: req.acc.uid, tag: req.acc.fullName });
    if (!r.ok) return res.status(400).json({ error: r.msg }); editReviewMsg(r.account); res.json({ ok: true });
}));
app.post("/api/staff/applications/:uid/reject", loadAuth, needStaff, wrap(async (req, res) => {
    const reason = clip((req.body || {}).reason, 500); if (!reason) return res.status(400).json({ error: "اكتب سبب الرفض" });
    const r = await rejectAccount(req.params.uid, { id: req.acc.uid, tag: req.acc.fullName }, reason);
    if (!r.ok) return res.status(400).json({ error: r.msg }); editReviewMsg(r.account); res.json({ ok: true });
}));

app.get("/api/staff/licenses", loadAuth, needStaff, wrap(async (req, res) => {
    const st = ["pending", "approved", "rejected", "revoked"].includes(req.query.status) ? req.query.status : "pending";
    const list = await License.find({ status: st }, { photo: 0 }).sort({ createdAt: -1 }).limit(100).lean();
    res.json(list.map(l => ({ id: l._id, number: l.number, owner: l.ownerName, civilId: l.civilId, vehicle: l.vehicleName, answers: l.answers, status: l.status, rejectReason: l.rejectReason, createdAt: l.createdAt })));
}));
app.post("/api/staff/licenses/:id/approve", loadAuth, needStaff, wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "معرّف غير صالح" });
    const l = await License.findById(req.params.id, { photo: 0 }); if (!l || l.status !== "pending") return res.status(400).json({ error: "الطلب تمت مراجعته" });
    const v = await canonicalVehicle(l.vehicleName, l.ownerUid);
    if (!v) return res.status(400).json({ error: "اسم المركبة غير صالح" });
    const had = await License.exists({ ownerUid: l.ownerUid, status: "approved", vehicleKey: v.key, _id: { $ne: l._id } });
    if (had) return res.status(400).json({ error: "المواطن عنده رخصة لنفس المركبة (" + v.name + ")" });
    await License.updateOne({ _id: l._id }, { $set: { status: "approved", vehicleName: v.name, vehicleKey: v.key, number: await genLicenseNumber(), reviewedBy: req.acc.uid, reviewedByTag: req.acc.fullName, reviewedAt: new Date() } });
    await dm(l.ownerUid, "✅ **تم اعتماد رخصتك** — المركبة: " + v.name);
    await logEvent({ action: "اعتماد رخصة", actor: req.acc.uid, actorName: req.acc.fullName, target: l.ownerUid, details: v.name });
    res.json({ ok: true, vehicle: v.name });
}));
app.post("/api/staff/licenses/:id/reject", loadAuth, needStaff, wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "معرّف غير صالح" });
    const reason = clip((req.body || {}).reason, 300); if (!reason) return res.status(400).json({ error: "اكتب سبب الرفض" });
    const l = await License.findOneAndUpdate({ _id: req.params.id, status: "pending" }, { $set: { status: "rejected", rejectReason: reason, reviewedBy: req.acc.uid, reviewedByTag: req.acc.fullName, reviewedAt: new Date() } }, { new: true, projection: { photo: 0 } });
    if (!l) return res.status(400).json({ error: "الطلب تمت مراجعته" });
    await dm(l.ownerUid, "❌ **تم رفض طلب رخصتك**\nالسبب: " + reason); res.json({ ok: true });
}));
app.post("/api/staff/licenses/:id/revoke", loadAuth, needStaff, wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "معرّف غير صالح" });
    const r = await License.updateOne({ _id: req.params.id, status: "approved" }, { $set: { status: "revoked", reviewedBy: req.acc.uid, reviewedByTag: req.acc.fullName, reviewedAt: new Date() } });
    res.json({ ok: !!r.modifiedCount });
}));

app.get("/api/staff/people", loadAuth, needStaff, wrap(async (req, res) => {
    const q = clip(req.query.q, 40); const f = { status: "approved" };
    if (["citizen", "military"].includes(req.query.kind)) f.kind = req.query.kind;
    if (q) { const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); f.$or = [{ fullName: rx }, { civilId: rx }, { uid: rx }, { discordTag: rx }]; }
    const list = await Account.find(f, { passwordHash: 0, answers: 0 }).sort({ createdAt: -1 }).limit(60).lean();
    res.json(list.map(a => ({ uid: a.uid, tag: a.discordTag, kind: a.kind, name: a.fullName, civilId: a.civilId, job: a.job, rank: a.rank, isAdmin: a.isAdmin, isSenior: a.isSenior, suspended: a.suspended })));
}));
app.post("/api/staff/people/:uid/civil-id", loadAuth, needStaff, wrap(async (req, res) => {
    const id = arNum(clip((req.body || {}).civilId, 8)); if (!/^\d{4,5}$/.test(id)) return res.status(400).json({ error: "رقم الهوية 4 أو 5 أرقام فقط" });
    const a = await Account.findOne({ uid: req.params.uid, kind: "citizen" }); if (!a) return res.status(404).json({ error: "المواطن غير موجود" });
    if (await Account.exists({ civilId: id, uid: { $ne: a.uid } })) return res.status(400).json({ error: "الرقم مستخدم عند مواطن ثاني" });
    const old = a.civilId; a.civilId = id; await a.save();
    await License.updateMany({ ownerUid: a.uid }, { $set: { civilId: id } }); await Fine.updateMany({ citizenUid: a.uid }, { $set: { civilId: id } });
    await logEvent({ action: "تعديل رقم هوية", actor: req.acc.uid, actorName: req.acc.fullName, target: a.uid, details: old + " → " + id });
    res.json({ ok: true });
}));
app.post("/api/staff/people/:uid/suspend", loadAuth, needStaff, wrap(async (req, res) => {
    const t = await Account.findOne({ uid: req.params.uid }); if (!t) return res.status(404).json({ error: "غير موجود" });
    const tr = await roleInfo(t.uid); if (tr.admin && !req.role.senior) return res.status(403).json({ error: "ما تقدر توقف إداري" });
    if (tr.owner) return res.status(403).json({ error: "ما تقدر توقف المالك" });
    t.suspended = !!(req.body || {}).suspended; await t.save();
    if (t.suspended) await SessionDoc.deleteMany({ "data.uid": t.uid });
    await logEvent({ action: t.suspended ? "إيقاف حساب" : "فك إيقاف", actor: req.acc.uid, actorName: req.acc.fullName, target: t.uid }); res.json({ ok: true });
}));
app.get("/api/staff/fines", loadAuth, needStaff, wrap(async (req, res) => {
    const f = {}; if (["unpaid", "paid", "cancelled"].includes(req.query.status)) f.status = req.query.status;
    const q = arNum(clip(req.query.q, 30)); if (q) { f.$or = [{ civilId: q }, { citizenName: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }]; }
    res.json((await Fine.find(f).sort({ createdAt: -1 }).limit(100).lean()).map(fineOut));
}));
app.post("/api/staff/fines/:id/cancel", loadAuth, needStaff, wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "معرّف غير صالح" });
    const r = await Fine.updateOne({ _id: req.params.id, status: "unpaid" }, { $set: { status: "cancelled", cancelledBy: req.acc.fullName, cancelReason: clip((req.body || {}).reason, 200) } });
    res.json({ ok: !!r.modifiedCount, error: r.modifiedCount ? undefined : "المخالفة مو غير مسددة" });
}));
app.get("/api/staff/vehicles", loadAuth, needStaff, wrap(async (req, res) => {
    const v = await Vehicle.find().sort({ createdAt: 1 }).lean();
    const counts = await License.aggregate([{ $match: { status: "approved" } }, { $group: { _id: "$vehicleKey", n: { $sum: 1 } } }]);
    const m = new Map(counts.map(c => [c._id, c.n]));
    res.json(v.map(x => ({ id: x._id, name: x.name, aliases: x.aliases, licenses: m.get(x.key) || 0, createdAt: x.createdAt })));
}));
app.post("/api/staff/vehicles/dedupe", loadAuth, needStaff, wrap(async (req, res) => { res.json({ ok: true, merged: await dedupeVehicles() }); }));
app.post("/api/senior/vehicles/:id/rename", loadAuth, needSenior, wrap(async (req, res) => {
    const name = clip((req.body || {}).name, 40); const key = vehKey(name); if (key.length < 2) return res.status(400).json({ error: "اسم غير صالح" });
    const v = await Vehicle.findById(req.params.id); if (!v) return res.status(404).json({ error: "غير موجود" });
    const clash = await Vehicle.findOne({ key, _id: { $ne: v._id } }); if (clash) return res.status(400).json({ error: "في مركبة ثانية بنفس الاسم، استخدم «دمج المكرر»" });
    const old = v.name; v.aliases = Array.from(new Set([...(v.aliases || []), old])).filter(x => x !== name); v.name = name; v.key = key; await v.save();
    await License.updateMany({ vehicleName: old }, { $set: { vehicleName: name, vehicleKey: key } }); await Fine.updateMany({ vehicle: old }, { $set: { vehicle: name } });
    res.json({ ok: true });
}));

// ── كبار المسؤولين: الأسعار / الوظائف / الإعدادات / الصلاحيات ──
app.get("/api/senior/types", loadAuth, needSenior, wrap(async (req, res) => { res.json(await ViolationType.find().sort({ sort: 1, label: 1 }).lean()); }));
app.post("/api/senior/types", loadAuth, needSenior, wrap(async (req, res) => {
    const label = clip((req.body || {}).label, 60), price = Math.round(Number((req.body || {}).price));
    if (label.length < 2 || !(price >= 0 && price <= 100000000)) return res.status(400).json({ error: "اكتب اسم المخالفة وسعر صحيح" });
    const key = "t" + crypto.randomBytes(5).toString("hex");
    res.json({ ok: true, item: await ViolationType.create({ key, label, price, sort: Date.now() % 100000 }) });
}));
app.post("/api/senior/types/:id", loadAuth, needSenior, wrap(async (req, res) => {
    const b = req.body || {}; const set = {};
    if (b.price !== undefined) { const p = Math.round(Number(b.price)); if (!(p >= 0 && p <= 100000000)) return res.status(400).json({ error: "سعر غير صحيح" }); set.price = p; }
    if (b.label !== undefined) { const l = clip(b.label, 60); if (l.length < 2) return res.status(400).json({ error: "الاسم قصير" }); set.label = l; }
    if (b.active !== undefined) set.active = !!b.active;
    const t = await ViolationType.findByIdAndUpdate(req.params.id, { $set: set }, { new: true }); if (!t) return res.status(404).json({ error: "غير موجود" });
    await logEvent({ action: "تعديل مخالفة", actor: req.acc.uid, actorName: req.acc.fullName, details: t.label + " = " + t.price + (t.active ? "" : " (موقوفة)") });
    res.json({ ok: true });
}));
app.get("/api/senior/jobs", loadAuth, needStaff, wrap(async (req, res) => { res.json(await Job.find().sort({ sort: 1, label: 1 }).lean()); }));
app.post("/api/senior/jobs", loadAuth, needSenior, wrap(async (req, res) => {
    const label = clip((req.body || {}).label, 40); if (label.length < 2) return res.status(400).json({ error: "اكتب اسم الوظيفة" });
    try { await Job.create({ label, sort: Date.now() % 100000 }); } catch (e) { return res.status(400).json({ error: "الوظيفة موجودة" }); } res.json({ ok: true });
}));
app.post("/api/senior/jobs/:id/delete", loadAuth, needSenior, wrap(async (req, res) => {
    const j = await Job.findByIdAndDelete(req.params.id); if (j) await Account.updateMany({ job: j.label }, { $set: { job: null } }); res.json({ ok: true });
}));
app.post("/api/senior/people/:uid/job", loadAuth, needStaff, wrap(async (req, res) => {
    const job = clip((req.body || {}).job, 40) || null;
    if (job && !(await Job.exists({ label: job }))) return res.status(400).json({ error: "الوظيفة مو موجودة بالقائمة" });
    const a = await Account.findOneAndUpdate({ uid: req.params.uid, kind: "citizen" }, { $set: { job } }); if (!a) return res.status(404).json({ error: "المواطن غير موجود" });
    await logEvent({ action: "تعيين وظيفة", actor: req.acc.uid, actorName: req.acc.fullName, target: a.uid, details: job || "إزالة" });
    if (job) dm(a.uid, "💼 تم تعيينك في وظيفة: **" + job + "**"); res.json({ ok: true });
}));
app.post("/api/senior/people/:uid/rank", loadAuth, needStaff, wrap(async (req, res) => {
    const rank = clip((req.body || {}).rank, 30); if (!CONFIG.MILITARY_RANKS.includes(rank)) return res.status(400).json({ error: "رتبة غير صحيحة" });
    const a = await Account.findOneAndUpdate({ uid: req.params.uid, kind: "military" }, { $set: { rank } }); if (!a) return res.status(404).json({ error: "العسكري غير موجود" });
    await logEvent({ action: "تعديل رتبة", actor: req.acc.uid, actorName: req.acc.fullName, target: a.uid, details: a.rank + " → " + rank }); res.json({ ok: true });
}));
app.get("/api/meta/ranks", loadAuth, wrap(async (req, res) => res.json(CONFIG.MILITARY_RANKS)));
app.post("/api/senior/people/:uid/admin", loadAuth, needSenior, wrap(async (req, res) => {
    const a = await Account.findOneAndUpdate({ uid: req.params.uid }, { $set: { isAdmin: !!(req.body || {}).isAdmin } }); if (!a) return res.status(404).json({ error: "غير موجود" });
    await logEvent({ action: "صلاحية إدارة", actor: req.acc.uid, actorName: req.acc.fullName, target: a.uid, details: String(!!(req.body || {}).isAdmin) }); res.json({ ok: true });
}));
app.get("/api/senior/settings", loadAuth, needSenior, wrap(async (req, res) => { const s = await getSettings(); res.json({ civilIdDigits: s.civilIdDigits, maintenance: s.maintenance }); }));
app.post("/api/senior/settings", loadAuth, needSenior, wrap(async (req, res) => {
    const b = req.body || {}; const s = await getSettings();
    if (b.civilIdDigits !== undefined) { const d = Number(b.civilIdDigits); if (d !== 4 && d !== 5) return res.status(400).json({ error: "4 أو 5 فقط" }); s.civilIdDigits = d; }
    if (b.maintenance !== undefined) s.maintenance = !!b.maintenance;
    await s.save(); res.json({ ok: true });
}));
app.get("/api/senior/logs", loadAuth, needSenior, wrap(async (req, res) => { res.json(await LogModel.find().sort({ at: -1 }).limit(120).lean()); }));

// ───────────────────────── صفحة الموقع (نفس تصميم فلاش) ─────────────────────────
const PAGE_HTML = String.raw`<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#0a1628"><title>فلاش</title>
<link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;900&display=swap" rel="stylesheet">
<style>
:root{--bg1:#0a1628;--bg2:#0d1f3c;--panel:rgba(255,255,255,0.04);--border:rgba(59,130,246,0.25);--gold:#3b82f6;--gold-soft:#60a5fa;--green:#22c55e;--red:#ef4444;--amber:#eab308;--text:#e2e8f0;--muted:#64748b}
*{box-sizing:border-box;margin:0;padding:0;font-family:'Tajawal','Tahoma','Segoe UI',sans-serif}
body{background:linear-gradient(135deg,#0a1628 0%,#0d1f3c 40%,#0a2744 70%,#0d3060 100%);color:var(--text);min-height:100vh;-webkit-tap-highlight-color:transparent}
nav{background:rgba(5,15,30,.95);backdrop-filter:blur(15px);border-bottom:1px solid rgba(59,130,246,.3);padding:0 1rem;display:flex;align-items:center;justify-content:space-between;height:56px;position:sticky;top:0;z-index:50}
.logo{font-size:1.3rem;font-weight:900;background:linear-gradient(90deg,#3b82f6,#60a5fa,#93c5fd);-webkit-background-clip:text;-webkit-text-fill-color:transparent;letter-spacing:2px}
.logo svg{width:24px;height:24px;vertical-align:-5px;margin-inline-end:6px}
.who{font-size:13px;color:var(--muted);display:flex;gap:10px;align-items:center}
.tabs{display:flex;gap:6px;overflow-x:auto;padding:10px 12px;position:sticky;top:56px;z-index:40;background:rgba(10,22,40,.92);backdrop-filter:blur(8px);border-bottom:1px solid rgba(59,130,246,.15)}
.tabs::-webkit-scrollbar{display:none}
.tab{flex:0 0 auto;padding:8px 14px;border-radius:10px;border:1px solid var(--border);background:var(--panel);color:var(--text);cursor:pointer;font-size:14px;font-weight:700;white-space:nowrap}
.tab.on{background:linear-gradient(135deg,#1d4ed8,#3b82f6);border-color:transparent;color:#fff}
.wrap{max-width:760px;margin:0 auto;padding:14px 12px 60px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:14px;margin-bottom:12px}
.card h3{font-size:16px;margin-bottom:8px;color:var(--gold-soft)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.row.sb{justify-content:space-between}
.muted{color:var(--muted);font-size:13px}
.btn{border:0;border-radius:10px;padding:9px 14px;font-weight:700;font-size:14px;cursor:pointer;color:#fff;background:linear-gradient(135deg,#1d4ed8,#3b82f6)}
.btn.g{background:linear-gradient(135deg,#15803d,#22c55e)}.btn.r{background:linear-gradient(135deg,#b91c1c,#ef4444)}.btn.gray{background:#374151}.btn.sm{padding:6px 10px;font-size:12px}
.btn:disabled{opacity:.5;cursor:not-allowed}
input,select,textarea{width:100%;background:rgba(255,255,255,.06);border:1px solid var(--border);border-radius:10px;padding:10px 12px;color:var(--text);font-size:15px;outline:none}
select option{background:#0d1f3c}textarea{min-height:70px;resize:vertical}
label.f{display:block;font-size:13px;color:var(--gold-soft);margin:10px 0 4px}
.badge{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;font-weight:700}
.b-ok{background:rgba(34,197,94,.15);color:#4ade80}.b-no{background:rgba(239,68,68,.15);color:#f87171}.b-wait{background:rgba(234,179,8,.15);color:#facc15}.b-gray{background:rgba(148,163,184,.15);color:#cbd5e1}
.qa{font-size:13px;margin-top:6px;background:rgba(0,0,0,.2);border-radius:8px;padding:7px 9px}.qa b{color:var(--gold-soft)}
.toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:#0d1f3c;border:1px solid var(--border);padding:11px 18px;border-radius:12px;z-index:9999;font-weight:700;font-size:14px;max-width:90vw;box-shadow:0 8px 30px rgba(0,0,0,.5)}
.toast.err{border-color:#ef4444;color:#fecaca}.toast.ok{border-color:#22c55e;color:#bbf7d0}
#ov{position:fixed;inset:0;background:rgba(5,10,20,.75);backdrop-filter:blur(3px);z-index:7000;display:none;align-items:center;justify-content:center;padding:14px}
#ov.open{display:flex}#box{background:linear-gradient(160deg,#0d1f3c,#0a1628);border:1px solid var(--border);border-radius:14px;width:100%;max-width:420px;max-height:92vh;overflow:auto;padding:18px}
#box h3{margin-bottom:6px;color:var(--gold-soft)}
.login{max-width:380px;margin:9vh auto 0;padding:0 14px}
.login .logo{font-size:2.4rem;text-align:center;margin-bottom:6px}.login .logo svg{width:44px;height:44px}
/* بطاقات */
.cards{display:flex;gap:14px;flex-wrap:wrap;justify-content:center}
.idc{position:relative;width:100%;max-width:370px;aspect-ratio:1.62;border-radius:18px;padding:16px;overflow:hidden;color:#fff;background:linear-gradient(135deg,#0b1d3f 0%,#12408f 52%,#2563eb 100%);box-shadow:0 14px 36px rgba(0,0,0,.5),inset 0 0 0 1px rgba(147,197,253,.35)}
.idc.lic{background:linear-gradient(135deg,#1c1306 0%,#7a5a12 50%,#e0b43a 100%);box-shadow:0 14px 36px rgba(0,0,0,.5),inset 0 0 0 1px rgba(253,230,138,.45)}
.idc:before{content:"";position:absolute;inset:0;background:radial-gradient(circle at 85% 10%,rgba(255,255,255,.22),transparent 45%),repeating-linear-gradient(115deg,rgba(255,255,255,.04) 0 2px,transparent 2px 10px);pointer-events:none}
.idc .bolt{position:absolute;left:-26px;bottom:-34px;width:190px;height:190px;opacity:.1}
.idc-h{display:flex;align-items:center;justify-content:space-between;position:relative}
.idc-t{font-weight:900;font-size:17px;letter-spacing:1px;display:flex;align-items:center;gap:6px}.idc-t svg{width:22px;height:22px}
.idc-t small{display:block;font-size:10px;font-weight:500;opacity:.8;letter-spacing:0}
.chip{width:36px;height:27px;border-radius:6px;background:linear-gradient(135deg,#fde68a,#d4a017);box-shadow:inset 0 0 0 1px rgba(0,0,0,.25)}
.idc-b{position:relative;display:flex;gap:12px;margin-top:12px;align-items:center}
.av{width:62px;height:76px;border-radius:10px;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.3);display:flex;align-items:center;justify-content:center;font-size:30px;font-weight:900;flex:0 0 auto;overflow:hidden}
.av img{width:100%;height:100%;object-fit:cover}
.idc .nm{font-size:17px;font-weight:900;line-height:1.2}.idc .lb{font-size:10px;opacity:.75;margin-top:6px}
.idc .num{font-size:28px;font-weight:900;letter-spacing:5px;font-family:'Courier New',monospace;text-shadow:0 2px 8px rgba(0,0,0,.4)}
.idc-f{position:absolute;right:16px;left:16px;bottom:11px;display:flex;justify-content:space-between;font-size:11px;opacity:.9}
.idc .stamp{position:absolute;top:44px;left:12px;transform:rotate(-14deg);border:2px solid rgba(255,255,255,.7);border-radius:8px;padding:2px 8px;font-size:11px;font-weight:900;opacity:.85}
.holo{position:absolute;top:0;bottom:0;width:60px;left:-80px;background:linear-gradient(100deg,transparent,rgba(255,255,255,.35),transparent);transform:skewX(-20deg);animation:sh 4.5s infinite}
@keyframes sh{0%,60%{left:-80px}100%{left:120%}}
.thumb{width:64px;height:48px;border-radius:8px;object-fit:cover;border:1px solid var(--border);cursor:pointer}
hr{border:0;border-top:1px solid rgba(59,130,246,.15);margin:10px 0}
.fine{display:flex;gap:10px;align-items:flex-start}.fine input[type=checkbox]{width:20px;height:20px;margin-top:3px;flex:0 0 auto}
</style></head><body>
<div id="app"></div><div id="ov"><div id="box"></div></div>
<script>
var LOGO='<svg viewBox="0 0 100 100" aria-hidden="true"><defs><linearGradient id="lg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#60a5fa"/><stop offset="1" stop-color="#1d4ed8"/></linearGradient></defs><path fill="url(#lg)" d="M58 8 L26 55 L46 55 L40 92 L74 42 L54 42 L64 8 Z"/></svg>';
var LOGO_W='<svg viewBox="0 0 100 100" class="bolt"><path fill="#fff" d="M58 8 L26 55 L46 55 L40 92 L74 42 L54 42 L64 8 Z"/></svg>';
var ME=null,TAB=null,TABS=[];
function $(s){return document.querySelector(s)}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
function money(n){return Number(n||0).toLocaleString("en-US")}
function dt(d){try{return new Date(d).toLocaleDateString("ar-SA",{year:"numeric",month:"short",day:"numeric"})}catch(e){return ""}}
function api(path,body,method){var o={method:method||(body?"POST":"GET"),headers:{}};if(body){o.headers["Content-Type"]="application/json";o.body=JSON.stringify(body)}
 return fetch(path,o).then(function(r){return r.json().catch(function(){return {}}).then(function(d){if(!r.ok){var e=new Error(d.error||d.msg||"صار خطأ");e.status=r.status;e.data=d;throw e}return d})})}
var tt;function toast(m,ok){var t=document.createElement("div");t.className="toast "+(ok===false?"err":"ok");t.textContent=m;document.body.appendChild(t);clearTimeout(tt);setTimeout(function(){t.remove()},3200)}
function fail(e){if(e&&e.status===401){location.reload();return}toast(e.message||"خطأ",false)}
function openBox(h){$("#box").innerHTML=h;$("#ov").classList.add("open")}function closeBox(){$("#ov").classList.remove("open")}
$("#ov").addEventListener("click",function(e){if(e.target.id==="ov")closeBox()});
// نافذة إدخال عامة: fields=[{id,label,type,value,options,ph}] ترجّع وعد بالقيم أو null
function ask(title,fields,okLabel,note){return new Promise(function(res){
 var h='<h3>'+esc(title)+'</h3>'+(note?'<div class="muted">'+esc(note)+'</div>':'');
 fields.forEach(function(f){h+='<label class="f">'+esc(f.label)+'</label>';
  if(f.type==="textarea")h+='<textarea id="af_'+f.id+'" placeholder="'+esc(f.ph||"")+'">'+esc(f.value||"")+'</textarea>';
  else if(f.type==="select"){h+='<select id="af_'+f.id+'">';f.options.forEach(function(o){var v=typeof o==="object"?o.v:o,l=typeof o==="object"?o.l:o;h+='<option value="'+esc(v)+'"'+(String(v)===String(f.value)?" selected":"")+'>'+esc(l)+'</option>'});h+='</select>'}
  else h+='<input id="af_'+f.id+'" type="'+(f.type||"text")+'" value="'+esc(f.value||"")+'" placeholder="'+esc(f.ph||"")+'" autocomplete="off">'});
 h+='<div class="row" style="margin-top:14px"><button class="btn g" id="af_ok">'+esc(okLabel||"تأكيد")+'</button><button class="btn gray" id="af_no">إلغاء</button></div>';
 openBox(h);
 $("#af_no").onclick=function(){closeBox();res(null)};
 $("#af_ok").onclick=function(){var o={};fields.forEach(function(f){o[f.id]=$("#af_"+f.id).value});closeBox();res(o)}})}
function sure(msg){return ask(msg,[], "نعم").then(function(v){return !!v})}

/* ───── تسجيل الدخول ───── */
function loginView(){
 $("#app").innerHTML='<div class="login"><div class="logo">'+LOGO+'فلاش</div><div class="card"><div class="muted" style="text-align:center;margin-bottom:6px">سجّل دخولك بالبريد وكلمة المرور اللي سجلتها من البوت</div>'+
 '<label class="f">البريد الإلكتروني</label><input id="lg_e" type="email" autocomplete="username">'+
 '<label class="f">كلمة المرور</label><input id="lg_p" type="password" autocomplete="current-password">'+
 '<button class="btn" id="lg_b" style="width:100%;margin-top:14px">دخول</button>'+
 '<div class="muted" style="text-align:center;margin-top:12px">ما عندك حساب؟ قدّم من بوت ديسكورد (مواطن / عسكري) وانتظر القبول.</div></div></div>';
 function go(){var b=$("#lg_b");b.disabled=true;api("/auth/login",{email:$("#lg_e").value,password:$("#lg_p").value}).then(function(){location.reload()}).catch(function(e){b.disabled=false;toast(e.message,false)})}
 $("#lg_b").onclick=go;$("#lg_p").onkeydown=function(e){if(e.key==="Enter")go()}}

/* ───── الهيكل ───── */
function shell(){
 var kindL=ME.kind==="military"?"عسكري":"مواطن";
 TABS=[];
 if(ME.kind==="citizen"){TABS.push(["id","🪪 هويتي"],["fines","🚨 مخالفاتي"])}
 if(ME.kind==="military"||ME.admin){TABS.push(["issue","🚔 تسجيل مخالفة"])}
 if(ME.kind==="military"){TABS.push(["mine","📋 سجلي"])}
 if(ME.bank)TABS.push(["bank","🏦 البنك"]);
 if(ME.admin)TABS.push(["apps","📥 الطلبات"],["lics","📄 الرخص"],["people","👥 الأفراد"],["sfines","🧾 المخالفات"],["veh","🚗 المركبات"]);
 if(ME.senior)TABS.push(["types","💲 الأسعار"],["jobs","💼 الوظائف"],["set","⚙️ الإعدادات"],["logs","📜 السجل"]);
 $("#app").innerHTML='<nav><div class="logo">'+LOGO+'فلاش</div><div class="who"><span>'+esc(ME.name)+' · '+kindL+(ME.senior?" · كبار":ME.admin?" · إدارة":"")+'</span><a class="btn gray sm" href="/auth/logout" style="text-decoration:none">خروج</a></div></nav><div class="tabs" id="tabs"></div><div class="wrap" id="main"></div>';
 $("#tabs").innerHTML=TABS.map(function(t){return '<button class="tab" data-tab="'+t[0]+'">'+t[1]+'</button>'}).join("");
 $("#tabs").onclick=function(e){var b=e.target.closest("[data-tab]");if(b)show(b.dataset.tab)};
 show((location.hash||"").slice(1)&&TABS.some(function(t){return t[0]===location.hash.slice(1)})?location.hash.slice(1):TABS[0][0])}
function show(id){TAB=id;history.replaceState(null,"","#"+id);document.querySelectorAll(".tab").forEach(function(b){b.classList.toggle("on",b.dataset.tab===id)});
 $("#main").innerHTML='<div class="muted" style="text-align:center;padding:30px">⏳ جاري التحميل...</div>';
 var f=V[id];if(f)Promise.resolve(f()).catch(fail)}
function main(h){$("#main").innerHTML=h}
var A={};
document.addEventListener("click",function(e){var b=e.target.closest("[data-a]");if(!b)return;var f=A[b.dataset.a];if(f){e.preventDefault();Promise.resolve(f(b.dataset,b)).catch(fail)}});
function stBadge(s){var m={pending:["قيد المراجعة","b-wait"],approved:["معتمد","b-ok"],rejected:["مرفوض","b-no"],revoked:["ملغي","b-gray"],unpaid:["غير مسددة","b-no"],paid:["مسددة","b-ok"],cancelled:["ملغاة","b-gray"]}[s]||[s,"b-gray"];return '<span class="badge '+m[1]+'">'+m[0]+'</span>'}

var V={};
/* ───── المواطن: الهوية والرخصة ───── */
V.id=function(){return api("/api/citizen/card").then(function(d){
 var ini=esc((d.name||"?").trim().charAt(0));
 var h='<div class="cards"><div class="idc">'+LOGO_W+'<div class="holo"></div><div class="idc-h"><div class="idc-t">'+LOGO+'<div>فلاش<small>الهوية المدنية · CIVIL ID</small></div></div><div class="chip"></div></div>'+
 '<div class="idc-b"><div class="av">'+ini+'</div><div><div class="nm">'+esc(d.name)+'</div><div class="lb">رقم الهوية</div><div class="num">'+esc(d.civilId)+'</div></div></div>'+
 '<div class="idc-f"><span>💼 '+esc(d.job||"بدون وظيفة")+'</span><span>منذ '+dt(d.since)+'</span></div></div>';
 var ap=d.licenses.filter(function(l){return l.status==="approved"});
 ap.forEach(function(l){h+='<div class="idc lic">'+LOGO_W+'<div class="holo"></div><div class="idc-h"><div class="idc-t">'+LOGO+'<div>فلاش<small>رخصة قيادة · DRIVING LICENSE</small></div></div><div class="chip"></div></div>'+
  '<div class="idc-b"><div class="av"><img src="/api/license/'+l.id+'/photo" alt=""></div><div><div class="nm">'+esc(d.name)+'</div><div class="lb">المركبة</div><div style="font-size:18px;font-weight:900">'+esc(l.vehicle)+'</div><div class="lb">رقم الرخصة</div><div style="font-size:20px;font-weight:900;letter-spacing:3px;font-family:monospace">'+esc(l.number)+'</div></div></div>'+
  '<div class="idc-f"><span>هوية: '+esc(d.civilId)+'</span><span>صادرة '+dt(l.reviewedAt)+'</span></div></div>'});
 h+='</div>';
 var other=d.licenses.filter(function(l){return l.status!=="approved"});
 h+='<div class="card" style="margin-top:14px"><div class="row sb"><h3 style="margin:0">🚗 الرخص</h3><button class="btn" data-a="newLic">+ تسجيل رخصة</button></div>';
 if(!d.licenses.length)h+='<div class="muted" style="margin-top:8px">ما عندك رخصة. سجّل رخصة وبعد اعتمادها تطلع بطاقتك جنب الهوية.</div>';
 other.forEach(function(l){h+='<hr><div class="row sb"><div>'+esc(l.vehicle)+' '+stBadge(l.status)+'</div><span class="muted">'+dt(l.createdAt)+'</span></div>'+(l.rejectReason?'<div class="muted">السبب: '+esc(l.rejectReason)+'</div>':'')});
 h+='</div>';main(h);window.__LQ=d.questions})};
function compress(file){return new Promise(function(res,rej){var r=new FileReader();r.onerror=function(){rej(new Error("تعذر قراءة الصورة"))};r.onload=function(){var im=new Image();im.onerror=function(){rej(new Error("الملف مو صورة"))};im.onload=function(){var s=Math.min(1,900/Math.max(im.width,im.height)),c=document.createElement("canvas");c.width=Math.round(im.width*s);c.height=Math.round(im.height*s);c.getContext("2d").drawImage(im,0,0,c.width,c.height);var q=.75,u=c.toDataURL("image/jpeg",q);while(u.length>1300000&&q>.3){q-=.1;u=c.toDataURL("image/jpeg",q)}res(u)};im.src=r.result};r.readAsDataURL(file)})}
A.newLic=function(){
 var h='<h3>📝 نموذج طلب رخصة</h3><label class="f">نوع مركبتك</label><input id="nl_v" placeholder="مثال: جي كلاس / كامري" maxlength="40">';
 (window.__LQ||[]).forEach(function(q,i){h+='<label class="f">'+(i+1)+'. '+esc(q)+'</label><textarea id="nl_q'+i+'" maxlength="400"></textarea>'});
 h+='<label class="f">صورة للمركبة</label><input id="nl_p" type="file" accept="image/*"><div class="muted" style="margin-top:10px">⚠️ يمنع تخريب النموذج، ويرجى إرفاق صورة للمركبة وتعبئة جميع الأسئلة وعدم ترك سؤال فاضي.</div>'+
 '<div class="row" style="margin-top:14px"><button class="btn g" id="nl_ok">إرسال الطلب</button><button class="btn gray" id="nl_no">إلغاء</button></div>';
 openBox(h);$("#nl_no").onclick=closeBox;
 $("#nl_ok").onclick=function(){var b=$("#nl_ok"),f=$("#nl_p").files[0];var ans=(window.__LQ||[]).map(function(q,i){return $("#nl_q"+i).value.trim()});
  if(!$("#nl_v").value.trim()||ans.some(function(x){return x.length<3})||!f){toast("عبّي كل الأسئلة وارفق الصورة",false);return}
  b.disabled=true;compress(f).then(function(p){return api("/api/citizen/license",{vehicleName:$("#nl_v").value,answers:ans,photo:p})}).then(function(){closeBox();toast("✅ تم إرسال طلب الرخصة للمراجعة");show("id")}).catch(function(e){b.disabled=false;fail(e)})}};

/* ───── المواطن: المخالفات والسداد ───── */
V.fines=function(){return api("/api/citizen/fines").then(function(d){
 var h='<div class="card"><div class="row sb"><div><h3 style="margin:0">🚨 مخالفاتي</h3><div class="muted">المطلوب سداده: <b style="color:#f87171">'+money(d.unpaidTotal)+'</b></div></div>'+(d.unpaidTotal>0?'<button class="btn g" data-a="payAll">سداد الكل</button>':'')+'</div></div>';
 if(!d.fines.length)h+='<div class="card muted" style="text-align:center">✅ سجلّك نظيف، ما عليك مخالفات.</div>';
 d.fines.forEach(function(f){h+='<div class="card"><div class="fine">'+(f.status==="unpaid"?'<input type="checkbox" class="fchk" value="'+f.id+'">':'<span></span>')+'<div style="flex:1"><div class="row sb"><b>'+esc(f.type)+'</b>'+stBadge(f.status)+'</div><div class="muted">المبلغ: <b style="color:#fff">'+money(f.price)+'</b> · المركبة: '+esc(f.vehicle||"-")+(f.plate?' · لوحة '+esc(f.plate):'')+'</div><div class="muted">سجّلها: '+esc(f.byRank?f.byRank+" ":"")+esc(f.by)+' · '+dt(f.createdAt)+'</div>'+(f.note?'<div class="qa">'+esc(f.note)+'</div>':'')+'</div></div></div>'});
 if(d.fines.some(function(f){return f.status==="unpaid"}))h+='<button class="btn" data-a="paySel" style="width:100%">سداد المحدد</button>';
 main(h)})};
function payFlow(body){return ask("💳 سداد المخالفات",[{id:"c",label:"رقم البطاقة البنكية",ph:"0000 0000 0000 0000"},{id:"p",label:"الرقم السري",type:"password"}],"سداد","يُخصم المبلغ من رصيدك في بنك فلاش.").then(function(v){if(!v)return;
 body.cardNumber=v.c;body.cardPIN=v.p;return api("/api/citizen/fines/pay",body).then(function(d){toast("✅ تم سداد "+money(d.total));show("fines")})})}
A.payAll=function(){return payFlow({all:true})};
A.paySel=function(){var ids=[].map.call(document.querySelectorAll(".fchk:checked"),function(c){return c.value});if(!ids.length){toast("حدد مخالفة أولاً",false);return}return payFlow({ids:ids})};

/* ───── العسكري: تسجيل مخالفة ───── */
var TYPES=[];
V.issue=function(){return api("/api/mil/types").then(function(t){TYPES=t;
 main('<div class="card"><h3>🚔 تسجيل مخالفة</h3><label class="f">رقم الهوية المدنية للمواطن</label><div class="row"><input id="is_id" inputmode="numeric" maxlength="5" placeholder="ضع هوية الشخص" style="flex:1"><button class="btn" data-a="lookup">بحث</button></div><div id="is_res"></div></div><div id="is_done"></div>')})};
A.lookup=function(){var id=$("#is_id").value.trim();return api("/api/mil/lookup?civilId="+encodeURIComponent(id)).then(function(c){
 var h='<hr><div class="row sb"><b>👤 '+esc(c.name)+'</b><span class="badge b-gray">هوية '+esc(c.civilId)+'</span></div>'+(c.unpaid?'<div class="muted">عليه '+c.unpaid+' مخالفة غير مسددة</div>':'');
 h+='<label class="f">المركبة (من رخصة المواطن)</label>';
 if(c.vehicles.length)h+='<select id="is_v">'+c.vehicles.map(function(v){return '<option>'+esc(v)+'</option>'}).join("")+'</select>';else h+='<div class="badge b-no">ما عنده رخصة مسجّلة — المخالفة تنسجل «بدون رخصة»</div>';
 h+='<label class="f">نوع المخالفة</label><select id="is_t">'+TYPES.map(function(t){return '<option value="'+esc(t.key)+'">'+esc(t.label)+' — '+money(t.price)+'</option>'}).join("")+'</select>'+
 '<label class="f">رقم اللوحة (اختياري)</label><input id="is_pl" maxlength="20"><label class="f">ملاحظات (اختياري)</label><textarea id="is_n" maxlength="300"></textarea>'+
 '<button class="btn r" data-a="sendFine" data-id="'+esc(c.civilId)+'" style="width:100%;margin-top:12px">تسجيل المخالفة</button>';$("#is_res").innerHTML=h})};
A.sendFine=function(d,b){b.disabled=true;return api("/api/mil/fine",{civilId:d.id,typeKey:$("#is_t").value,vehicle:$("#is_v")?$("#is_v").value:"",plate:$("#is_pl").value,note:$("#is_n").value}).then(function(r){toast("✅ تم تسجيل المخالفة");$("#is_res").innerHTML="";$("#is_id").value="";$("#is_done").innerHTML='<div class="card"><b>✔ سُجّلت:</b> '+esc(r.fine.type)+' على '+esc(r.fine.citizen)+' — '+money(r.fine.price)+'</div>'}).catch(function(e){b.disabled=false;fail(e)})};
V.mine=function(){return api("/api/mil/my").then(function(l){var h='<div class="card"><h3>📋 مخالفاتي المسجّلة</h3><div class="muted">آخر '+l.length+' مخالفة</div></div>';
 l.forEach(function(f){h+='<div class="card"><div class="row sb"><b>'+esc(f.type)+'</b>'+stBadge(f.status)+'</div><div class="muted">'+esc(f.citizen)+' · هوية '+esc(f.civilId)+' · '+money(f.price)+' · '+dt(f.createdAt)+'</div></div>'});main(h)})};

/* ───── البنك ───── */
V.bank=function(){main('<div class="card" style="text-align:center"><div style="font-size:44px">🏦</div><h3>بنك فلاش</h3><div class="muted" style="margin-bottom:12px">حسابك، التحويلات، البطاقة، والرواتب</div><button class="btn" data-a="openBank">فتح البنك</button></div>')};
A.openBank=function(d,b){b.disabled=true;return api("/api/bank/sso").then(function(r){location.href=r.url}).catch(function(e){b.disabled=false;fail(e)})};

/* ───── الإدارة: الطلبات ───── */
var APPST="pending";
V.apps=function(){return api("/api/staff/applications?status="+APPST).then(function(l){
 var h='<div class="row" style="margin-bottom:10px">'+["pending","approved","rejected"].map(function(s){return '<button class="tab'+(s===APPST?" on":"")+'" data-a="appFilter" data-s="'+s+'">'+{pending:"قيد المراجعة",approved:"المقبولة",rejected:"المرفوضة"}[s]+'</button>'}).join("")+'</div>';
 if(!l.length)h+='<div class="card muted" style="text-align:center">ما فيه طلبات</div>';
 l.forEach(function(a){h+='<div class="card"><div class="row sb"><b>'+(a.kind==="military"?"🪖":"🪪")+' '+esc(a.name)+'</b>'+stBadge(a.status)+'</div><div class="muted">'+esc(a.tag)+' · عمر '+esc(a.age)+' · '+esc(a.email)+(a.rank?' · رتبة: <b>'+esc(a.rank)+'</b>':'')+' · '+dt(a.createdAt)+'</div>'+
  (a.answers||[]).map(function(x){return '<div class="qa"><b>'+esc(x.q)+'</b><br>'+esc(x.a)+'</div>'}).join("")+
  (a.status==="pending"?'<div class="row" style="margin-top:10px"><button class="btn g sm" data-a="appOk" data-id="'+a.uid+'">قبول</button><button class="btn r sm" data-a="appNo" data-id="'+a.uid+'">رفض</button></div>':(a.rejectReason?'<div class="muted">سبب الرفض: '+esc(a.rejectReason)+'</div>':'')+(a.by?'<div class="muted">بواسطة: '+esc(a.by)+'</div>':''))+'</div>'});main(h)})};
A.appFilter=function(d){APPST=d.s;show("apps")};
A.appOk=function(d){return api("/api/staff/applications/"+d.id+"/approve",{}).then(function(){toast("✅ تم القبول");show("apps")})};
A.appNo=function(d){return ask("سبب الرفض",[{id:"r",label:"السبب",type:"textarea"}],"رفض").then(function(v){if(!v||!v.r.trim())return;return api("/api/staff/applications/"+d.id+"/reject",{reason:v.r}).then(function(){toast("تم الرفض");show("apps")})})};

/* ───── الإدارة: الرخص ───── */
var LICST="pending";
V.lics=function(){return api("/api/staff/licenses?status="+LICST).then(function(l){
 var h='<div class="row" style="margin-bottom:10px">'+["pending","approved","rejected","revoked"].map(function(s){return '<button class="tab'+(s===LICST?" on":"")+'" data-a="licFilter" data-s="'+s+'">'+{pending:"قيد المراجعة",approved:"المعتمدة",rejected:"المرفوضة",revoked:"الملغية"}[s]+'</button>'}).join("")+'</div>';
 if(!l.length)h+='<div class="card muted" style="text-align:center">ما فيه رخص</div>';
 l.forEach(function(x){h+='<div class="card"><div class="row sb"><b>🚗 '+esc(x.vehicle)+'</b>'+stBadge(x.status)+'</div><div class="muted">'+esc(x.owner)+' · هوية '+esc(x.civilId)+(x.number?' · رخصة '+esc(x.number):'')+' · '+dt(x.createdAt)+'</div>'+
  '<a href="/api/license/'+x.id+'/photo" target="_blank"><img class="thumb" loading="lazy" src="/api/license/'+x.id+'/photo" style="margin-top:8px"></a>'+
  (x.answers||[]).map(function(q){return '<div class="qa"><b>'+esc(q.q)+'</b><br>'+esc(q.a)+'</div>'}).join("")+
  (x.status==="pending"?'<div class="row" style="margin-top:10px"><button class="btn g sm" data-a="licOk" data-id="'+x.id+'">اعتماد</button><button class="btn r sm" data-a="licNo" data-id="'+x.id+'">رفض</button></div>':'')+
  (x.status==="approved"?'<div class="row" style="margin-top:10px"><button class="btn r sm" data-a="licRev" data-id="'+x.id+'">إلغاء الرخصة</button></div>':'')+'</div>'});main(h)})};
A.licFilter=function(d){LICST=d.s;show("lics")};
A.licOk=function(d){return api("/api/staff/licenses/"+d.id+"/approve",{}).then(function(r){toast("✅ اعتُمدت — المركبة: "+r.vehicle);show("lics")})};
A.licNo=function(d){return ask("سبب رفض الرخصة",[{id:"r",label:"السبب",type:"textarea"}],"رفض").then(function(v){if(!v||!v.r.trim())return;return api("/api/staff/licenses/"+d.id+"/reject",{reason:v.r}).then(function(){toast("تم الرفض");show("lics")})})};
A.licRev=function(d){return sure("إلغاء الرخصة؟").then(function(y){if(!y)return;return api("/api/staff/licenses/"+d.id+"/revoke",{}).then(function(){show("lics")})})};

/* ───── الإدارة: الأفراد ───── */
var PQ="",PK="";
V.people=function(){return api("/api/staff/people?q="+encodeURIComponent(PQ)+"&kind="+PK).then(function(l){return Promise.all([api("/api/senior/jobs"),api("/api/meta/ranks")]).then(function(x){window.__JOBS=x[0];window.__RANKS=x[1];
 var h='<div class="card"><div class="row"><input id="pq" placeholder="ابحث بالاسم / الهوية / الآيدي" value="'+esc(PQ)+'" style="flex:1"><select id="pk" style="width:110px"><option value="">الكل</option><option value="citizen"'+(PK==="citizen"?" selected":"")+'>مواطنين</option><option value="military"'+(PK==="military"?" selected":"")+'>عسكر</option></select><button class="btn" data-a="pSearch">بحث</button></div></div>';
 l.forEach(function(p){h+='<div class="card"><div class="row sb"><b>'+(p.kind==="military"?"🪖":"🪪")+' '+esc(p.name)+'</b><span>'+(p.suspended?'<span class="badge b-no">موقوف</span> ':'')+(p.isAdmin?'<span class="badge b-wait">إدارة</span> ':'')+(p.isSenior?'<span class="badge b-ok">كبار</span>':'')+'</span></div>'+
  '<div class="muted">'+esc(p.tag)+' · '+(p.kind==="citizen"?'هوية: <b>'+esc(p.civilId)+'</b> · وظيفة: '+esc(p.job||"-"):'رتبة: <b>'+esc(p.rank||"-")+'</b>')+'</div><div class="row" style="margin-top:8px">'+
  (p.kind==="citizen"?'<button class="btn sm" data-a="pId" data-u="'+p.uid+'" data-v="'+esc(p.civilId)+'">تعديل الهوية</button><button class="btn sm" data-a="pJob" data-u="'+p.uid+'" data-v="'+esc(p.job||"")+'">الوظيفة</button>':'<button class="btn sm" data-a="pRank" data-u="'+p.uid+'" data-v="'+esc(p.rank||"")+'">الرتبة</button>')+
  '<button class="btn gray sm" data-a="pSusp" data-u="'+p.uid+'" data-s="'+(p.suspended?"0":"1")+'">'+(p.suspended?"فك الإيقاف":"إيقاف")+'</button>'+
  (ME.senior?'<button class="btn gray sm" data-a="pAdm" data-u="'+p.uid+'" data-s="'+(p.isAdmin?"0":"1")+'">'+(p.isAdmin?"سحب الإدارة":"جعله إداري")+'</button>':'')+'</div></div>'});
 if(!l.length)h+='<div class="card muted" style="text-align:center">لا نتائج</div>';main(h);$("#pq").onkeydown=function(e){if(e.key==="Enter")A.pSearch()}})})};
A.pSearch=function(){PQ=$("#pq").value;PK=$("#pk").value;show("people")};
A.pId=function(d){return ask("تعديل رقم الهوية",[{id:"v",label:"الرقم الجديد (4 أو 5 أرقام)",value:d.v}],"حفظ").then(function(v){if(!v)return;return api("/api/staff/people/"+d.u+"/civil-id",{civilId:v.v}).then(function(){toast("✅ تم");show("people")})})};
A.pJob=function(d){var o=[{v:"",l:"— بدون وظيفة —"}].concat((window.__JOBS||[]).map(function(j){return {v:j.label,l:j.label}}));return ask("تعيين الوظيفة",[{id:"v",label:"الوظيفة",type:"select",options:o,value:d.v}],"حفظ").then(function(v){if(!v)return;return api("/api/senior/people/"+d.u+"/job",{job:v.v}).then(function(){toast("✅ تم");show("people")})})};
A.pRank=function(d){return ask("تعديل الرتبة",[{id:"v",label:"الرتبة",type:"select",options:window.__RANKS||[],value:d.v}],"حفظ").then(function(v){if(!v)return;return api("/api/senior/people/"+d.u+"/rank",{rank:v.v}).then(function(){toast("✅ تم");show("people")})})};
A.pSusp=function(d){return sure(d.s==="1"?"إيقاف هذا الحساب؟":"فك الإيقاف؟").then(function(y){if(!y)return;return api("/api/staff/people/"+d.u+"/suspend",{suspended:d.s==="1"}).then(function(){show("people")})})};
A.pAdm=function(d){return api("/api/senior/people/"+d.u+"/admin",{isAdmin:d.s==="1"}).then(function(){show("people")})};

/* ───── الإدارة: المخالفات ───── */
var FST="",FQ="";
V.sfines=function(){return api("/api/staff/fines?status="+FST+"&q="+encodeURIComponent(FQ)).then(function(l){
 var h='<div class="card"><div class="row"><input id="fq" placeholder="رقم الهوية أو الاسم" value="'+esc(FQ)+'" style="flex:1"><select id="fs" style="width:120px"><option value="">الكل</option><option value="unpaid"'+(FST==="unpaid"?" selected":"")+'>غير مسددة</option><option value="paid"'+(FST==="paid"?" selected":"")+'>مسددة</option><option value="cancelled"'+(FST==="cancelled"?" selected":"")+'>ملغاة</option></select><button class="btn" data-a="fSearch">بحث</button></div></div>';
 l.forEach(function(f){h+='<div class="card"><div class="row sb"><b>'+esc(f.type)+' — '+money(f.price)+'</b>'+stBadge(f.status)+'</div><div class="muted">'+esc(f.citizen)+' · هوية '+esc(f.civilId)+' · '+esc(f.vehicle||"-")+' · بواسطة '+esc(f.by)+' · '+dt(f.createdAt)+'</div>'+(f.status==="unpaid"?'<button class="btn r sm" style="margin-top:8px" data-a="fCancel" data-id="'+f.id+'">إلغاء المخالفة</button>':'')+'</div>'});
 if(!l.length)h+='<div class="card muted" style="text-align:center">لا نتائج</div>';main(h)})};
A.fSearch=function(){FQ=$("#fq").value;FST=$("#fs").value;show("sfines")};
A.fCancel=function(d){return ask("إلغاء المخالفة",[{id:"r",label:"السبب (اختياري)"}],"إلغاء").then(function(v){if(!v)return;return api("/api/staff/fines/"+d.id+"/cancel",{reason:v.r}).then(function(){show("sfines")})})};

/* ───── الإدارة: المركبات ───── */
V.veh=function(){return api("/api/staff/vehicles").then(function(l){
 var h='<div class="card"><div class="row sb"><div><h3 style="margin:0">🚗 دليل المركبات</h3><div class="muted">نفس السيارة بكتابات مختلفة تنحسب سيارة وحدة، والأقدم تفوز</div></div><button class="btn" data-a="dedupe">دمج المكرر</button></div></div>';
 l.forEach(function(v){h+='<div class="card"><div class="row sb"><b>'+esc(v.name)+'</b><span class="badge b-gray">'+v.licenses+' رخصة</span></div>'+(v.aliases.length?'<div class="muted">كتابات مشابهة: '+v.aliases.map(esc).join("، ")+'</div>':'')+(ME.senior?'<button class="btn gray sm" style="margin-top:8px" data-a="vRename" data-id="'+v.id+'" data-v="'+esc(v.name)+'">تعديل الاسم الصحيح</button>':'')+'</div>'});
 if(!l.length)h+='<div class="card muted" style="text-align:center">ما فيه مركبات بعد</div>';main(h)})};
A.dedupe=function(){return api("/api/staff/vehicles/dedupe",{}).then(function(r){toast(r.merged?"✅ تم دمج "+r.merged+" مركبة":"ما فيه مكرر");show("veh")})};
A.vRename=function(d){return ask("الاسم الصحيح للمركبة",[{id:"n",label:"الاسم",value:d.v}],"حفظ").then(function(v){if(!v)return;return api("/api/senior/vehicles/"+d.id+"/rename",{name:v.n}).then(function(){show("veh")})})};

/* ───── الكبار: الأسعار ───── */
V.types=function(){return api("/api/senior/types").then(function(l){
 var h='<div class="card"><div class="row sb"><div><h3 style="margin:0">💲 أسعار المخالفات</h3><div class="muted">السعر اللي تحطه يتحمّله المواطن عند التسجيل</div></div><button class="btn g" data-a="tAdd">+ مخالفة</button></div></div>';
 l.forEach(function(t){h+='<div class="card"><div class="row sb"><b>'+esc(t.label)+'</b>'+(t.active?'<span class="badge b-ok">فعّالة</span>':'<span class="badge b-gray">موقوفة</span>')+'</div><div class="row" style="margin-top:8px"><input type="number" min="0" id="tp_'+t._id+'" value="'+t.price+'" style="flex:1"><button class="btn sm" data-a="tSave" data-id="'+t._id+'">حفظ السعر</button><button class="btn gray sm" data-a="tTog" data-id="'+t._id+'" data-s="'+(t.active?"0":"1")+'">'+(t.active?"إيقاف":"تفعيل")+'</button></div></div>'});main(h)})};
A.tSave=function(d){return api("/api/senior/types/"+d.id,{price:$("#tp_"+d.id).value}).then(function(){toast("✅ تم حفظ السعر")})};
A.tTog=function(d){return api("/api/senior/types/"+d.id,{active:d.s==="1"}).then(function(){show("types")})};
A.tAdd=function(){return ask("مخالفة جديدة",[{id:"l",label:"اسم المخالفة"},{id:"p",label:"السعر",type:"number"}],"إضافة").then(function(v){if(!v)return;return api("/api/senior/types",{label:v.l,price:v.p}).then(function(){show("types")})})};

/* ───── الكبار: الوظائف ───── */
V.jobs=function(){return api("/api/senior/jobs").then(function(l){
 var h='<div class="card"><div class="row sb"><div><h3 style="margin:0">💼 الوظائف</h3><div class="muted">الرواتب تنحدد من البنك لكل وظيفة. الوظيفة تنعيّن من تاب «الأفراد».</div></div><button class="btn g" data-a="jAdd">+ وظيفة</button></div></div>';
 l.forEach(function(j){h+='<div class="card row sb"><b>'+esc(j.label)+'</b><button class="btn r sm" data-a="jDel" data-id="'+j._id+'">حذف</button></div>'});
 if(!l.length)h+='<div class="card muted" style="text-align:center">ما أضفت وظائف بعد</div>';main(h)})};
A.jAdd=function(){return ask("وظيفة جديدة",[{id:"l",label:"اسم الوظيفة"}],"إضافة").then(function(v){if(!v)return;return api("/api/senior/jobs",{label:v.l}).then(function(){show("jobs")})})};
A.jDel=function(d){return sure("حذف الوظيفة؟ بتنسحب من كل اللي معيّنين عليها.").then(function(y){if(!y)return;return api("/api/senior/jobs/"+d.id+"/delete",{}).then(function(){show("jobs")})})};

/* ───── الكبار: الإعدادات والسجل ───── */
V.set=function(){return api("/api/senior/settings").then(function(s){
 main('<div class="card"><h3>⚙️ الإعدادات</h3><label class="f">خانات رقم الهوية المدنية (للهويات الجديدة)</label><select id="st_d"><option value="4"'+(s.civilIdDigits===4?" selected":"")+'>4 أرقام</option><option value="5"'+(s.civilIdDigits===5?" selected":"")+'>5 أرقام</option></select>'+
 '<label class="f">وضع الصيانة</label><select id="st_m"><option value="0"'+(!s.maintenance?" selected":"")+'>مغلق</option><option value="1"'+(s.maintenance?" selected":"")+'>مفعّل (الإدارة تدخل فقط)</option></select><button class="btn g" data-a="stSave" style="margin-top:14px">حفظ</button></div>')})};
A.stSave=function(){return api("/api/senior/settings",{civilIdDigits:Number($("#st_d").value),maintenance:$("#st_m").value==="1"}).then(function(){toast("✅ تم الحفظ")})};
V.logs=function(){return api("/api/senior/logs").then(function(l){var h='<div class="card"><h3>📜 آخر العمليات</h3></div>';
 l.forEach(function(x){h+='<div class="card" style="padding:10px"><b>'+esc(x.action)+'</b> <span class="muted">— '+esc(x.actorName||"")+' · '+new Date(x.at).toLocaleString("ar-SA")+'</span>'+(x.details?'<div class="muted">'+esc(x.details)+'</div>':'')+'</div>'});main(h)})};

/* ───── تشغيل ───── */
api("/api/me").then(function(m){
 if(!m.loggedIn){loginView();return}
 if(m.blocked){$("#app").innerHTML='<div class="login"><div class="card" style="text-align:center"><div style="font-size:40px">🚫</div><p style="margin:10px 0">'+esc(m.reason)+'</p><a class="btn gray" href="/auth/logout" style="text-decoration:none;display:inline-block">خروج</a></div></div>';return}
 ME=m;shell()}).catch(function(){loginView()});
</script></body></html>`;

// ───────────────────────── الربط ببنك فلاش ─────────────────────────
function ensureBankKey(req, res, next) {
    const k = CONFIG.INTERNAL_API_KEY;
    if (!k) return res.status(503).json({ success: false, msg: "INTERNAL_API_KEY غير مضبوط على موقع فلاش" });
    const got = Buffer.from(String(req.get("x-internal-key") || "")), want = Buffer.from(k);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return res.status(403).json({ success: false, msg: "غير مصرح" });
    next();
}
function bankSign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return body + "." + crypto.createHmac("sha256", CONFIG.INTERNAL_API_KEY).update(body).digest("base64url");
}
app.get("/api/bank/sso", loadAuth, wrap(async (req, res) => {
    if (!CONFIG.INTERNAL_API_KEY || !CONFIG.BANK_URL) return res.status(503).json({ error: "البنك غير مربوط بعد — اضبط INTERNAL_API_KEY و BANK_URL" });
    const a = req.acc;
    const token = bankSign({ uid: a.uid, name: a.fullName, rank: a.kind === "citizen" ? (a.job || "") : (a.rank || ""), unit: kindLabel(a.kind), senior: req.role.senior, owner: req.role.owner, exp: Date.now() + 60000, n: crypto.randomBytes(12).toString("hex") });
    res.json({ ok: true, url: "/bank/sso?t=" + encodeURIComponent(token) });
}));
function bankProxyToken() { return crypto.createHmac("sha256", CONFIG.INTERNAL_API_KEY).update("flash-proxy-v1").digest("hex"); }
function bankWakePage() {
    return '<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>بنك فلاش</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a1628;color:#e2e8f0;font-family:Tajawal,Tahoma,sans-serif;text-align:center}</style></head><body><div><div style="font-size:42px">🏦</div><p>⚡ جاري تشغيل الاستضافة... ثواني</p></div><script>setTimeout(function(){location.reload()},4000)</script></body></html>';
}
// البنك يظهر داخل فلاش على المسار /bank (يمرّر الطلبات من السيرفر، وكوكي البنك بس)
app.all(/^\/bank(?:\/(.*))?$/, wrap(async (req, res) => {
    const isApi = /^\/bank\/api\//.test(req.path);
    if (!(req.session && req.session.uid)) return isApi ? res.status(401).json({ success: false, msg: "سجّل دخولك في فلاش أولاً" }) : res.redirect("/");
    if (!CONFIG.INTERNAL_API_KEY || !CONFIG.BANK_URL) return res.status(503).send("البنك غير مربوط بعد");
    const sub = "/" + String(req.params[0] || "");
    if (/^\/(api\/flash|auth)(\/|$)/.test(sub)) return res.status(403).json({ success: false, msg: "غير مصرح" });
    const qi = req.originalUrl.indexOf("?"), qs = qi >= 0 ? req.originalUrl.slice(qi) : "";
    const headers = { "x-flash-proxy": bankProxyToken(), "x-forwarded-prefix": "/bank", accept: req.get("accept") || "*/*", "accept-language": "ar", "user-agent": req.get("user-agent") || "flash" };
    const m = /(?:^|;\s*)bank_session=([^;]*)/.exec(req.headers.cookie || ""); if (m) headers.cookie = "bank_session=" + m[1];
    let body; if (req.method !== "GET" && req.method !== "HEAD" && /json/i.test(req.get("content-type") || "")) { body = JSON.stringify(req.body || {}); headers["content-type"] = "application/json"; }
    try {
        const r = await fetch(CONFIG.BANK_URL + sub + qs, { method: req.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(25000) });
        if ([502, 503, 504].includes(r.status) && !isApi && req.method === "GET") return res.status(200).set("Cache-Control", "no-store").type("html").send(bankWakePage());
        res.status(r.status); const ct = r.headers.get("content-type"); if (ct) res.set("Content-Type", ct); res.set("Cache-Control", "no-store");
        const loc = r.headers.get("location");
        if (loc) res.set("Location", loc.indexOf(CONFIG.BANK_URL) === 0 ? "/bank" + loc.slice(CONFIG.BANK_URL.length) : (loc.charAt(0) === "/" && loc.indexOf("/bank") !== 0 ? "/bank" + loc : loc));
        const sc = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : (r.headers.get("set-cookie") ? [r.headers.get("set-cookie")] : []);
        if (sc.length) res.append("Set-Cookie", sc.map(c => c.replace(/;\s*Path=[^;]*/i, "").replace(/;\s*Domain=[^;]*/i, "") + "; Path=/bank"));
        res.send(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
        if (isApi) return res.status(502).json({ success: false, msg: "البنك يشتغل الحين، جرّب بعد ثواني" });
        if (req.method === "GET") return res.status(200).set("Cache-Control", "no-store").type("html").send(bankWakePage());
        res.status(502).send("البنك يشتغل الحين، جرّب بعد ثواني");
    }
}));
app.get("/api/bank/status", loadAuth, wrap(async (req, res) => {
    try { const r = await fetch(CONFIG.BANK_URL + "/healthz", { signal: AbortSignal.timeout(9000) }); res.json({ up: r.status < 500 }); } catch (e) { res.json({ up: false }); }
}));
// ── واجهات يستخدمها البنك (بمفتاح سرّي) ──
// الوظائف تنعامل في البنك مثل «الرتب» القديمة: جدول رواتب لكل وظيفة. العسكر ما لهم رواتب.
app.get("/api/bank/ranks", ensureBankKey, wrap(async (req, res) => { res.json({ success: true, ranks: (await Job.find().sort({ sort: 1, label: 1 }).lean()).map(j => j.label) }); }));
app.get("/api/bank/personnel-ranks", ensureBankKey, wrap(async (req, res) => {
    const list = await Account.find({ status: "approved", kind: "citizen", suspended: false, job: { $ne: null } }, { uid: 1, discordTag: 1, job: 1, fullName: 1 }).lean();
    res.json({ success: true, personnel: list.map(p => ({ discord: p.uid, discordTag: p.discordTag, rank: p.job, registeredName: p.fullName })) });
}));
app.get("/api/bank/member-card", ensureBankKey, wrap(async (req, res) => {
    const uid = String(req.query.uid || ""); if (!UID_RE.test(uid)) return res.json({ success: false, msg: "آيدي غير صالح" });
    const a = await Account.findOne({ uid, status: "approved" }).lean();
    if (!a) return res.json({ success: true, found: false });
    res.json({ success: true, found: true, kind: a.kind, name: a.fullName, cardNumber: a.civilId || "", civilId: a.civilId || "", rank: a.kind === "citizen" ? (a.job || "") : (a.rank || ""), job: a.job || "", unit: "", sector: kindLabel(a.kind), points: 0, revoked: !!a.suspended, blocked: !!a.suspended });
}));
app.post("/api/bank/notify", ensureBankKey, wrap(async (req, res) => {
    const b = req.body || {}; const uid = String(b.uid || ""), body = clip(b.body, 300);
    if (!UID_RE.test(uid) || !body) return res.json({ success: false, msg: "بيانات ناقصة" });
    const ok = await dm(uid, "**" + clip(b.title || "🏦 بنك فلاش", 80) + "**\n" + body); res.json({ success: ok });
}));

// ───────────────────────── الواجهة ─────────────────────────
app.get("/", (req, res) => res.set("Cache-Control", "no-store").type("html").send(PAGE_HTML));
app.use((req, res) => res.status(404).json({ error: "غير موجود" }));

async function bootstrap() {
    try {
        await getSettings();
        if (!(await ViolationType.countDocuments())) await ViolationType.insertMany(DEFAULT_VIOLATIONS.map((v, i) => ({ key: v[0], label: v[1], price: v[2], sort: i })));
        const merged = await dedupeVehicles(); if (merged) console.log("🚗 تم دمج " + merged + " مركبة مكررة");
    } catch (e) { console.error("❌ bootstrap:", e.message); }
}
process.on("unhandledRejection", (e) => console.error("⚠️ unhandledRejection:", e && e.message));
app.listen(CONFIG.PORT, "0.0.0.0", () => console.log("🚀 فلاش (مواطنين + عسكر) شغّال على المنفذ " + CONFIG.PORT));
