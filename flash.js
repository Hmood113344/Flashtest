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
    tmpPass: { type: String, default: null },        // مشفّرة (يكتبها البوت)، تنحذف بعد القبول/الرفض
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
    sector: { type: String, default: null, index: true },   // قطاع العسكري (يديره الكبار)
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
    // رسالة القبول (إمبد فيه الإيميل وكلمة المرور) يبنيها البوت
    await BotJob.create({ type: "welcome", uid }).catch(() => {});
    await logEvent({ action: "قبول تقديم", actor: by.id, actorName: by.tag, target: uid, details: a.kind });
    return { ok: true, account: a };
}
async function rejectAccount(uid, by, reason) {
    const a = await Account.findOne({ uid });
    if (!a) return { ok: false, msg: "الطلب غير موجود" };
    if (a.status !== "pending") return { ok: false, msg: "الطلب تمت مراجعته من قبل" };
    a.status = "rejected"; a.rejectReason = clip(reason, 500); a.reviewedBy = by.id; a.reviewedByTag = by.tag; a.reviewedAt = new Date(); a.tmpPass = null;
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
    const sec = await sectorRoleOf(uid);
    res.json({ loggedIn: true, sector: a.sector || null, sec, canWarn: r.admin || !!sec, canCert: r.admin || !!(sec && (sec.role === "commander" || sec.role === "deputy")), uid, kind: a.kind, name: a.fullName, rank: a.rank, civilId: a.civilId, job: a.job, age: a.age, createdAt: a.createdAt, senior: r.senior, admin: r.admin, owner: r.owner, bank: !!(CONFIG.INTERNAL_API_KEY && CONFIG.BANK_URL) });
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
    await notify(c.uid, "🚨 مخالفة جديدة", t.label + " — " + t.price + " (" + vehicle + ")", "alert", "#fines");
    res.json({ ok: true, fine: fineOut(f) });
}));
app.get("/api/mil/my", loadAuth, needMilitary, wrap(async (req, res) => {
    res.json((await Fine.find({ byUid: req.acc.uid }).sort({ createdAt: -1 }).limit(80).lean()).map(fineOut));
}));

// ── الإدارة والكبار ──
app.get("/api/staff/applications", loadAuth, needStaff, wrap(async (req, res) => {
    const st = ["pending", "approved", "rejected"].includes(req.query.status) ? req.query.status : "pending";
    const list = await Account.find({ status: st }, { passwordHash: 0, tmpPass: 0 }).sort({ createdAt: -1 }).limit(100).lean();
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
    await notify(l.ownerUid, "✅ تم اعتماد رخصتك", "المركبة: " + v.name, "success", "#id");
    await logEvent({ action: "اعتماد رخصة", actor: req.acc.uid, actorName: req.acc.fullName, target: l.ownerUid, details: v.name });
    res.json({ ok: true, vehicle: v.name });
}));
app.post("/api/staff/licenses/:id/reject", loadAuth, needStaff, wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "معرّف غير صالح" });
    const reason = clip((req.body || {}).reason, 300); if (!reason) return res.status(400).json({ error: "اكتب سبب الرفض" });
    const l = await License.findOneAndUpdate({ _id: req.params.id, status: "pending" }, { $set: { status: "rejected", rejectReason: reason, reviewedBy: req.acc.uid, reviewedByTag: req.acc.fullName, reviewedAt: new Date() } }, { new: true, projection: { photo: 0 } });
    if (!l) return res.status(400).json({ error: "الطلب تمت مراجعته" });
    await dm(l.ownerUid, "❌ **تم رفض طلب رخصتك**\nالسبب: " + reason);
    await notify(l.ownerUid, "❌ تم رفض طلب رخصتك", "السبب: " + reason, "warning", "#id"); res.json({ ok: true });
}));
app.post("/api/staff/licenses/:id/revoke", loadAuth, needStaff, wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "معرّف غير صالح" });
    const lc = await License.findOneAndUpdate({ _id: req.params.id, status: "approved" }, { $set: { status: "revoked", reviewedBy: req.acc.uid, reviewedByTag: req.acc.fullName, reviewedAt: new Date() } }, { projection: { ownerUid: 1, vehicleName: 1 } });
    if (lc) await notify(lc.ownerUid, "🚗 إلغاء رخصة", "تم إلغاء رخصتك للمركبة: " + lc.vehicleName, "warning", "#id");
    res.json({ ok: !!lc });
}));

app.get("/api/staff/people", loadAuth, needStaff, wrap(async (req, res) => {
    const q = clip(req.query.q, 40); const f = { status: "approved" };
    if (["citizen", "military"].includes(req.query.kind)) f.kind = req.query.kind;
    if (q) { const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); f.$or = [{ fullName: rx }, { civilId: rx }, { uid: rx }, { discordTag: rx }]; }
    const list = await Account.find(f, { passwordHash: 0, tmpPass: 0, answers: 0 }).sort({ createdAt: -1 }).limit(60).lean();
    res.json(list.map(a => ({ uid: a.uid, tag: a.discordTag, kind: a.kind, name: a.fullName, civilId: a.civilId, job: a.job, rank: a.rank, isAdmin: a.isAdmin, isSenior: a.isSenior, suspended: a.suspended, sector: a.sector || null })));
}));
app.post("/api/staff/people/:uid/civil-id", loadAuth, needStaff, wrap(async (req, res) => {
    const id = arNum(clip((req.body || {}).civilId, 8)); if (!/^\d{4,5}$/.test(id)) return res.status(400).json({ error: "رقم الهوية 4 أو 5 أرقام فقط" });
    const a = await Account.findOne({ uid: req.params.uid, kind: "citizen" }); if (!a) return res.status(404).json({ error: "المواطن غير موجود" });
    if (await Account.exists({ civilId: id, uid: { $ne: a.uid } })) return res.status(400).json({ error: "الرقم مستخدم عند مواطن ثاني" });
    const old = a.civilId; a.civilId = id; await a.save();
    await License.updateMany({ ownerUid: a.uid }, { $set: { civilId: id } }); await Fine.updateMany({ citizenUid: a.uid }, { $set: { civilId: id } });
    await notify(a.uid, "🪪 تحديث الهوية", "رقم هويتك الجديد: " + id, "info", "#id");
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
    const fc = await Fine.findOneAndUpdate({ _id: req.params.id, status: "unpaid" }, { $set: { status: "cancelled", cancelledBy: req.acc.fullName, cancelReason: clip((req.body || {}).reason, 200) } }, { projection: { citizenUid: 1, typeLabel: 1 } });
    if (fc) await notify(fc.citizenUid, "✅ إلغاء مخالفة", "تم إلغاء مخالفة: " + fc.typeLabel, "success", "#fines");
    res.json({ ok: !!fc, error: fc ? undefined : "المخالفة مو غير مسددة" });
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
    if (job) { dm(a.uid, "💼 تم تعيينك في وظيفة: **" + job + "**"); await notify(a.uid, "💼 وظيفة جديدة", "تم تعيينك في وظيفة: " + job, "success", "#id"); } res.json({ ok: true });
}));
app.post("/api/senior/people/:uid/rank", loadAuth, needStaff, wrap(async (req, res) => {
    const rank = clip((req.body || {}).rank, 30); if (!CONFIG.MILITARY_RANKS.includes(rank)) return res.status(400).json({ error: "رتبة غير صحيحة" });
    const a = await Account.findOneAndUpdate({ uid: req.params.uid, kind: "military" }, { $set: { rank } }); if (!a) return res.status(404).json({ error: "العسكري غير موجود" });
    await logEvent({ action: "تعديل رتبة", actor: req.acc.uid, actorName: req.acc.fullName, target: a.uid, details: a.rank + " → " + rank });
    await notify(a.uid, "🎖️ تعديل الرتبة", "رتبتك الجديدة: " + rank, "success", null); res.json({ ok: true });
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
<meta name="apple-mobile-web-app-capable" content="no"><meta name="mobile-web-app-capable" content="no">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Cpath fill='%233b82f6' d='M58 8 L26 55 L46 55 L40 92 L74 42 L54 42 L64 8 Z'/%3E%3C/svg%3E">
<script>try{if("serviceWorker" in navigator){navigator.serviceWorker.getRegistrations().then(function(rs){rs.forEach(function(r){r.unregister()})}).catch(function(){})}if(window.caches){caches.keys().then(function(ks){ks.forEach(function(k){caches.delete(k)})}).catch(function(){})}}catch(e){}</script>
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
/* ═══ تصميم app.js: سبلاش + تنبيه علوي + قائمة همبرغر + إشعارات ═══ */
:root{--bh:0px}
html.fl-splash-on,html.fl-splash-on body{overflow:hidden}
#fl-splash{position:fixed;inset:0;z-index:2147483000;background:radial-gradient(circle at 50% 42%,#12305e 0%,#0a1628 62%);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;transition:opacity .45s}
#fl-splash.out{opacity:0;pointer-events:none}
#fl-splash svg{width:120px;height:120px;filter:drop-shadow(0 0 22px rgba(59,130,246,.55))}
#fl-splash path{fill:url(#flSplashG);fill-opacity:0;stroke:#60a5fa;stroke-width:1.6;stroke-linejoin:round;stroke-dasharray:1;stroke-dashoffset:1;animation:flDraw .7s ease-out forwards,flFill .5s .65s ease-out forwards}
#fl-splash .fl-name{font-size:34px;font-weight:800;letter-spacing:.5px;color:#e2e8f0;opacity:0;animation:flFade .4s .75s forwards}
@keyframes flDraw{to{stroke-dashoffset:0}}@keyframes flFill{to{fill-opacity:1;stroke-opacity:0}}@keyframes flFade{to{opacity:1}}
@media (prefers-reduced-motion:reduce){#fl-splash path{animation:none;stroke-dashoffset:0;fill-opacity:1;stroke-opacity:0}#fl-splash .fl-name{animation:none;opacity:1}#fl-splash{transition:none}}
#warn-banner{position:sticky;top:0;z-index:1000;width:100%;background:linear-gradient(90deg,#7f1d1d,#991b1b);color:#fecaca;text-align:center;padding:8px 12px;font-weight:700;font-size:12.5px;line-height:1.4}
nav{top:var(--bh);z-index:900;padding:0 1.2rem;height:62px}
.navr{display:flex;align-items:center;gap:8px}
.hamburger-btn{display:inline-block;background:rgba(59,130,246,.15);border:1px solid #3b82f6;color:#60a5fa;padding:.4rem .7rem;border-radius:8px;cursor:pointer;font-size:1.2rem;line-height:1.1}
.bell{position:relative;background:rgba(59,130,246,.15);border:1px solid #3b82f6;color:#60a5fa;padding:.4rem .6rem;border-radius:8px;cursor:pointer;font-size:1.05rem;line-height:1.1}
.bell i{position:absolute;top:-7px;left:-7px;min-width:18px;height:18px;padding:0 4px;border-radius:99px;background:#ef4444;color:#fff;font-size:11px;font-style:normal;font-weight:800;display:none;align-items:center;justify-content:center}
.bell i.on{display:flex}
.mobile-menu{display:none;position:fixed;top:calc(var(--bh) + 62px);left:0;width:min(260px,82vw);background:rgba(5,15,30,.98);border:1px solid rgba(59,130,246,.35);border-radius:0 0 14px 0;z-index:950;padding:8px 0;box-shadow:4px 8px 30px rgba(0,0,0,.7);max-height:calc(100vh - 130px);max-height:calc(100dvh - 130px);overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
.mobile-menu.open{display:block}
#menu-backdrop{display:none;position:fixed;inset:0;z-index:940;background:rgba(0,0,0,.35)}
html.menu-open,html.menu-open body{overflow:hidden}html.menu-open #menu-backdrop{display:block}
.mm-h{padding:10px 20px 12px;border-bottom:1px solid rgba(59,130,246,.2);margin-bottom:4px}.mm-h b{display:block;color:#e2e8f0}.mm-h span{font-size:12px;color:var(--muted)}
.mi{display:flex;justify-content:space-between;align-items:center;width:100%;background:transparent;border:none;border-bottom:1px solid rgba(59,130,246,.08);color:#94a3b8;padding:12px 20px;text-align:right;font-family:inherit;font-size:.92rem;cursor:pointer}
.mi:hover,.mi.on{background:rgba(59,130,246,.18);color:#60a5fa}
.mb{min-width:20px;height:20px;padding:0 6px;border-radius:99px;background:#ef4444;color:#fff;font-size:11px;font-weight:800;display:none;align-items:center;justify-content:center}.mb.on{display:inline-flex}
.mm-f{padding:10px 20px}
/* إشعارات (توست تحت يمين + نافذة إنذار) */
#fn-wrap{position:fixed;right:14px;bottom:calc(14px + env(safe-area-inset-bottom,0px));z-index:7600;display:flex;flex-direction:column;gap:8px;align-items:flex-end;pointer-events:none}
.fn-toast{--c:#3b82f6;pointer-events:auto;cursor:pointer;position:relative;overflow:hidden;width:min(310px,calc(100vw - 28px));background:#07162b;border:1px solid var(--c);border-right-width:4px;border-radius:12px;padding:10px 12px 13px;box-shadow:0 10px 30px rgba(0,0,0,.55);animation:fnIn .3s cubic-bezier(.2,.9,.3,1.2);transition:opacity .25s,transform .25s;direction:rtl}
.fn-toast.out{opacity:0;transform:translateX(40px)}
.fn-info{--c:#3b82f6;background:linear-gradient(135deg,#07162b,#0b2447)}.fn-success{--c:#22c55e;background:linear-gradient(135deg,#07162b,#0a2a1c)}.fn-warning{--c:#f97316;background:linear-gradient(135deg,#07162b,#2e1606)}
.fn-title{font-size:.78rem;font-weight:800;color:var(--c);margin-bottom:3px}
.fn-text{font-size:.84rem;color:#e2e8f0;line-height:1.6;word-break:break-word;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.fn-bar{position:absolute;left:0;right:0;bottom:0;height:3px;background:rgba(255,255,255,.08)}
.fn-bar i{display:block;height:100%;width:100%;background:var(--c);transform-origin:right center;animation:fnBar 6s linear forwards}
@keyframes fnIn{from{opacity:0;transform:translateX(40px)}to{opacity:1;transform:none}}@keyframes fnBar{to{transform:scaleX(0)}}
#box.alert{border-color:#ef4444;background:linear-gradient(160deg,#2a0d0d,#0a1628)}#box.alert h3{color:#fca5a5}
.ntf{cursor:pointer;border-right:4px solid #3b82f6}.ntf.unread{background:rgba(59,130,246,.1)}.ntf.k-success{border-right-color:#22c55e}.ntf.k-warning{border-right-color:#f97316}.ntf.k-alert{border-right-color:#ef4444}
.chat{max-height:55vh;overflow-y:auto;display:flex;flex-direction:column;gap:8px}
.msg{max-width:88%;padding:8px 11px;border-radius:12px;background:rgba(255,255,255,.06);align-self:flex-start}.msg.us{background:rgba(59,130,246,.2);align-self:flex-end}.msg.st{background:rgba(34,197,94,.14);border:1px solid rgba(34,197,94,.3)}
.msg .mh{font-size:11px;color:var(--muted);margin-bottom:3px}.msg .mt{white-space:pre-wrap;word-break:break-word;font-size:14px;line-height:1.6}
.rolerow{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px;padding:8px 10px;background:rgba(0,0,0,.18);border-radius:10px;flex-wrap:wrap}
.nobar{display:none}
</style></head><body>
<div id="fl-splash"><svg viewBox="0 0 100 100" aria-hidden="true"><defs><linearGradient id="flSplashG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#60a5fa"/><stop offset="1" stop-color="#1d4ed8"/></linearGradient></defs><path pathLength="1" d="M58 8 L26 55 L46 55 L40 92 L74 42 L54 42 L64 8 Z"/></svg><div class="fl-name">فلاش</div></div>
<script>(function(){var d=document.documentElement;d.classList.add("fl-splash-on");setTimeout(function(){var s=document.getElementById("fl-splash");if(!s){d.classList.remove("fl-splash-on");return}s.classList.add("out");setTimeout(function(){s.remove();d.classList.remove("fl-splash-on")},450)},1800)})();</script>
<div id="warn-banner">⚠️ تنبيه: هذا الموقع مخصص للمحاكاة واللعب فقط، ولا يمت للواقع بصلة.</div>
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
function openBox(h){$("#box").innerHTML=h;$("#ov").classList.add("open")}function closeBox(){$("#ov").classList.remove("open");$("#box").classList.remove("alert")}
$("#ov").addEventListener("click",function(e){if(e.target.id==="ov"&&!$("#box").classList.contains("alert"))closeBox()});
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
 if(ME.kind==="military"||ME.admin||ME.sec)TABS.push(["sectors","🎖️ القطاعات"]);
 TABS.push(["record","🗂️ ملفي الإداري"],["tickets","🎫 خدمة العملاء"],["notifs","🔔 الإشعارات"]);
 if(ME.canCert)TABS.push(["certs","🏅 إصدار شهادة"]);
 if(ME.admin)TABS.push(["apps","📥 الطلبات"],["lics","📄 الرخص"],["people","👥 الأفراد"],["sfines","🧾 المخالفات"],["veh","🚗 المركبات"],["stickets","🎫 التذاكر"]);
 if(ME.senior)TABS.push(["types","💲 الأسعار"],["jobs","💼 الوظائف"],["bc","📣 إشعار عام"],["set","⚙️ الإعدادات"],["logs","📜 السجل"]);
 $("#app").innerHTML='<nav><div class="logo">'+LOGO+'فلاش</div><div class="navr"><button class="bell" data-a="goNotifs" aria-label="الإشعارات">🔔<i id="bellN"></i></button><button class="hamburger-btn" data-a="menu" aria-label="القائمة">☰</button></div></nav>'+
  '<div id="menu-backdrop" data-a="menuClose"></div><div class="mobile-menu" id="mobile-menu"><div class="mm-h"><b>'+esc(ME.name)+'</b><span>'+kindL+(ME.senior?" · كبار المسؤولين":ME.admin?" · إدارة":"")+(ME.sec?" · "+esc(ME.sec.roleLabel):"")+'</span></div>'+
  TABS.map(function(t){return '<button class="mi" data-tab="'+t[0]+'">'+esc(t[1])+'<span class="mb" id="mb_'+t[0]+'"></span></button>'}).join("")+
  '<div class="mm-f"><a class="btn gray sm" href="/auth/logout" style="text-decoration:none;display:block;text-align:center">تسجيل الخروج</a></div></div><div class="wrap" id="main"></div>';
 $("#mobile-menu").onclick=function(e){var b=e.target.closest("[data-tab]");if(b){menuClose();show(b.dataset.tab)}};
 setBh();
 show((location.hash||"").slice(1)&&TABS.some(function(t){return t[0]===location.hash.slice(1)})?location.hash.slice(1):TABS[0][0])}
function show(id){TAB=id;if(TK_TIMER){clearInterval(TK_TIMER);TK_TIMER=null}TK_CUR=null;history.replaceState(null,"","#"+id);document.querySelectorAll(".mi").forEach(function(b){b.classList.toggle("on",b.dataset.tab===id)});
 $("#main").innerHTML='<div class="muted" style="text-align:center;padding:30px">⏳ جاري التحميل...</div>';window.scrollTo(0,0);
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
  '<button class="btn gray sm" data-a="pSusp" data-u="'+p.uid+'" data-s="'+(p.suspended?"0":"1")+'">'+(p.suspended?"فك الإيقاف":"إيقاف")+'</button>'+'<button class="btn gray sm" data-a="warnTo" data-u="'+p.uid+'">⚠️ تحذير</button><button class="btn gray sm" data-a="noteTo" data-u="'+p.uid+'">📝 ملاحظة</button><button class="btn gray sm" data-a="certTo" data-u="'+p.uid+'">📜 شهادة</button><button class="btn gray sm" data-a="recOf" data-u="'+p.uid+'">📂 ملفه</button>'+(ME.senior&&p.kind==="military"?'<button class="btn gray sm" data-a="pSec" data-u="'+p.uid+'" data-s="'+esc(p.sector||"")+'">🎖️ القطاع</button>':"")+
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

/* ═══════════ ميزات منقولة من app.js: إشعارات / خدمة عملاء / قطاعات / شهادات / تحذيرات / ملاحظات ═══════════ */
function ago(d){var s=(Date.now()-new Date(d).getTime())/1000;if(s<60)return "الحين";if(s<3600)return "قبل "+Math.floor(s/60)+" د";if(s<86400)return "قبل "+Math.floor(s/3600)+" س";return dt(d)}
function copyText(t){try{if(navigator.clipboard&&navigator.clipboard.writeText){return navigator.clipboard.writeText(t).then(function(){toast("✅ تم النسخ")},function(){window.prompt("انسخ الرابط:",t)})}}catch(e){}window.prompt("انسخ الرابط:",t)}
function pickPerson(title,kind){return new Promise(function(res){
 openBox('<h3>'+esc(title)+'</h3><div class="row"><input id="pp_q" placeholder="اكتب اسم أو آيدي (حرفين أو أكثر)" style="flex:1"><button class="btn" id="pp_b">بحث</button></div><div id="pp_r" style="margin-top:8px"></div><div class="row" style="margin-top:10px"><button class="btn gray" id="pp_x">إلغاء</button></div>');
 function go(){var q=$("#pp_q").value.trim();if(q.length<2)return;api("/api/people/search?q="+encodeURIComponent(q)+(kind?"&kind="+kind:"")).then(function(l){window.__PP=l;
  $("#pp_r").innerHTML=l.length?l.map(function(p,i){return '<div class="card row sb" style="margin:6px 0;cursor:pointer" data-pp="'+i+'"><span><b>'+(p.kind==="military"?"🪖 ":"🪪 ")+esc(p.name)+'</b><div class="muted">'+esc(p.rank||"-")+'</div></span><span class="badge b-gray">اختيار</span></div>'}).join(""):'<div class="muted" style="text-align:center">لا نتائج</div>'}).catch(fail)}
 $("#pp_b").onclick=go;$("#pp_q").onkeydown=function(e){if(e.key==="Enter")go()};
 $("#pp_r").onclick=function(e){var c=e.target.closest("[data-pp]");if(!c)return;var p=window.__PP[Number(c.dataset.pp)];closeBox();res(p)};
 $("#pp_x").onclick=function(){closeBox();res(null)};$("#pp_q").focus()})}

/* ───── القائمة الجانبية (همبرغر) ───── */
function menuOpen(){var m=$("#mobile-menu");if(!m)return;if(m.classList.contains("open")){menuClose();return}m.classList.add("open");m.scrollTop=0;document.documentElement.classList.add("menu-open")}
function menuClose(){var m=$("#mobile-menu");if(m)m.classList.remove("open");document.documentElement.classList.remove("menu-open")}
A.menu=function(){menuOpen()};A.menuClose=function(){menuClose()};
function setBh(){var b=$("#warn-banner");document.documentElement.style.setProperty("--bh",(b?b.offsetHeight:0)+"px")}
window.addEventListener("resize",setBh);

/* ───── الإشعارات داخل الموقع ───── */
var ALERTQ=[],ALERTING=false;
function updBadge(n){var b=$("#bellN");if(b){b.textContent=n>99?"99+":n;b.classList.toggle("on",n>0)}var m=$("#mb_notifs");if(m){m.textContent=n>99?"99+":n;m.classList.toggle("on",n>0)}}
function goLink(l){if(!l||l.charAt(0)!=="#")return;var id=l.slice(1);if(TABS.some(function(t){return t[0]===id}))show(id)}
function fnToast(title,text,kind,go){var w=$("#fn-wrap");if(!w){w=document.createElement("div");w.id="fn-wrap";document.body.appendChild(w)}
 var t=document.createElement("div");t.className="fn-toast fn-"+(kind==="success"?"success":kind==="warning"||kind==="alert"?"warning":"info");
 t.innerHTML='<div class="fn-title">'+esc(title)+'</div><div class="fn-text">'+esc(text)+'</div><div class="fn-bar"><i></i></div>';
 t.onclick=function(){t.remove();if(go)go()};w.appendChild(t);
 setTimeout(function(){t.classList.add("out");setTimeout(function(){t.remove()},300)},6000)}
function alertNext(){if(ALERTING||!ALERTQ.length)return;var n=ALERTQ.shift();ALERTING=true;
 openBox('<div style="text-align:center"><div style="font-size:44px">⚠️</div><h3>'+esc(n.title)+'</h3><div style="margin:10px 0;line-height:1.7;white-space:pre-wrap">'+esc(n.body)+'</div><button class="btn r" id="al_ok" style="width:100%">تم الاطلاع</button></div>');$("#box").classList.add("alert");
 $("#al_ok").onclick=function(){$("#box").classList.remove("alert");closeBox();ALERTING=false;api("/api/notifs/read",{ids:[n.id]}).catch(function(){});if(n.link)goLink(n.link);setTimeout(alertNext,250)}}
function pollNotifs(){if(document.hidden||!ME)return;api("/api/notifs").then(function(d){
 var ids=d.list.map(function(n){return n.id});
 if(NSEEN===null){NSEEN={};ids.forEach(function(i){NSEEN[i]=1});d.list.forEach(function(n){if(!n.read&&n.kind==="alert")ALERTQ.push(n)});alertNext()}
 else{var fresh=d.list.filter(function(n){return !n.read&&!NSEEN[n.id]}).reverse();fresh.forEach(function(n){NSEEN[n.id]=1;
   if(n.kind==="alert"){ALERTQ.push(n);alertNext()}else fnToast(n.title,n.body,n.kind,function(){if(n.link)goLink(n.link);else show("notifs")})});
  if(fresh.length&&TAB==="notifs")V.notifs()}
 updBadge(d.unread)}).catch(function(){})}
var NSEEN=null,NTIMER=null;
function startNotifs(){if(NTIMER)return;pollNotifs();NTIMER=setInterval(pollNotifs,15000);document.addEventListener("visibilitychange",function(){if(!document.hidden)pollNotifs()})}
V.notifs=function(){return api("/api/notifs").then(function(d){
 var h='<div class="card"><div class="row sb"><div><h3 style="margin:0">🔔 الإشعارات</h3><div class="muted">'+(d.unread?d.unread+" غير مقروء":"كل شي مقروء")+'</div></div><div class="row"><button class="btn sm" data-a="nReadAll">قراءة الكل</button><button class="btn gray sm" data-a="nClear">مسح الكل</button></div></div></div>';
 if(!d.list.length)h+='<div class="card muted" style="text-align:center">ما عندك إشعارات</div>';
 d.list.forEach(function(n){h+='<div class="card ntf '+(n.read?"":"unread ")+'k-'+esc(n.kind)+'" data-a="nOpen" data-id="'+n.id+'" data-l="'+esc(n.link||"")+'"><div class="row sb"><b>'+esc(n.title)+'</b><span class="muted">'+ago(n.at)+'</span></div><div style="margin-top:4px;white-space:pre-wrap">'+esc(n.body)+'</div></div>'});
 main(h);updBadge(d.unread)})};
A.goNotifs=function(){show("notifs")};
A.nReadAll=function(){return api("/api/notifs/read",{}).then(function(){show("notifs")})};
A.nClear=function(){return sure("مسح كل الإشعارات؟").then(function(y){if(!y)return;return api("/api/notifs/clear",{}).then(function(){show("notifs")})})};
A.nOpen=function(d){return api("/api/notifs/read",{ids:[d.id]}).then(function(){if(d.l)goLink(d.l);else show("notifs")})};

/* ───── خدمة العملاء والتذاكر ───── */
var TK_TIMER=null,TK_CUR=null,TK_SIG="";
function tkBadge(s){var m={open:["بانتظار الدعم","b-wait"],answered:["رد الدعم","b-ok"],closed:["مغلقة","b-gray"]}[s]||[s,"b-gray"];return '<span class="badge '+m[1]+'">'+m[0]+'</span>'}
function tkCard(t,act){return '<div class="card" style="cursor:pointer" data-a="'+act+'" data-id="'+t.id+'"><div class="row sb"><b>#'+t.num+" · "+esc(t.subject)+'</b>'+tkBadge(t.status)+'</div><div class="muted">'+esc(t.category)+(act==="stkOpen"?" · "+esc(t.name):"")+" · "+ago(t.updatedAt)+'</div>'+(t.last?'<div class="muted" style="margin-top:4px">'+(t.last.from==="staff"?"الدعم: ":"")+esc(t.last.text)+'</div>':"")+'</div>'}
V.tickets=function(){return api("/api/tickets/mine").then(function(l){
 var h='<div class="card"><div class="row sb"><div><h3 style="margin:0">🎫 خدمة العملاء</h3><div class="muted">افتح تذكرة وفريق الدعم يرد عليك</div></div><button class="btn g" data-a="tkNew">+ تذكرة جديدة</button></div></div>';
 if(!l.length)h+='<div class="card muted" style="text-align:center">ما عندك تذاكر</div>';
 l.forEach(function(t){h+=tkCard(t,"tkOpen")});main(h)})};
var STKF="open",STKQ="";
V.stickets=function(){return api("/api/staff/tickets?status="+(STKF==="all"?"":STKF)+"&q="+encodeURIComponent(STKQ)).then(function(l){
 var h='<div class="card"><h3>🎫 تذاكر خدمة العملاء</h3><div class="row" style="margin-bottom:8px">'+[["open","بانتظار الدعم"],["answered","تم الرد"],["closed","مغلقة"],["all","الكل"]].map(function(s){return '<button class="tab'+(s[0]===STKF?" on":"")+'" data-a="stkF" data-s="'+s[0]+'">'+s[1]+'</button>'}).join("")+'</div><div class="row"><input id="stk_q" placeholder="رقم التذكرة / الاسم / العنوان" value="'+esc(STKQ)+'" style="flex:1"><button class="btn" data-a="stkS">بحث</button></div></div>';
 if(!l.length)h+='<div class="card muted" style="text-align:center">لا توجد تذاكر</div>';
 l.forEach(function(t){h+=tkCard(t,"stkOpen")});main(h);$("#stk_q").onkeydown=function(e){if(e.key==="Enter")A.stkS()}})};
A.stkF=function(d){STKF=d.s;show("stickets")};A.stkS=function(){STKQ=$("#stk_q").value;show("stickets")};
function renderThread(t){TK_SIG=t.messages.length+":"+t.status;
 var keep=$("#tk_in")?$("#tk_in").value:"";
 var h='<div class="card"><div class="row sb"><div><h3 style="margin:0">#'+t.num+" · "+esc(t.subject)+'</h3><div class="muted">'+esc(t.category)+" · "+esc(t.name)+(t.assignedName?" · المستلم: "+esc(t.assignedName):"")+'</div></div>'+tkBadge(t.status)+'</div></div>';
 h+='<div class="card chat" id="tk_msgs">'+t.messages.map(function(m){return '<div class="msg '+(m.from==="staff"?"st":"us")+'"><div class="mh">'+esc(m.name)+" · "+ago(m.at)+'</div><div class="mt">'+esc(m.text)+'</div></div>'}).join("")+'</div>';
 if(t.status!=="closed")h+='<div class="card"><textarea id="tk_in" placeholder="اكتب رسالتك..." maxlength="1500"></textarea><div class="row" style="margin-top:8px"><button class="btn g" data-a="tkSend">إرسال</button>'+(t.staffView?'<button class="btn sm" data-a="tkClaim">استلام</button>':"")+'<button class="btn r sm" data-a="tkClose">إغلاق التذكرة</button><button class="btn gray sm" data-a="tkBack">رجوع</button></div></div>';
 else h+='<div class="card"><div class="muted">🔒 التذكرة مغلقة'+(t.rating?" · التقييم: "+"⭐".repeat(t.rating):"")+'</div><div class="row" style="margin-top:8px">'+(t.canRate?'<button class="btn sm" data-a="tkRate">⭐ قيّم الخدمة</button>':"")+(t.staffView?'<button class="btn sm" data-a="tkReopen">إعادة فتح</button>':"")+'<button class="btn gray sm" data-a="tkBack">رجوع</button></div></div>';
 main(h);var m=$("#tk_msgs");if(m)m.scrollTop=m.scrollHeight;if(keep&&$("#tk_in"))$("#tk_in").value=keep}
function tkView(id){TK_CUR=id;return api("/api/tickets/"+id).then(function(t){renderThread(t);if(!TK_TIMER)TK_TIMER=setInterval(tkPoll,8000)})}
function tkPoll(){if(!TK_CUR||document.hidden)return;api("/api/tickets/"+TK_CUR).then(function(t){if(t.messages.length+":"+t.status!==TK_SIG)renderThread(t)}).catch(function(){})}
A.tkOpen=function(d){return tkView(d.id)};A.stkOpen=function(d){return tkView(d.id)};
A.tkBack=function(){show(TAB)};
A.tkNew=function(){return api("/api/tickets/meta").then(function(m){return ask("🎫 تذكرة جديدة",[{id:"c",label:"القسم",type:"select",options:m.categories},{id:"s",label:"عنوان المشكلة"},{id:"t",label:"التفاصيل",type:"textarea"}],"إرسال").then(function(v){if(!v)return;return api("/api/tickets",{category:v.c,subject:v.s,text:v.t}).then(function(r){toast("✅ تم إرسال التذكرة");return tkView(r.id)})})})};
A.tkSend=function(d,b){var v=$("#tk_in").value.trim();if(!v)return;b.disabled=true;return api("/api/tickets/"+TK_CUR+"/messages",{text:v}).then(function(){$("#tk_in").value="";return tkView(TK_CUR)}).catch(function(e){b.disabled=false;fail(e)})};
A.tkClose=function(){return sure("إغلاق التذكرة؟").then(function(y){if(!y)return;return api("/api/tickets/"+TK_CUR+"/close",{}).then(function(){return tkView(TK_CUR)})})};
A.tkClaim=function(){return api("/api/tickets/"+TK_CUR+"/claim",{}).then(function(){toast("✅ استلمت التذكرة");return tkView(TK_CUR)})};
A.tkReopen=function(){return api("/api/tickets/"+TK_CUR+"/reopen",{}).then(function(){return tkView(TK_CUR)})};
A.tkRate=function(){return ask("⭐ قيّم خدمة الدعم",[{id:"s",label:"التقييم",type:"select",options:[{v:"5",l:"⭐⭐⭐⭐⭐ ممتاز"},{v:"4",l:"⭐⭐⭐⭐ جيد جداً"},{v:"3",l:"⭐⭐⭐ جيد"},{v:"2",l:"⭐⭐ مقبول"},{v:"1",l:"⭐ سيئ"}]},{id:"n",label:"ملاحظة (اختياري)",type:"textarea"}],"إرسال").then(function(v){if(!v)return;return api("/api/tickets/"+TK_CUR+"/rate",{stars:v.s,note:v.n}).then(function(){toast("شكراً لتقييمك 🌟");return tkView(TK_CUR)})})};

/* ───── ملفي الإداري: شهاداتي + تحذيراتي + ملاحظات الإدارة ───── */
function certRow(c){return '<div class="row sb" style="margin-top:8px"><div><b>'+esc(c.kindLabel)+'</b> '+(c.status==="revoked"?'<span class="badge b-no">ملغاة</span>':'<span class="badge b-ok">سارية</span>')+'<div class="muted">'+dt(c.createdAt)+" · "+esc(c.issuedByName||"")+(c.issuedByRole?" — "+esc(c.issuedByRole):"")+'</div></div><div class="row"><a class="btn sm" target="_blank" href="/cert/'+esc(c.code)+'" style="text-decoration:none">عرض</a><button class="btn gray sm" data-a="copyV" data-c="'+esc(c.code)+'">🔗 رابط التحقق</button></div></div>'}
A.copyV=function(d){return copyText(location.origin+"/verify/"+d.c)};
V.record=function(){return api("/api/me/record").then(function(d){
 var h='<div class="card"><h3>🗂️ ملفي الإداري</h3><div class="muted">شهاداتك، التحذيرات، وملاحظات الإدارة عليك</div></div>';
 h+='<div class="card"><h3>📜 شهاداتي</h3>'+(d.certs.length?d.certs.map(certRow).join("<hr>"):'<div class="muted">ما عندك شهادات بعد</div>')+'<div class="muted" style="margin-top:8px">كل شهادة لها باركود QR يتحقق منه أي أحد من صحتها.</div></div>';
 h+='<div class="card"><h3>⚠️ التحذيرات والتنبيهات</h3>'+(d.warnings.length?d.warnings.map(function(w){return '<div style="margin-top:8px"><div class="row sb"><b>'+(w.kind==="warning"?"⚠️ تحذير":"📢 تنبيه")+'</b><span class="muted">'+dt(w.at)+'</span></div><div style="white-space:pre-wrap">'+esc(w.reason)+'</div><div class="muted">من: '+esc(w.byName||"")+(w.byRole?" — "+esc(w.byRole):"")+'</div>'+(w.ack?'<span class="badge b-ok">تم الاطلاع</span>':'<button class="btn sm" data-a="wAck" data-id="'+w.id+'" style="margin-top:6px">تم الاطلاع</button>')+'</div><hr>'}).join(""):'<div class="muted">✅ ما عليك تحذيرات</div>')+'</div>';
 h+='<div class="card"><h3>📝 ملاحظات الإدارة</h3>'+(d.notes.length?d.notes.map(function(n){return '<div style="margin-top:8px"><div style="white-space:pre-wrap">'+esc(n.text)+'</div><div class="muted">'+esc(n.byName||"")+(n.byRole?" — "+esc(n.byRole):"")+" · "+dt(n.at)+'</div></div><hr>'}).join(""):'<div class="muted">ما فيه ملاحظات</div>')+'</div>';
 main(h)})};
A.wAck=function(d){return api("/api/warn/"+d.id+"/ack",{}).then(function(){show("record")})};

/* ───── إصدار الشهادات (الإدارة وقيادة القطاعات) ───── */
var CKINDS=[["thanks","شهادة شكر وتقدير"],["excellence","شهادة تميز وانضباط"],["promotion","شهادة ترقية"],["conduct","شهادة حسن سيرة وسلوك"],["course","شهادة إتمام دورة"],["participation","شهادة مشاركة ومهمة"],["trainer","شهادة مدرب"],["trainee","شهادة متدرب"]];
V.certs=function(){return api("/api/certs/recent").then(function(l){
 var h='<div class="card"><h3>🏅 إصدار شهادة</h3><div class="muted">'+(ME.admin?"تصدر لأي عضو.":"تصدر لأعضاء قطاعك فقط.")+' الشهادة تجيها باركود QR للتحقق من صحتها.</div><button class="btn g" data-a="csNew" style="margin-top:10px">+ إصدار شهادة جديدة</button></div>';
 h+='<div class="card"><h3>📋 آخر الشهادات'+(ME.admin?"":" (اللي أصدرتها)")+'</h3>'+(l.length?l.map(function(c){return '<div class="row sb" style="margin-top:8px"><div><b>'+esc(c.kindLabel)+'</b> '+(c.status==="revoked"?'<span class="badge b-no">ملغاة</span>':'<span class="badge b-ok">سارية</span>')+'<div class="muted">'+esc(c.name||"")+" · "+dt(c.createdAt)+'</div></div><div class="row"><a class="btn sm" target="_blank" href="/cert/'+esc(c.code)+'" style="text-decoration:none">عرض</a>'+(c.status==="active"?'<button class="btn r sm" data-a="csRev" data-c="'+esc(c.code)+'">سحب</button>':"")+'</div></div><hr>'}).join(""):'<div class="muted">ما أصدرت شهادات بعد</div>')+'</div>';
 main(h)})};
function issueCert(uid){return ask("📜 إصدار شهادة",[{id:"k",label:"نوع الشهادة",type:"select",options:CKINDS.map(function(k){return {v:k[0],l:k[1]}})},{id:"n",label:"التفاصيل (سبب الشكر / اسم الدورة / ...) — اختياري"}],"إصدار").then(function(v){if(!v)return;return api("/api/certs/issue",{uid:uid,kind:v.k,note:v.n}).then(function(r){toast("✅ صدرت الشهادة");window.open(r.url,"_blank");if(TAB==="certs")show("certs")})})}
A.csNew=function(){return pickPerson("اختر العضو").then(function(p){if(p)return issueCert(p.uid)})};
A.certTo=function(d){return issueCert(d.u)};
A.csRev=function(d){return sure("سحب الشهادة؟ تصير «ملغاة» وتظهر كذا في صفحة التحقق.").then(function(y){if(!y)return;return api("/api/certs/"+d.c+"/revoke",{}).then(function(){show("certs")})})};

/* ───── تحذير / ملاحظة / ملف عضو (من الأفراد أو من القطاع) ───── */
A.warnTo=function(d){return ask("⚠️ تحذير / تنبيه",[{id:"k",label:"النوع",type:"select",options:[{v:"warning",l:"⚠️ تحذير"},{v:"notice",l:"📢 تنبيه"}]},{id:"r",label:"السبب",type:"textarea"}],"إرسال","يوصل للعضو إشعار داخل الموقع (التحذير يطلع له نافذة حمراء).").then(function(v){if(!v||!v.r.trim())return;return api("/api/warn",{uid:d.u,kind:v.k,reason:v.r}).then(function(){toast("✅ تم الإرسال")})})};
A.noteTo=function(d){return ask("📝 ملاحظة إدارية",[{id:"t",label:"الملاحظة",type:"textarea"},{id:"v",label:"الظهور",type:"select",options:[{v:"1",l:"تظهر للعضو في ملفه"},{v:"0",l:"للإدارة فقط (سرية)"}]}],"حفظ").then(function(v){if(!v||!v.t.trim())return;return api("/api/note",{uid:d.u,text:v.t,visible:v.v==="1"}).then(function(){toast("✅ تمت إضافة الملاحظة")})})};
function recModal(uid){return api("/api/member/"+uid+"/record").then(function(d){
 var h='<h3>📂 ملف: '+esc(d.name)+'</h3><div class="muted">الشهادات '+d.certs.length+" · التحذيرات "+d.warnings.length+" · الملاحظات "+d.notes.length+'</div>';
 h+='<hr><b>⚠️ التحذيرات</b>'+(d.warnings.length?d.warnings.map(function(w){return '<div class="qa"><div class="row sb"><b>'+(w.kind==="warning"?"⚠️":"📢")+" "+dt(w.at)+'</b>'+((d.senior||w.byName)?'<button class="btn r sm" data-a="wDel" data-id="'+w.id+'" data-u="'+uid+'">حذف</button>':"")+'</div>'+esc(w.reason)+'<div class="muted">'+esc(w.byName||"")+(w.ack?" · ✔ اطلع":" · لم يطلع")+'</div></div>'}).join(""):'<div class="muted">لا يوجد</div>');
 h+='<hr><b>📝 الملاحظات</b>'+(d.notes.length?d.notes.map(function(n){return '<div class="qa"><div class="row sb"><b>'+dt(n.at)+(n.visible?"":" 🔒")+'</b><button class="btn r sm" data-a="nDel" data-id="'+n.id+'" data-u="'+uid+'">حذف</button></div>'+esc(n.text)+'<div class="muted">'+esc(n.byName||"")+'</div></div>'}).join(""):'<div class="muted">لا يوجد</div>');
 h+='<hr><b>📜 الشهادات</b>'+(d.certs.length?d.certs.map(function(c){return '<div class="qa">'+esc(c.kindLabel)+' · '+dt(c.createdAt)+(c.status==="revoked"?" · ملغاة":"")+' <a href="/cert/'+esc(c.code)+'" target="_blank" style="color:#60a5fa">عرض</a></div>'}).join(""):'<div class="muted">لا يوجد</div>');
 h+='<div class="row" style="margin-top:12px"><button class="btn gray" id="rm_x">إغلاق</button></div>';openBox(h);$("#rm_x").onclick=closeBox})}
A.recOf=function(d){return recModal(d.u)};
A.wDel=function(d){return sure("حذف التحذير؟").then(function(y){if(!y)return;return api("/api/warn/"+d.id+"/delete",{}).then(function(){return recModal(d.u)})})};
A.nDel=function(d){return sure("حذف الملاحظة؟").then(function(y){if(!y)return;return api("/api/note/"+d.id+"/delete",{}).then(function(){return recModal(d.u)})})};

/* ───── القطاعات: قائد / نائب / مسؤول الأفراد ───── */
var SECR=[["commander","قائد القطاع"],["deputy","نائب القائد"],["personnel","مسؤول الأفراد"]];
function roleRow(r,s,senior){var p=s[r[0]];return '<div class="rolerow"><span class="muted">'+r[1]+'</span><span>'+(p?'<b>'+esc(p.name)+'</b> <span class="muted">'+esc(p.rank||"")+'</span>':'<span class="muted">شاغر</span>')+'</span>'+(senior?'<span class="row"><button class="btn sm" data-a="secSet" data-k="'+s.key+'" data-r="'+r[0]+'">'+(p?"تغيير":"تعيين")+'</button>'+(p?'<button class="btn r sm" data-a="secClr" data-k="'+s.key+'" data-r="'+r[0]+'">إزالة</button>':"")+'</span>':"")+'</div>'}
V.sectors=function(){return api("/api/sectors").then(function(d){
 var h='<div class="card"><div class="row sb"><div><h3 style="margin:0">🎖️ القطاعات</h3><div class="muted">'+(d.myRole?"أنت "+esc(d.myRole.roleLabel)+" — "+esc(d.myRole.label):(d.mySector?"أنت عضو في قطاع":"ما أنت في قطاع"))+'</div></div>'+(d.senior?'<button class="btn g" data-a="secNew">+ قطاع جديد</button>':"")+'</div></div>';
 if(!d.sectors.length)h+='<div class="card muted" style="text-align:center">'+(d.senior?"ما فيه قطاعات — أضف أول قطاع":"ما فيه قطاعات بعد")+'</div>';
 d.sectors.forEach(function(s){h+='<div class="card"><div class="row sb"><b style="font-size:16px">'+esc(s.emoji)+" "+esc(s.label)+'</b><span><span class="badge b-gray">'+s.members+' عضو</span> '+(s.mine?'<span class="badge b-ok">قطاعي</span>':"")+'</span></div>'+SECR.map(function(r){return roleRow(r,s,d.senior)}).join("")+
  '<div class="row" style="margin-top:10px">'+((s.canManage||s.mine||ME.admin)?'<button class="btn sm" data-a="secMem" data-k="'+s.key+'">👥 الأعضاء</button>':"")+(d.senior?'<button class="btn gray sm" data-a="secRen" data-k="'+s.key+'" data-v="'+esc(s.label)+'">✏️ الاسم</button><button class="btn r sm" data-a="secDel" data-k="'+s.key+'">حذف القطاع</button>':"")+'</div></div>'});
 main(h)})};
A.secNew=function(){return ask("قطاع جديد",[{id:"l",label:"اسم القطاع"},{id:"e",label:"إيموجي (اختياري)",ph:"🎖️"}],"إضافة").then(function(v){if(!v)return;return api("/api/senior/sectors",{label:v.l,emoji:v.e}).then(function(){toast("✅ تم إنشاء القطاع");show("sectors")})})};
A.secRen=function(d){return ask("اسم القطاع",[{id:"l",label:"الاسم",value:d.v}],"حفظ").then(function(v){if(!v)return;return api("/api/senior/sectors/"+d.k+"/rename",{label:v.l}).then(function(){show("sectors")})})};
A.secDel=function(d){return sure("حذف القطاع؟ كل أعضائه يصيرون بدون قطاع.").then(function(y){if(!y)return;return api("/api/senior/sectors/"+d.k+"/delete",{}).then(function(){show("sectors")})})};
A.secSet=function(d){var r=SECR.filter(function(x){return x[0]===d.r})[0];return pickPerson("اختر "+r[1],"military").then(function(p){if(!p)return;return api("/api/senior/sectors/"+d.k+"/leader",{role:d.r,uid:p.uid}).then(function(){toast("✅ تم تعيين "+p.name+" — "+r[1]);show("sectors")})})};
A.secClr=function(d){return sure("إزالة هذا المنصب؟").then(function(y){if(!y)return;return api("/api/senior/sectors/"+d.k+"/leader",{role:d.r,uid:null}).then(function(){show("sectors")})})};
var RL={commander:"قائد",deputy:"نائب",personnel:"مسؤول أفراد"};
function memModal(k){return api("/api/sectors/"+k+"/members").then(function(d){
 var h='<h3>👥 '+esc(d.label)+'</h3><div class="muted">'+d.list.length+' عضو</div>'+(d.canManage?'<button class="btn g sm" data-a="secAdd" data-k="'+k+'" style="margin-top:8px">+ إضافة عضو</button>':"");
 h+=d.list.map(function(m){return '<div class="card" style="margin:8px 0;padding:10px"><div class="row sb"><b>'+esc(m.name)+'</b><span>'+(m.role?'<span class="badge b-wait">'+RL[m.role]+'</span> ':"")+'<span class="muted">'+esc(m.rank||"")+'</span></span></div><div class="row" style="margin-top:6px">'+
  (ME.canWarn&&m.uid!==ME.uid?'<button class="btn gray sm" data-a="warnTo" data-u="'+m.uid+'">⚠️</button><button class="btn gray sm" data-a="noteTo" data-u="'+m.uid+'">📝</button><button class="btn gray sm" data-a="recOf" data-u="'+m.uid+'">📂</button>':"")+
  (ME.canCert&&m.uid!==ME.uid?'<button class="btn gray sm" data-a="certTo" data-u="'+m.uid+'">📜</button>':"")+
  (d.canManage&&!m.role?'<button class="btn r sm" data-a="secRm" data-k="'+k+'" data-u="'+m.uid+'">إزالة</button>':"")+'</div></div>'}).join("");
 h+='<div class="row" style="margin-top:12px"><button class="btn gray" id="mm_x">إغلاق</button></div>';openBox(h);$("#mm_x").onclick=closeBox})}
A.secMem=function(d){return memModal(d.k)};
A.secAdd=function(d){return pickPerson("إضافة عضو للقطاع","military").then(function(p){if(!p)return memModal(d.k);return api("/api/sectors/"+d.k+"/members",{uid:p.uid,action:"add"}).then(function(){toast("✅ تمت إضافة "+p.name);return memModal(d.k)})})};
A.secRm=function(d){return sure("إزالة العضو من القطاع؟").then(function(y){if(!y)return;return api("/api/sectors/"+d.k+"/members",{uid:d.u,action:"remove"}).then(function(){return memModal(d.k)})})};
A.pSec=function(d){return api("/api/sectors").then(function(s){var o=[{v:"",l:"— بدون قطاع —"}].concat(s.sectors.map(function(x){return {v:x.key,l:x.label}}));return ask("🎖️ قطاع العسكري",[{id:"s",label:"القطاع",type:"select",options:o,value:d.s}],"حفظ").then(function(v){if(!v)return;return api("/api/senior/people/"+d.u+"/sector",{sector:v.s||null}).then(function(){toast("✅ تم");show("people")})})})};

/* ───── إشعار عام (كبار المسؤولين) ───── */
V.bc=function(){return api("/api/sectors").then(function(s){
 var o=[["all","الكل"],["citizen","المواطنين"],["military","العسكر"]].concat(s.sectors.map(function(x){return ["sector:"+x.key,"قطاع: "+x.label]}));
 main('<div class="card"><h3>📣 إشعار عام</h3><div class="muted">يوصل إشعار داخل الموقع للفئة اللي تختارها (النوع «إنذار» يطلع لهم نافذة حمراء).</div>'+
  '<label class="f">المستهدفون</label><select id="bc_t">'+o.map(function(x){return '<option value="'+esc(x[0])+'">'+esc(x[1])+'</option>'}).join("")+'</select>'+
  '<label class="f">النوع</label><select id="bc_k"><option value="info">إشعار عادي</option><option value="warning">تنبيه</option><option value="alert">إنذار (نافذة حمراء)</option></select>'+
  '<label class="f">العنوان</label><input id="bc_h" maxlength="80"><label class="f">النص</label><textarea id="bc_b" maxlength="400"></textarea><button class="btn g" data-a="bcSend" style="width:100%;margin-top:12px">إرسال</button></div>')})};
A.bcSend=function(d,b){if(!$("#bc_h").value.trim()||!$("#bc_b").value.trim()){toast("اكتب العنوان والنص",false);return}return sure("إرسال الإشعار؟").then(function(y){if(!y)return;b.disabled=true;return api("/api/senior/broadcast",{target:$("#bc_t").value,kind:$("#bc_k").value,title:$("#bc_h").value,body:$("#bc_b").value}).then(function(r){toast("✅ وصل لـ "+r.count+" عضو");$("#bc_h").value="";$("#bc_b").value="";b.disabled=false}).catch(function(e){b.disabled=false;fail(e)})})};

/* ───── تشغيل ───── */
setBh();api("/api/me").then(function(m){
 if(!m.loggedIn){loginView();return}
 if(m.blocked){$("#app").innerHTML='<div class="login"><div class="card" style="text-align:center"><div style="font-size:40px">🚫</div><p style="margin:10px 0">'+esc(m.reason)+'</p><a class="btn gray" href="/auth/logout" style="text-decoration:none;display:inline-block">خروج</a></div></div>';return}
 ME=m;shell();startNotifs()}).catch(function(){loginView()});
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

// ═════════════════════════════════════════════════════════════════════════════════════════
// إضافات فلاش (منقولة من تصميم/ميزات app.js بنسخة مدنية):
//   🔔 إشعارات داخل الموقع  |  🎫 خدمة العملاء والتذاكر  |  🎖️ القطاعات (قائد / نائب / مسؤول الأفراد)
//   📜 شهادات بباركود QR للتحقق  |  ⚠️ تحذيرات  |  📝 ملاحظات الإدارة
//   ✅ بدون PWA: الموقع يفتح كمتصفح عادي، وأي Service Worker قديم ينحذف تلقائياً
// ═════════════════════════════════════════════════════════════════════════════════════════
const SAFE_OID = /^[a-f0-9]{24}$/i;
const esc = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
const rxEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fmtDate = (d) => { try { return new Date(d).toLocaleDateString("ar-SA-u-ca-gregory-nu-latn", { timeZone: "Asia/Riyadh", year: "numeric", month: "long", day: "numeric" }); } catch (e) { return ""; } };

// ── مولّد QR داخلي (بدون مكتبات) ──
// ===================== مولّد QR داخلي (بدون مكتبات خارجية) — وضع Byte، تصحيح L/M، نسخ 1-6 =====================
const FlashQR = (function () {
    const ECC = { L: { fmt: 1, cw: [0, 7, 10, 15, 20, 26, 18], bl: [0, 1, 1, 1, 1, 1, 2] }, M: { fmt: 0, cw: [0, 10, 16, 26, 18, 24, 16], bl: [0, 1, 1, 1, 2, 2, 4] } };
    function gmul(x, y) { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; } return z; }
    function rsDiv(deg) {
        const r = new Array(deg).fill(0); r[deg - 1] = 1; let root = 1;
        for (let i = 0; i < deg; i++) { for (let j = 0; j < deg; j++) { r[j] = gmul(r[j], root); if (j + 1 < deg) r[j] ^= r[j + 1]; } root = gmul(root, 2); }
        return r;
    }
    function rsRem(data, div) {
        const r = new Array(div.length).fill(0);
        for (const b of data) { const f = b ^ r.shift(); r.push(0); for (let i = 0; i < div.length; i++) r[i] ^= gmul(div[i], f); }
        return r;
    }
    function rawModules(ver) {
        let r = (16 * ver + 128) * ver + 64;
        if (ver >= 2) { const n = Math.floor(ver / 7) + 2; r -= (25 * n - 10) * n - 55; }
        return r;
    }
    function dataCw(ver, e) { return Math.floor(rawModules(ver) / 8) - e.cw[ver] * e.bl[ver]; }
    function build(bytes, eccName) {
        const e = ECC[eccName]; let ver = 0;
        for (let v = 1; v <= 6; v++) { if (4 + 8 + 8 * bytes.length <= dataCw(v, e) * 8) { ver = v; break; } }
        if (!ver) return null;
        // 1) bits
        const bits = [];
        const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
        put(4, 4); put(bytes.length, 8); bytes.forEach(b => put(b, 8));
        const cap = dataCw(ver, e) * 8;
        put(0, Math.min(4, cap - bits.length));
        while (bits.length % 8) bits.push(0);
        for (let p = 0xEC; bits.length < cap; p ^= 0xEC ^ 0x11) put(p, 8);
        const data = []; for (let i = 0; i < bits.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; data.push(b); }
        // 2) blocks + ecc + interleave
        const nb = e.bl[ver], eccLen = e.cw[ver], raw = Math.floor(rawModules(ver) / 8);
        const shortLen = Math.floor(raw / nb) - eccLen, numShort = nb - raw % nb;
        const div = rsDiv(eccLen), blocks = []; let k = 0;
        for (let i = 0; i < nb; i++) {
            const len = shortLen + (i < numShort ? 0 : 1);
            const d = data.slice(k, k + len); k += len;
            const ec = rsRem(d, div);
            if (i < numShort) d.push(0);
            blocks.push(d.concat(ec));
        }
        const all = [];
        for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen || j >= numShort) all.push(b[i]); });
        // 3) matrix
        const size = ver * 4 + 17;
        const m = [], fn = [];
        for (let i = 0; i < size; i++) { m.push(new Array(size).fill(false)); fn.push(new Array(size).fill(false)); }
        const setFn = (x, y, d) => { m[y][x] = d; fn[y][x] = true; };
        for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
        const finder = (cx, cy) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const x = cx + dx, y = cy + dy; if (x >= 0 && x < size && y >= 0 && y < size) { const d = Math.max(Math.abs(dx), Math.abs(dy)); setFn(x, y, d !== 2 && d !== 4); } } };
        finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
        if (ver >= 2) {
            const pos = [6, size - 7];
            for (const i of pos) for (const j of pos) {
                if ((i === 6 && j === 6) || (i === 6 && j === size - 7) || (i === size - 7 && j === 6)) continue;
                for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(i + dx, j + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
            }
        }
        const fmt = mask => {
            const d = (e.fmt << 3) | mask; let rem = d;
            for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
            const b = ((d << 10) | rem) ^ 0x5412, bit = i => ((b >>> i) & 1) !== 0;
            for (let i = 0; i <= 5; i++) setFn(8, i, bit(i));
            setFn(8, 7, bit(6)); setFn(8, 8, bit(7)); setFn(7, 8, bit(8));
            for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(i));
            for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(i));
            for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(i));
            setFn(8, size - 8, true);
        };
        fmt(0);
        let idx = 0;
        for (let right = size - 1; right >= 1; right -= 2) {
            if (right === 6) right = 5;
            for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
                const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
                if (!fn[y][x] && idx < all.length * 8) { m[y][x] = ((all[idx >>> 3] >>> (7 - (idx & 7))) & 1) !== 0; idx++; }
            }
        }
        const maskFn = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
            (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0,
            (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0];
        const applyMask = mk => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && maskFn[mk](x, y)) m[y][x] = !m[y][x]; };
        const penalty = () => {
            let p = 0;
            const lines = [];
            for (let y = 0; y < size; y++) lines.push(m[y]);
            for (let x = 0; x < size; x++) lines.push(m.map(r => r[x]));
            for (const L of lines) {
                let run = 1;
                for (let i = 1; i <= size; i++) { if (i < size && L[i] === L[i - 1]) run++; else { if (run >= 5) p += 3 + (run - 5); run = 1; } }
                const s = L.map(v => v ? "1" : "0").join("");
                for (const pat of ["00001011101", "10111010000"]) { let at = -1; while ((at = s.indexOf(pat, at + 1)) !== -1) p += 40; }
            }
            for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
            let dark = 0; m.forEach(r => r.forEach(v => { if (v) dark++; }));
            p += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
            return p;
        };
        let best = 0, bp = Infinity;
        for (let mk = 0; mk < 8; mk++) { applyMask(mk); fmt(mk); const p = penalty(); if (p < bp) { bp = p; best = mk; } applyMask(mk); }
        applyMask(best); fmt(best);
        return m;
    }
    function matrix(text) {
        const bytes = Array.from(Buffer.from(String(text), "utf8"));
        return build(bytes, "M") || build(bytes, "L");
    }
    function svg(text, opts) {
        const m = matrix(text); if (!m) return "";
        const o = opts || {}, q = 4, n = m.length + q * 2;
        let d = "";
        for (let y = 0; y < m.length; y++) for (let x = 0; x < m.length; x++) if (m[y][x]) d += "M" + (x + q) + "," + (y + q) + "h1v1h-1z";
        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + " " + n + '" width="' + (o.size || 160) + '" height="' + (o.size || 160) + '" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="' + d + '" fill="' + (o.color || "#000") + '"/></svg>';
    }
    return { matrix, svg };
})();


// ───────────── 🔔 الإشعارات ─────────────
const NotifModel = mongoose.model("Notif", new mongoose.Schema({
    uid: { type: String, index: true }, title: String, body: String,
    kind: { type: String, default: "info" },            // info | success | warning | alert
    link: { type: String, default: null },               // مثل #tickets
    read: { type: Boolean, default: false },
    at: { type: Date, default: Date.now, index: { expireAfterSeconds: 45 * 86400 } },
}));
async function notify(uid, title, body, kind, link) {
    if (!uid) return;
    try { await NotifModel.create({ uid: String(uid), title: clip(title, 80), body: clip(body, 400), kind: ["info", "success", "warning", "alert"].includes(kind) ? kind : "info", link: link || null }); } catch (e) {}
}
async function staffUids() {
    const list = await Account.find({ status: "approved", suspended: false, $or: [{ isAdmin: true }, { isSenior: true }, { roleAdmin: true }, { roleSenior: true }, { uid: { $in: [...CONFIG.SENIOR_IDS, ...CONFIG.OWNER_IDS] } }] }, { uid: 1 }).limit(80).lean();
    return Array.from(new Set(list.map(x => x.uid)));
}
app.get("/api/notifs", loadAuth, wrap(async (req, res) => {
    const uid = req.acc.uid;
    const [list, unread] = await Promise.all([NotifModel.find({ uid }).sort({ at: -1 }).limit(50).lean(), NotifModel.countDocuments({ uid, read: false })]);
    res.json({ unread, list: list.map(n => ({ id: String(n._id), title: n.title, body: n.body, kind: n.kind, link: n.link, read: n.read, at: n.at })) });
}));
app.post("/api/notifs/read", loadAuth, wrap(async (req, res) => {
    const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map(String).filter(i => SAFE_OID.test(i)).slice(0, 100) : null;
    const q = { uid: req.acc.uid, read: false }; if (ids) q._id = { $in: ids };
    await NotifModel.updateMany(q, { $set: { read: true } }); res.json({ ok: true });
}));
app.post("/api/notifs/clear", loadAuth, wrap(async (req, res) => { await NotifModel.deleteMany({ uid: req.acc.uid }); res.json({ ok: true }); }));
// إشعار عام (كبار المسؤولين): للكل / مواطنين / عسكر / قطاع معيّن
app.post("/api/senior/broadcast", loadAuth, needSenior, wrap(async (req, res) => {
    if (!rateLimit("bc:" + req.acc.uid, 6, 10 * 60000)) return res.status(429).json({ error: "إشعارات كثيرة، انتظر شوي" });
    const b = req.body || {}; const title = clip(b.title, 80), body = clip(b.body, 400);
    if (!title || !body) return res.status(400).json({ error: "اكتب العنوان والنص" });
    const kind = ["info", "warning", "alert"].includes(b.kind) ? b.kind : "info";
    const f = { status: "approved", suspended: false }; const tg = String(b.target || "all");
    if (tg === "citizen" || tg === "military") f.kind = tg;
    else if (tg.startsWith("sector:")) f.sector = tg.slice(7);
    const accs = await Account.find(f, { uid: 1 }).limit(3000).lean();
    if (!accs.length) return res.status(400).json({ error: "ما فيه أحد بهذا الاستهداف" });
    await NotifModel.insertMany(accs.map(a => ({ uid: a.uid, title, body, kind, link: null })));
    await logEvent({ action: "إشعار عام", actor: req.acc.uid, actorName: req.acc.fullName, details: tg + " (" + accs.length + "): " + title });
    res.json({ ok: true, count: accs.length });
}));

// ───────────── 🎖️ القطاعات ─────────────
const SectorModel = mongoose.model("Sector", new mongoose.Schema({
    key: { type: String, unique: true }, label: String, emoji: { type: String, default: "🎖️" },
    commanderUid: { type: String, default: null }, deputyUid: { type: String, default: null }, personnelUid: { type: String, default: null },
    createdBy: String, createdAt: { type: Date, default: Date.now },
}));
const SEC_ROLES = { commander: ["commanderUid", "قائد القطاع"], deputy: ["deputyUid", "نائب القائد"], personnel: ["personnelUid", "مسؤول الأفراد"] };
async function sectorRoleOf(uid) {
    const s = await SectorModel.findOne({ $or: [{ commanderUid: uid }, { deputyUid: uid }, { personnelUid: uid }] }).lean();
    if (!s) return null;
    const role = s.commanderUid === uid ? "commander" : s.deputyUid === uid ? "deputy" : "personnel";
    return { key: s.key, label: s.label, role, roleLabel: SEC_ROLES[role][1] };
}
const withSec = wrap(async (req, res, next) => { req.sec = await sectorRoleOf(req.acc.uid); next(); });
const manageSector = (req, key) => req.role.senior || (req.sec && req.sec.key === key);
const issuerLabel = (req) => req.role.senior ? "كبار المسؤولين" : req.role.admin ? "الإدارة" : req.sec ? req.sec.roleLabel + " — " + req.sec.label : "—";
// هل يقدر يتصرف على هذا العضو (تحذير / ملاحظة / شهادة)؟ الإدارة: الكل. قيادة القطاع: أعضاء قطاعهم فقط وبدون أنفسهم.
const canActOn = (req, target) => req.role.admin || !!(req.sec && target.sector && target.sector === req.sec.key && target.uid !== req.acc.uid);
async function targetFor(req, res, uid) {
    uid = String(uid || "");
    if (!UID_RE.test(uid)) { res.status(400).json({ error: "حدد العضو" }); return null; }
    const t = await Account.findOne({ uid, status: "approved" }); if (!t) { res.status(404).json({ error: "العضو غير موجود" }); return null; }
    if (!canActOn(req, t)) { res.status(403).json({ error: "هذا العضو مو من صلاحياتك" }); return null; }
    return t;
}
app.get("/api/sectors", loadAuth, withSec, wrap(async (req, res) => {
    const secs = await SectorModel.find().sort({ createdAt: 1 }).lean();
    const uids = []; secs.forEach(s => [s.commanderUid, s.deputyUid, s.personnelUid].forEach(u => u && uids.push(u)));
    const nm = {}; (await Account.find({ uid: { $in: uids } }, { uid: 1, fullName: 1, rank: 1 }).lean()).forEach(a => nm[a.uid] = { uid: a.uid, name: a.fullName, rank: a.rank });
    const cm = {}; (await Account.aggregate([{ $match: { sector: { $ne: null }, status: "approved" } }, { $group: { _id: "$sector", n: { $sum: 1 } } }])).forEach(c => cm[c._id] = c.n);
    res.json({
        sectors: secs.map(s => ({ key: s.key, label: s.label, emoji: s.emoji, commander: nm[s.commanderUid] || null, deputy: nm[s.deputyUid] || null, personnel: nm[s.personnelUid] || null, members: cm[s.key] || 0, canManage: manageSector(req, s.key), mine: req.acc.sector === s.key })),
        mySector: req.acc.sector || null, myRole: req.sec, senior: req.role.senior,
    });
}));
app.get("/api/sectors/:key/members", loadAuth, withSec, wrap(async (req, res) => {
    const key = String(req.params.key); const s = await SectorModel.findOne({ key }).lean(); if (!s) return res.status(404).json({ error: "القطاع غير موجود" });
    if (!manageSector(req, key) && req.acc.sector !== key && !req.role.admin) return res.status(403).json({ error: "ما تقدر تشوف أعضاء هذا القطاع" });
    const list = await Account.find({ sector: key, status: "approved" }, { uid: 1, fullName: 1, rank: 1, discordTag: 1, suspended: 1 }).sort({ fullName: 1 }).limit(300).lean();
    res.json({ label: s.label, canManage: manageSector(req, key) || req.role.admin, list: list.map(a => ({ uid: a.uid, name: a.fullName, rank: a.rank, tag: a.discordTag, suspended: a.suspended, role: s.commanderUid === a.uid ? "commander" : s.deputyUid === a.uid ? "deputy" : s.personnelUid === a.uid ? "personnel" : null })) });
}));
app.post("/api/sectors/:key/members", loadAuth, withSec, wrap(async (req, res) => {
    const key = String(req.params.key); const s = await SectorModel.findOne({ key }).lean(); if (!s) return res.status(404).json({ error: "القطاع غير موجود" });
    if (!manageSector(req, key)) return res.status(403).json({ error: "إدارة الأعضاء لقيادة القطاع وكبار المسؤولين" });
    const b = req.body || {}; const uid = String(b.uid || "");
    const t = UID_RE.test(uid) ? await Account.findOne({ uid, status: "approved", kind: "military" }) : null; if (!t) return res.status(404).json({ error: "العسكري غير موجود" });
    if (b.action === "remove") {
        if (t.sector !== key) return res.status(400).json({ error: "العضو مو بهذا القطاع" });
        if ([s.commanderUid, s.deputyUid, s.personnelUid].includes(uid)) return res.status(400).json({ error: "هذا العضو من قيادة القطاع — الكبار يشيلونه من التعيين أول" });
        t.sector = null; await t.save();
        await notify(uid, "🎖️ إزالة من القطاع", "تمت إزالتك من قطاع «" + s.label + "».", "warning", "#sectors");
        await logEvent({ action: "إزالة من قطاع", actor: req.acc.uid, actorName: req.acc.fullName, target: uid, details: s.label });
        return res.json({ ok: true });
    }
    if (t.sector && t.sector !== key && !req.role.senior) return res.status(400).json({ error: "العسكري في قطاع ثاني — الكبار فقط ينقلونه" });
    if (t.sector === key) return res.json({ ok: true });
    t.sector = key; await t.save();
    await notify(uid, "🎖️ انضمام لقطاع", "تمت إضافتك لقطاع «" + s.label + "».", "success", "#sectors");
    await logEvent({ action: "إضافة لقطاع", actor: req.acc.uid, actorName: req.acc.fullName, target: uid, details: s.label });
    res.json({ ok: true });
}));
app.get("/api/people/search", loadAuth, withSec, wrap(async (req, res) => {
    if (!req.role.admin && !req.sec) return res.status(403).json({ error: "غير مصرح" });
    const q = clip(req.query.q, 40); if (q.length < 2) return res.json([]);
    const rx = new RegExp(rxEsc(q), "i"); const f = { status: "approved", $or: [{ fullName: rx }, { discordTag: rx }, { uid: rx }, { civilId: rx }] };
    if (req.query.kind === "military") f.kind = "military";
    if (!req.role.admin && req.sec) { f.sector = req.sec.key; f.uid = { $ne: req.acc.uid }; }
    const list = await Account.find(f, { uid: 1, fullName: 1, kind: 1, rank: 1, job: 1, sector: 1, discordTag: 1 }).limit(15).lean();
    res.json(list.map(a => ({ uid: a.uid, name: a.fullName, kind: a.kind, rank: a.kind === "military" ? a.rank : a.job, sector: a.sector, tag: a.discordTag })));
}));
app.post("/api/senior/sectors", loadAuth, needSenior, wrap(async (req, res) => {
    const label = clip((req.body || {}).label, 40), emoji = clip((req.body || {}).emoji, 4) || "🎖️";
    if (label.length < 2) return res.status(400).json({ error: "اكتب اسم القطاع" });
    if (await SectorModel.countDocuments() >= 40) return res.status(400).json({ error: "وصلت الحد الأقصى من القطاعات (40)" });
    if (await SectorModel.exists({ label })) return res.status(400).json({ error: "فيه قطاع بنفس الاسم" });
    const s = await SectorModel.create({ key: "sec" + crypto.randomBytes(4).toString("hex"), label, emoji, createdBy: req.acc.uid });
    await logEvent({ action: "إنشاء قطاع", actor: req.acc.uid, actorName: req.acc.fullName, details: label });
    res.json({ ok: true, key: s.key });
}));
app.post("/api/senior/sectors/:key/rename", loadAuth, needSenior, wrap(async (req, res) => {
    const label = clip((req.body || {}).label, 40); if (label.length < 2) return res.status(400).json({ error: "اكتب اسم القطاع" });
    const r = await SectorModel.updateOne({ key: String(req.params.key) }, { $set: { label } }); res.json({ ok: !!r.matchedCount });
}));
app.post("/api/senior/sectors/:key/delete", loadAuth, needSenior, wrap(async (req, res) => {
    const key = String(req.params.key); const s = await SectorModel.findOne({ key }); if (!s) return res.status(404).json({ error: "القطاع غير موجود" });
    await Account.updateMany({ sector: key }, { $set: { sector: null } }); await SectorModel.deleteOne({ key });
    await logEvent({ action: "حذف قطاع", actor: req.acc.uid, actorName: req.acc.fullName, details: s.label }); res.json({ ok: true });
}));
// تعيين / إزالة: قائد القطاع، نائب القائد، مسؤول الأفراد (نفس الأزرار لكل قطاع)
app.post("/api/senior/sectors/:key/leader", loadAuth, needSenior, wrap(async (req, res) => {
    const key = String(req.params.key); const s = await SectorModel.findOne({ key }); if (!s) return res.status(404).json({ error: "القطاع غير موجود" });
    const b = req.body || {}; const r = SEC_ROLES[b.role]; if (!r) return res.status(400).json({ error: "المنصب غير صحيح" });
    const field = r[0], old = s[field];
    if (!b.uid) { s[field] = null; await s.save(); if (old) await notify(old, "🎖️ إنهاء تكليف", "تم إنهاء تكليفك كـ" + r[1] + " في «" + s.label + "».", "warning", "#sectors"); await logEvent({ action: "إزالة " + r[1], actor: req.acc.uid, actorName: req.acc.fullName, target: old, details: s.label }); return res.json({ ok: true }); }
    const uid = String(b.uid);
    const t = UID_RE.test(uid) ? await Account.findOne({ uid, status: "approved", kind: "military", suspended: false }) : null; if (!t) return res.status(404).json({ error: "العسكري غير موجود أو موقوف" });
    const other = await SectorModel.findOne({ $or: [{ commanderUid: uid }, { deputyUid: uid }, { personnelUid: uid }] }).lean();
    if (other && !(other.key === key && other[field] === uid)) return res.status(400).json({ error: "هذا العسكري عنده منصب قيادي ثاني (" + other.label + ") — شيله منه أول" });
    s[field] = uid; await s.save(); if (t.sector !== key) { t.sector = key; await t.save(); }
    if (old && old !== uid) await notify(old, "🎖️ إنهاء تكليف", "تم إنهاء تكليفك كـ" + r[1] + " في «" + s.label + "».", "warning", "#sectors");
    await notify(uid, "🎖️ تكليف جديد", "تم تعيينك " + r[1] + " في قطاع «" + s.label + "».", "success", "#sectors");
    await logEvent({ action: "تعيين " + r[1], actor: req.acc.uid, actorName: req.acc.fullName, target: uid, details: s.label });
    res.json({ ok: true });
}));

// ───────────── ⚠️ التحذيرات + 📝 ملاحظات الإدارة ─────────────
const WarnModel = mongoose.model("Warn", new mongoose.Schema({
    uid: { type: String, index: true }, kind: { type: String, default: "warning" }, reason: String,
    by: String, byName: String, byRole: String, ack: { type: Boolean, default: false }, ackAt: Date, at: { type: Date, default: Date.now },
}));
const NoteModel = mongoose.model("AdminNote", new mongoose.Schema({
    uid: { type: String, index: true }, text: String, visible: { type: Boolean, default: true },
    by: String, byName: String, byRole: String, at: { type: Date, default: Date.now },
}));
const warnOut = (w) => ({ id: String(w._id), kind: w.kind, reason: w.reason, byName: w.byName, byRole: w.byRole, ack: w.ack, at: w.at });
const noteOut = (n) => ({ id: String(n._id), text: n.text, visible: n.visible, byName: n.byName, byRole: n.byRole, at: n.at });
app.post("/api/warn", loadAuth, withSec, wrap(async (req, res) => {
    if (!req.role.admin && !req.sec) return res.status(403).json({ error: "التحذيرات للإدارة وقيادة القطاعات فقط" });
    if (!rateLimit("warn:" + req.acc.uid, 30, 10 * 60000)) return res.status(429).json({ error: "عمليات كثيرة، انتظر شوي" });
    const b = req.body || {}; const t = await targetFor(req, res, b.uid); if (!t) return;
    if (t.uid === req.acc.uid && !req.role.senior) return res.status(403).json({ error: "ما تقدر تحذّر نفسك" });
    const reason = clip(b.reason, 400); if (reason.length < 3) return res.status(400).json({ error: "اكتب السبب" });
    const kind = b.kind === "notice" ? "notice" : "warning";
    await WarnModel.create({ uid: t.uid, kind, reason, by: req.acc.uid, byName: req.acc.fullName, byRole: issuerLabel(req) });
    await notify(t.uid, kind === "warning" ? "⚠️ وصلك تحذير" : "📢 وصلك تنبيه", reason, kind === "warning" ? "alert" : "warning", "#record");
    await logEvent({ action: kind === "warning" ? "تحذير" : "تنبيه", actor: req.acc.uid, actorName: req.acc.fullName, target: t.uid, details: reason });
    res.json({ ok: true });
}));
app.post("/api/warn/:id/ack", loadAuth, wrap(async (req, res) => {
    if (!SAFE_OID.test(req.params.id)) return res.status(400).json({ error: "معرّف غير صالح" });
    await WarnModel.updateOne({ _id: req.params.id, uid: req.acc.uid }, { $set: { ack: true, ackAt: new Date() } }); res.json({ ok: true });
}));
app.post("/api/warn/:id/delete", loadAuth, wrap(async (req, res) => {
    if (!SAFE_OID.test(req.params.id)) return res.status(400).json({ error: "معرّف غير صالح" });
    const w = await WarnModel.findById(req.params.id); if (!w) return res.json({ ok: true });
    if (!req.role.senior && w.by !== req.acc.uid) return res.status(403).json({ error: "تحذيرك أنت بس تقدر تحذفه (أو الكبار)" });
    await WarnModel.deleteOne({ _id: w._id }); await logEvent({ action: "حذف تحذير", actor: req.acc.uid, actorName: req.acc.fullName, target: w.uid, details: w.reason }); res.json({ ok: true });
}));
app.post("/api/note", loadAuth, withSec, wrap(async (req, res) => {
    if (!req.role.admin && !req.sec) return res.status(403).json({ error: "الملاحظات للإدارة وقيادة القطاعات فقط" });
    const b = req.body || {}; const t = await targetFor(req, res, b.uid); if (!t) return;
    const text = clip(b.text, 500); if (text.length < 2) return res.status(400).json({ error: "اكتب الملاحظة" });
    const visible = b.visible !== false;
    await NoteModel.create({ uid: t.uid, text, visible, by: req.acc.uid, byName: req.acc.fullName, byRole: issuerLabel(req) });
    if (visible) await notify(t.uid, "📝 ملاحظة جديدة", text, "info", "#record");
    await logEvent({ action: "ملاحظة إدارية", actor: req.acc.uid, actorName: req.acc.fullName, target: t.uid, details: text });
    res.json({ ok: true });
}));
app.post("/api/note/:id/delete", loadAuth, wrap(async (req, res) => {
    if (!SAFE_OID.test(req.params.id)) return res.status(400).json({ error: "معرّف غير صالح" });
    const n = await NoteModel.findById(req.params.id); if (!n) return res.json({ ok: true });
    if (!req.role.senior && n.by !== req.acc.uid) return res.status(403).json({ error: "ملاحظتك أنت بس تقدر تحذفها (أو الكبار)" });
    await NoteModel.deleteOne({ _id: n._id }); res.json({ ok: true });
}));
// ملفي: شهاداتي + تحذيراتي + الملاحظات الظاهرة لي
app.get("/api/me/record", loadAuth, wrap(async (req, res) => {
    const uid = req.acc.uid;
    const [w, n, c] = await Promise.all([WarnModel.find({ uid }).sort({ at: -1 }).limit(100).lean(), NoteModel.find({ uid, visible: true }).sort({ at: -1 }).limit(100).lean(), Certificate.find({ targetUid: uid }).sort({ createdAt: -1 }).limit(100).lean()]);
    res.json({ warnings: w.map(warnOut), notes: n.map(noteOut), certs: c.map(certPublic), unack: w.filter(x => !x.ack && x.kind === "warning").length });
}));
// ملف عضو (للإدارة / قيادة القطاع)
app.get("/api/member/:uid/record", loadAuth, withSec, wrap(async (req, res) => {
    if (!req.role.admin && !req.sec) return res.status(403).json({ error: "غير مصرح" });
    const t = await targetFor(req, res, req.params.uid); if (!t) return;
    const [w, n, c] = await Promise.all([WarnModel.find({ uid: t.uid }).sort({ at: -1 }).limit(100).lean(), NoteModel.find({ uid: t.uid }).sort({ at: -1 }).limit(100).lean(), Certificate.find({ targetUid: t.uid }).sort({ createdAt: -1 }).limit(100).lean()]);
    res.json({ name: t.fullName, warnings: w.map(warnOut), notes: n.map(noteOut), certs: c.map(certPublic), me: req.acc.uid, senior: req.role.senior });
}));
// تعيين قطاع لعسكري (من تاب الأفراد — للكبار)
app.post("/api/senior/people/:uid/sector", loadAuth, needSenior, wrap(async (req, res) => {
    const t = await Account.findOne({ uid: req.params.uid, kind: "military", status: "approved" }); if (!t) return res.status(404).json({ error: "العسكري غير موجود" });
    const key = (req.body || {}).sector ? String(req.body.sector) : null; let s = null;
    if (key) { s = await SectorModel.findOne({ key }).lean(); if (!s) return res.status(404).json({ error: "القطاع غير موجود" }); }
    const was = await SectorModel.findOne({ $or: [{ commanderUid: t.uid }, { deputyUid: t.uid }, { personnelUid: t.uid }] }).lean();
    if (was && (!key || was.key !== key)) return res.status(400).json({ error: "هذا العسكري قيادي في «" + was.label + "» — شيله من التعيين أول" });
    t.sector = key; await t.save();
    await notify(t.uid, "🎖️ تحديث القطاع", s ? "تم نقلك لقطاع «" + s.label + "»." : "تمت إزالتك من القطاع.", "info", "#sectors");
    await logEvent({ action: "تعيين قطاع", actor: req.acc.uid, actorName: req.acc.fullName, target: t.uid, details: s ? s.label : "بدون" }); res.json({ ok: true });
}));

// ───────────── 📜 الشهادات الرسمية بباركود QR للتحقق ─────────────
const CERT_KINDS = {
    thanks: "شهادة شكر وتقدير", excellence: "شهادة تميز وانضباط", promotion: "شهادة ترقية", conduct: "شهادة حسن سيرة وسلوك",
    course: "شهادة إتمام دورة", participation: "شهادة مشاركة ومهمة", trainer: "شهادة مدرب", trainee: "شهادة متدرب",
};
const CERT_META = {
    thanks: { lead: "تتقدم إدارة فلاش بجزيل الشكر والتقدير للعضو المذكور بياناته أدناه، نظير جهوده المخلصة وعطائه المتميز:", noteLabel: "سبب الشكر" },
    excellence: { lead: "تمنح إدارة فلاش هذه الشهادة للعضو المذكور بياناته أدناه تقديراً لتميّزه وانضباطه والتزامه بالأنظمة:", noteLabel: "أبرز ما تميز به" },
    promotion: { lead: "تشهد إدارة فلاش بأن العضو المذكور بياناته أدناه تمت ترقيته وفق الضوابط المعتمدة:", noteLabel: "ملاحظات الترقية" },
    conduct: { lead: "تشهد إدارة فلاش بأن العضو المذكور بياناته أدناه ذو سيرة حسنة وسلوك قويم خلال فترة وجوده لدينا:", noteLabel: "ملاحظات" },
    course: { lead: "تشهد إدارة فلاش بأن العضو المذكور بياناته أدناه أتمّ الدورة التالية بنجاح واستحق هذه الشهادة:", noteLabel: "اسم الدورة" },
    participation: { lead: "تشهد إدارة فلاش بأن العضو المذكور بياناته أدناه شارك مشاركة فعّالة في المهمة / الفعالية التالية:", noteLabel: "المهمة أو الفعالية" },
    trainer: { lead: "تشهد إدارة فلاش بأن العضو المذكور بياناته أدناه يحمل صفة (مدرب) معتمد لدينا:", noteLabel: "مجال التدريب" },
    trainee: { lead: "تشهد إدارة فلاش بأن العضو المذكور بياناته أدناه التحق بالبرنامج التدريبي واجتازه بنجاح:", noteLabel: "البرنامج التدريبي" },
};
const Certificate = mongoose.model("Certificate", new mongoose.Schema({
    code: { type: String, unique: true, index: true }, kind: { type: String, default: "thanks" }, targetUid: { type: String, index: true },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    issuedBy: String, issuedByName: String, issuedByRole: String,
    status: { type: String, enum: ["active", "revoked"], default: "active", index: true },
    revokedBy: { type: String, default: null }, revokedByName: { type: String, default: null }, revokedAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now, index: true },
}));
function genCertCode() {
    const A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; let s = "";
    for (const x of crypto.randomBytes(12)) s += A[x % A.length];
    return "FL-" + s.slice(0, 4) + "-" + s.slice(4, 8) + "-" + s.slice(8, 12);
}
const CERT_CODE_RE = /^FL-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const certPublic = (c) => ({ code: c.code, kind: c.kind, kindLabel: CERT_KINDS[c.kind] || c.kind, name: (c.data || {}).name, issuedByName: c.issuedByName, issuedByRole: c.issuedByRole, status: c.status, createdAt: c.createdAt });
// الإصدار: كبار المسؤولين / الإدارة، وقائد ونائب القطاع (لأعضاء قطاعهم فقط). ما أحد يصدر لنفسه إلا الكبار.
const certGate = (req, res, next) => {
    const lead = req.sec && (req.sec.role === "commander" || req.sec.role === "deputy");
    if (!req.role.admin && !lead) return res.status(403).json({ error: "إصدار الشهادات للإدارة وقيادة القطاعات فقط" });
    req.certScope = req.role.admin ? "all" : "sector"; next();
};
const certIssuer = [loadAuth, withSec, certGate];
app.get("/api/certs/recent", certIssuer, wrap(async (req, res) => {
    const f = req.certScope === "all" ? {} : { issuedBy: req.acc.uid };
    res.json((await Certificate.find(f).sort({ createdAt: -1 }).limit(60).lean()).map(certPublic));
}));
app.post("/api/certs/issue", certIssuer, wrap(async (req, res) => {
    if (!rateLimit("cert:" + req.acc.uid, 40, 10 * 60000)) return res.status(429).json({ error: "شهادات كثيرة، انتظر شوي" });
    const b = req.body || {}; const kind = String(b.kind || ""); if (!CERT_KINDS[kind]) return res.status(400).json({ error: "نوع الشهادة غير صحيح" });
    const t = await targetFor(req, res, b.uid); if (!t) return;
    if (t.uid === req.acc.uid && !req.role.senior) return res.status(403).json({ error: "ما تقدر تصدر شهادة لنفسك" });
    const sec = t.sector ? await SectorModel.findOne({ key: t.sector }).lean() : null;
    const data = { name: t.fullName, kind: t.kind, role: t.kind === "military" ? (t.rank || "") : (t.job || ""), sector: sec ? sec.label : null, note: clip(b.note, 120) };
    let c = null;
    for (let i = 0; i < 5 && !c; i++) {
        try { c = await Certificate.create({ code: genCertCode(), kind, targetUid: t.uid, data, issuedBy: req.acc.uid, issuedByName: req.acc.fullName, issuedByRole: issuerLabel(req) }); }
        catch (e) { if (!(e && e.code === 11000)) throw e; }
    }
    if (!c) return res.status(500).json({ error: "تعذر توليد رقم الشهادة، جرّب مرة ثانية" });
    await notify(t.uid, "📜 صدرت لك شهادة", CERT_KINDS[kind] + " — افتح «ملفي» لعرضها", "success", "#record");
    await logEvent({ action: "إصدار شهادة", actor: req.acc.uid, actorName: req.acc.fullName, target: t.uid, details: CERT_KINDS[kind] + " (" + c.code + ")" });
    res.json({ ok: true, cert: certPublic(c), url: "/cert/" + c.code });
}));
app.post("/api/certs/:code/revoke", certIssuer, wrap(async (req, res) => {
    const code = String(req.params.code || "").toUpperCase(); const c = CERT_CODE_RE.test(code) ? await Certificate.findOne({ code }) : null; if (!c) return res.status(404).json({ error: "الشهادة غير موجودة" });
    if (req.certScope !== "all" && c.issuedBy !== req.acc.uid) return res.status(403).json({ error: "تقدر تسحب الشهادات اللي أصدرتها بس" });
    if (c.status === "revoked") return res.json({ ok: true });
    c.status = "revoked"; c.revokedBy = req.acc.uid; c.revokedByName = req.acc.fullName; c.revokedAt = new Date(); await c.save();
    await notify(c.targetUid, "📜 سُحبت شهادة", (CERT_KINDS[c.kind] || "") + " (" + c.code + ")", "warning", "#record");
    await logEvent({ action: "سحب شهادة", actor: req.acc.uid, actorName: req.acc.fullName, target: c.targetUid, details: c.code }); res.json({ ok: true });
}));
function certBaseUrl(req) { return CONFIG.SITE_URL || (req.protocol + "://" + req.get("host")); }
const CERT_BOLT = '<svg viewBox="0 0 100 100" aria-hidden="true"><defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#60a5fa"/><stop offset="1" stop-color="#1d4ed8"/></linearGradient></defs><path fill="url(#cg)" d="M58 8 L26 55 L46 55 L40 92 L74 42 L54 42 L64 8 Z"/></svg>';
function certPageShell(title, body, extraCss) {
    return '<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>' + esc(title) + '</title>' +
        '<link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;900&display=swap" rel="stylesheet"><style>' +
        '*{box-sizing:border-box;margin:0;padding:0;font-family:Tajawal,Tahoma,sans-serif}body{background:linear-gradient(135deg,#0a1628,#0d1f3c 50%,#0d3060);color:#e2e8f0;min-height:100vh;padding:18px 12px}' +
        '.top{max-width:760px;margin:0 auto 14px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}.logo{display:flex;align-items:center;gap:6px;font-weight:900;font-size:1.3rem;color:#60a5fa}.logo svg{width:26px;height:26px}' +
        '.btn{border:0;border-radius:10px;padding:9px 16px;font-weight:700;font-size:14px;cursor:pointer;color:#fff;background:linear-gradient(135deg,#1d4ed8,#3b82f6);text-decoration:none;display:inline-block}' + (extraCss || "") + '</style></head><body>' + body + '</body></html>';
}
// صفحة الشهادة (مطبوعة / PDF) — عامة، والباركود يوديك لصفحة التحقق
app.get("/cert/:code", wrap(async (req, res) => {
    if (!rateLimit("certv:" + clientIp(req), 90, 60000)) return res.status(429).type("text").send("محاولات كثيرة");
    const code = String(req.params.code || "").toUpperCase(); const c = CERT_CODE_RE.test(code) ? await Certificate.findOne({ code }).lean() : null;
    res.set("Cache-Control", "no-store");
    if (!c) return res.status(404).type("html").send(certPageShell("شهادة غير موجودة", '<div style="text-align:center;margin-top:20vh"><div style="font-size:54px">❌</div><h2>الشهادة غير موجودة</h2></div>'));
    const meta = CERT_META[c.kind] || CERT_META.thanks, d = c.data || {}, vurl = certBaseUrl(req) + "/verify/" + c.code, revoked = c.status === "revoked";
    const rows = [["الاسم", d.name], [d.kind === "military" ? "الرتبة" : "الوظيفة", d.role], ["القطاع", d.sector], [meta.noteLabel, d.note]].filter(r => r[1]);
    const body = '<div class="top"><div class="logo">' + CERT_BOLT + 'فلاش</div><div><button class="btn" onclick="window.print()">🖨️ طباعة / حفظ PDF</button> <a class="btn" style="background:#374151" href="/verify/' + esc(c.code) + '">🔎 التحقق</a></div></div>' +
        '<div class="cert">' + (revoked ? '<div class="rev">ملغاة</div>' : '') + '<div class="in"><div class="hd">' + CERT_BOLT + '<div class="srv">فلاش</div></div><div class="ttl">' + esc(CERT_KINDS[c.kind] || c.kind) + '</div><div class="lead">' + esc(meta.lead) + '</div>' +
        '<table>' + rows.map(r => '<tr><th>' + esc(r[0]) + '</th><td>' + esc(r[1]) + '</td></tr>').join("") + '</table>' +
        '<div class="ft"><div class="sig"><div class="sl"></div><b>' + esc(c.issuedByName || "-") + '</b><small>' + esc(c.issuedByRole || "") + '</small></div>' +
        '<div class="qr">' + FlashQR.svg(vurl, { size: 110 }) + '<small>امسح للتحقق</small></div>' +
        '<div class="sig"><div class="stamp">فلاش<br>معتمد ✓</div><small>' + esc(fmtDate(c.createdAt)) + '</small></div></div>' +
        '<div class="code">رقم الشهادة: <b>' + esc(c.code) + '</b></div></div></div>' +
        '<div style="max-width:760px;margin:12px auto;text-align:center;font-size:12px;color:#64748b">هذا الموقع مخصص للمحاكاة واللعب فقط، ولا يمت للواقع بصلة.</div>';
    const css = '.cert{max-width:760px;margin:0 auto;background:#fffdf6;color:#1e293b;border-radius:10px;padding:10px;position:relative;box-shadow:0 20px 50px rgba(0,0,0,.5)}' +
        '.in{border:3px double #1d4ed8;border-radius:6px;padding:26px 22px;text-align:center}.hd{display:flex;flex-direction:column;align-items:center;gap:2px}.hd svg{width:54px;height:54px}.srv{font-weight:900;font-size:22px;color:#1d4ed8;letter-spacing:2px}' +
        '.ttl{font-size:30px;font-weight:900;color:#0f2a63;margin:10px 0 8px}.lead{font-size:15px;line-height:1.9;color:#334155;margin-bottom:12px}' +
        'table{margin:0 auto;border-collapse:collapse;width:88%;font-size:15px}th,td{border:1px solid #cbd5e1;padding:8px 10px}th{background:#eef4ff;color:#1d4ed8;width:32%;font-weight:700}td{font-weight:700}' +
        '.ft{display:flex;justify-content:space-between;align-items:flex-end;margin-top:22px;gap:8px}.sig{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;font-size:13px}.sl{width:70%;border-top:1.5px solid #475569;margin-bottom:4px}.sig small,.qr small{color:#64748b;font-size:11px}' +
        '.qr{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px}.stamp{border:3px solid #1d4ed8;color:#1d4ed8;border-radius:50%;width:84px;height:84px;display:flex;align-items:center;justify-content:center;text-align:center;font-weight:900;font-size:14px;line-height:1.3;transform:rotate(-10deg);opacity:.85}' +
        '.code{margin-top:16px;font-size:13px;color:#475569;letter-spacing:1px}.rev{position:absolute;top:40%;left:50%;transform:translate(-50%,-50%) rotate(-20deg);font-size:90px;font-weight:900;color:rgba(220,38,38,.25);border:8px solid rgba(220,38,38,.25);padding:0 24px;border-radius:14px;z-index:3;pointer-events:none}' +
        '@media print{body{background:#fff;padding:0}.top,body>div:last-child{display:none}.cert{box-shadow:none;max-width:none}}@media(max-width:520px){.ttl{font-size:22px}table{width:100%}.stamp{width:66px;height:66px;font-size:11px}}';
    res.type("html").send(certPageShell("شهادة — " + (CERT_KINDS[c.kind] || ""), body, css));
}));
// صفحة التحقق (اللي يفتحها الباركود)
app.get("/verify/:code", wrap(async (req, res) => {
    if (!rateLimit("certv:" + clientIp(req), 90, 60000)) return res.status(429).type("text").send("محاولات كثيرة");
    const code = String(req.params.code || "").toUpperCase(); const c = CERT_CODE_RE.test(code) ? await Certificate.findOne({ code }).lean() : null;
    res.set("Cache-Control", "no-store");
    let inner;
    if (!c) inner = '<div class="vb bad"><div class="vi">❌</div><h2>شهادة غير صحيحة</h2><p>هذا الرقم غير مسجّل لدينا — الشهادة غير موثّقة.</p></div>';
    else {
        const d = c.data || {}, ok = c.status === "active";
        inner = '<div class="vb ' + (ok ? "ok" : "bad") + '"><div class="vi">' + (ok ? "✅" : "⛔") + '</div><h2>' + (ok ? "شهادة سارية وموثّقة" : "شهادة ملغاة") + '</h2>' +
            '<table><tr><th>نوع الشهادة</th><td>' + esc(CERT_KINDS[c.kind] || c.kind) + '</td></tr><tr><th>الاسم</th><td>' + esc(d.name || "-") + '</td></tr>' + (d.role ? '<tr><th>' + (d.kind === "military" ? "الرتبة" : "الوظيفة") + '</th><td>' + esc(d.role) + '</td></tr>' : '') +
            '<tr><th>الجهة المصدِرة</th><td>' + esc(c.issuedByName || "-") + (c.issuedByRole ? " — " + esc(c.issuedByRole) : "") + '</td></tr><tr><th>تاريخ الإصدار</th><td>' + esc(fmtDate(c.createdAt)) + '</td></tr>' +
            (ok ? "" : '<tr><th>تاريخ الإلغاء</th><td>' + esc(fmtDate(c.revokedAt)) + '</td></tr>') + '<tr><th>رقم الشهادة</th><td dir="ltr">' + esc(c.code) + '</td></tr></table>' +
            '<p style="margin-top:12px"><a class="btn" href="/cert/' + esc(c.code) + '">📄 عرض الشهادة</a></p></div>';
    }
    const body = '<div class="top"><div class="logo">' + CERT_BOLT + 'فلاش — التحقق من الشهادات</div></div><div style="max-width:560px;margin:0 auto">' + inner + '</div>';
    const css = '.vb{background:rgba(255,255,255,.05);border:1px solid rgba(59,130,246,.3);border-radius:16px;padding:24px 18px;text-align:center}.vb.ok{border-color:#22c55e}.vb.bad{border-color:#ef4444}.vi{font-size:56px}h2{margin:6px 0 10px}' +
        'table{width:100%;border-collapse:collapse;margin-top:10px;text-align:right}th,td{border-bottom:1px solid rgba(59,130,246,.2);padding:9px 8px;font-size:14px}th{color:#60a5fa;width:34%}';
    res.type("html").send(certPageShell("التحقق من شهادة", body, css));
}));

// ───────────── 🎫 خدمة العملاء والتذاكر ─────────────
const TICKET_CATS = ["استفسار عام", "مشكلة في الحساب", "مخالفة / غرامة", "رخصة قيادة", "البنك", "شكوى", "اقتراح", "أخرى"];
const TicketModel = mongoose.model("Ticket", new mongoose.Schema({
    num: { type: Number, unique: true, index: true }, uid: { type: String, index: true }, name: String, kind: String, category: String, subject: String,
    status: { type: String, default: "open", index: true },       // open (بانتظار الدعم) | answered (رد الدعم) | closed
    messages: [{ from: String, uid: String, name: String, text: String, at: { type: Date, default: Date.now }, _id: false }],
    assignedUid: { type: String, default: null }, assignedName: { type: String, default: null },
    closedByName: String, closedAt: Date, rating: { type: Number, default: null }, ratingNote: String,
    createdAt: { type: Date, default: Date.now }, updatedAt: { type: Date, default: Date.now, index: true },
}));
const tkRow = (t) => ({ id: String(t._id), num: t.num, subject: t.subject, category: t.category, status: t.status, name: t.name, kind: t.kind, assignedName: t.assignedName, updatedAt: t.updatedAt, createdAt: t.createdAt, rating: t.rating, last: (t.messages && t.messages.length) ? { from: t.messages[t.messages.length - 1].from, text: clip(t.messages[t.messages.length - 1].text, 70) } : null });
async function loadTicket(req, res) {
    if (!SAFE_OID.test(req.params.id)) { res.status(400).json({ error: "معرّف غير صالح" }); return null; }
    const t = await TicketModel.findById(req.params.id);
    if (!t || (t.uid !== req.acc.uid && !req.role.admin)) { res.status(404).json({ error: "التذكرة غير موجودة" }); return null; }
    return t;
}
app.get("/api/tickets/meta", loadAuth, wrap(async (req, res) => res.json({ categories: TICKET_CATS })));
app.post("/api/tickets", loadAuth, wrap(async (req, res) => {
    if (!rateLimit("tk:" + req.acc.uid, 6, 10 * 60000)) return res.status(429).json({ error: "تذاكر كثيرة، انتظر شوي" });
    const b = req.body || {}; const subject = clip(b.subject, 80), text = clip(b.text, 1500);
    const category = TICKET_CATS.includes(b.category) ? b.category : "أخرى";
    if (subject.length < 3 || text.length < 5) return res.status(400).json({ error: "اكتب عنوان ووصف المشكلة" });
    if (await TicketModel.countDocuments({ uid: req.acc.uid, status: { $ne: "closed" } }) >= 3) return res.status(400).json({ error: "عندك 3 تذاكر مفتوحة — أغلق وحدة أول" });
    let t = null;
    for (let i = 0; i < 6 && !t; i++) {
        const last = await TicketModel.findOne({}, { num: 1 }).sort({ num: -1 }).lean();
        try { t = await TicketModel.create({ num: ((last && last.num) || 1000) + 1, uid: req.acc.uid, name: req.acc.fullName, kind: req.acc.kind, category, subject, messages: [{ from: "user", uid: req.acc.uid, name: req.acc.fullName, text }] }); }
        catch (e) { if (!(e && e.code === 11000)) throw e; }
    }
    if (!t) return res.status(500).json({ error: "تعذر إنشاء التذكرة، جرّب مرة ثانية" });
    for (const u of await staffUids()) await notify(u, "🎫 تذكرة جديدة #" + t.num, req.acc.fullName + " — " + subject, "info", "#stickets");
    res.json({ ok: true, id: String(t._id) });
}));
app.get("/api/tickets/mine", loadAuth, wrap(async (req, res) => { res.json((await TicketModel.find({ uid: req.acc.uid }).sort({ updatedAt: -1 }).limit(60).lean()).map(tkRow)); }));
app.get("/api/staff/tickets", loadAuth, needStaff, wrap(async (req, res) => {
    const f = {}; if (["open", "answered", "closed"].includes(req.query.status)) f.status = req.query.status;
    const q = clip(req.query.q, 40); if (q) { const rx = new RegExp(rxEsc(q), "i"); f.$or = [{ name: rx }, { subject: rx }, ...(/^\d+$/.test(q) ? [{ num: Number(q) }] : [])]; }
    res.json((await TicketModel.find(f).sort({ updatedAt: -1 }).limit(100).lean()).map(tkRow));
}));
app.get("/api/tickets/:id", loadAuth, wrap(async (req, res) => {
    const t = await loadTicket(req, res); if (!t) return; const staff = req.role.admin && t.uid !== req.acc.uid;
    res.json({ ...tkRow(t), messages: t.messages.map(m => ({ from: m.from, name: m.name, text: m.text, at: m.at })), staffView: staff, canClose: t.status !== "closed", canRate: t.uid === req.acc.uid && t.status === "closed" && !t.rating, ratingNote: t.ratingNote });
}));
app.post("/api/tickets/:id/messages", loadAuth, wrap(async (req, res) => {
    const t = await loadTicket(req, res); if (!t) return; if (t.status === "closed") return res.status(400).json({ error: "التذكرة مغلقة" });
    if (!rateLimit("tkm:" + req.acc.uid, 40, 5 * 60000)) return res.status(429).json({ error: "رسائل كثيرة، انتظر شوي" });
    const text = clip((req.body || {}).text, 1500); if (!text) return res.status(400).json({ error: "اكتب الرسالة" });
    if (t.messages.length >= 200) return res.status(400).json({ error: "التذكرة وصلت الحد الأقصى من الرسائل" });
    const staff = req.role.admin && t.uid !== req.acc.uid;
    t.messages.push({ from: staff ? "staff" : "user", uid: req.acc.uid, name: staff ? "الدعم — " + req.acc.fullName : req.acc.fullName, text }); t.updatedAt = new Date();
    if (staff) { t.status = "answered"; if (!t.assignedUid) { t.assignedUid = req.acc.uid; t.assignedName = req.acc.fullName; } await t.save(); await notify(t.uid, "🎫 رد على تذكرتك #" + t.num, text, "info", "#tickets"); }
    else { t.status = "open"; await t.save(); if (t.assignedUid) await notify(t.assignedUid, "🎫 رد جديد #" + t.num, req.acc.fullName + ": " + text, "info", "#stickets"); else for (const u of await staffUids()) await notify(u, "🎫 رد جديد #" + t.num, req.acc.fullName + ": " + text, "info", "#stickets"); }
    res.json({ ok: true });
}));
app.post("/api/tickets/:id/claim", loadAuth, needStaff, wrap(async (req, res) => {
    const t = await loadTicket(req, res); if (!t) return; if (t.status === "closed") return res.status(400).json({ error: "التذكرة مغلقة" });
    t.assignedUid = req.acc.uid; t.assignedName = req.acc.fullName; await t.save();
    await notify(t.uid, "🎫 تذكرتك #" + t.num, req.acc.fullName + " استلم تذكرتك وبيرد عليك قريب.", "info", "#tickets"); res.json({ ok: true });
}));
app.post("/api/tickets/:id/close", loadAuth, wrap(async (req, res) => {
    const t = await loadTicket(req, res); if (!t) return; if (t.status === "closed") return res.json({ ok: true });
    t.status = "closed"; t.closedByName = req.acc.fullName; t.closedAt = new Date(); t.updatedAt = new Date(); await t.save();
    if (t.uid !== req.acc.uid) await notify(t.uid, "🎫 تم إغلاق تذكرتك #" + t.num, "قيّم خدمة الدعم من تاب «خدمة العملاء».", "success", "#tickets");
    else if (t.assignedUid) await notify(t.assignedUid, "🎫 أغلق العضو التذكرة #" + t.num, t.name, "info", "#stickets");
    res.json({ ok: true });
}));
app.post("/api/tickets/:id/reopen", loadAuth, needStaff, wrap(async (req, res) => {
    const t = await loadTicket(req, res); if (!t) return; t.status = "open"; t.closedAt = null; t.updatedAt = new Date(); await t.save();
    await notify(t.uid, "🎫 أُعيد فتح تذكرتك #" + t.num, "الدعم أعاد فتح تذكرتك.", "info", "#tickets"); res.json({ ok: true });
}));
app.post("/api/tickets/:id/rate", loadAuth, wrap(async (req, res) => {
    const t = await loadTicket(req, res); if (!t) return; if (t.uid !== req.acc.uid || t.status !== "closed" || t.rating) return res.status(400).json({ error: "ما تقدر تقيّم هذي التذكرة" });
    const s = Math.round(Number((req.body || {}).stars)); if (!(s >= 1 && s <= 5)) return res.status(400).json({ error: "اختر من 1 إلى 5" });
    t.rating = s; t.ratingNote = clip((req.body || {}).note, 300); await t.save(); res.json({ ok: true });
}));

// ───────────── ✅ بدون تثبيت: متصفح عادي (نشيل أي Service Worker قديم) ─────────────
app.get("/sw.js", (req, res) => {
    res.set({ "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" });
    res.send("self.addEventListener('install',function(){self.skipWaiting()});self.addEventListener('activate',function(e){e.waitUntil((async function(){try{var k=await caches.keys();await Promise.all(k.map(function(x){return caches.delete(x)}))}catch(x){}try{await self.registration.unregister()}catch(x){}})())});");
});
app.get(["/manifest.json", "/manifest.webmanifest"], (req, res) => res.status(404).type("text").send("not found"));


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
