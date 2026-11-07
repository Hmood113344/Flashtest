// ═══════════════════════════════════════════════════════════════
//  مشغّل واحد لفلاش + البنك على استضافة وحدة (Render)
//  - flash.js  : الموقع + بوت ديسكورد (المنفذ العام PORT)
//  - bank.js   : البنك (منفذ داخلي فقط، فلاش يمرّره على /bank)
//  كل واحد يشتغل في عملية منفصلة، فلو وقع واحد يرجع لحاله والثاني ما يتأثر.
// ═══════════════════════════════════════════════════════════════
const { fork } = require("child_process");
const path = require("path");
const readline = require("readline");

const PUBLIC_PORT = String(process.env.PORT || 10000);
const BANK_PORT = String(process.env.BANK_PORT || 7697);
const PUBLIC_URL = String(process.env.SITE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");

const flashMongo = String(process.env.FLASH_MONGO_URI || process.env.MONGO_URI || "").trim();
const bankMongo = String(process.env.BANK_MONGO_URI || process.env.MONGO_URI || "").trim();

if (!process.env.INTERNAL_API_KEY) console.log("⚠️ INTERNAL_API_KEY غير مضبوط — الربط بين فلاش والبنك ما بيشتغل");
if (!flashMongo) console.log("❌ FLASH_MONGO_URI (أو MONGO_URI) غير مضبوط");
if (!bankMongo) console.log("❌ BANK_MONGO_URI (أو MONGO_URI) غير مضبوط");
if (flashMongo && flashMongo === bankMongo) {
    console.log("⚠️ فلاش والبنك يستخدمون نفس قاعدة البيانات! غيّر اسم القاعدة في أحد الرابطين (FLASH_MONGO_URI / BANK_MONGO_URI) عشان ما تختلط الجداول");
}
if (!PUBLIC_URL) console.log("⚠️ ما لقيت رابط الموقع (SITE_URL أو RENDER_EXTERNAL_URL)");

const services = [
    {
        name: "flash", file: "flash.js",
        env: {
            PORT: PUBLIC_PORT,
            MONGO_URI: flashMongo,
            SITE_URL: PUBLIC_URL,
            BANK_URL: "http://127.0.0.1:" + BANK_PORT,
        },
    },
    {
        name: "bank", file: "bank.js",
        env: {
            PORT: BANK_PORT,
            MONGO_URI: bankMongo,
            FLASH_URL: "http://127.0.0.1:" + PUBLIC_PORT,
            SELF_URL: PUBLIC_URL,
            KEEP_FLASH_ALIVE: "false",
        },
    },
];

let shuttingDown = false;
const children = new Map();

function pipeLogs(stream, tag, out) {
    if (!stream) return;
    readline.createInterface({ input: stream }).on("line", (line) => out.write("[" + tag + "] " + line + "\n"));
}

function start(s, delay) {
    const startedAt = Date.now();
    const child = fork(path.join(__dirname, s.file), [], {
        env: Object.assign({}, process.env, s.env),
        stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    children.set(s.name, child);
    pipeLogs(child.stdout, s.name, process.stdout);
    pipeLogs(child.stderr, s.name, process.stderr);
    console.log("▶️ تشغيل " + s.name + " (pid " + child.pid + ")");
    child.on("exit", (code, signal) => {
        children.delete(s.name);
        if (shuttingDown) return;
        const ranFor = Date.now() - startedAt;
        const next = ranFor > 60000 ? 2000 : Math.min((delay || 2000) * 2, 30000);
        console.log("⚠️ " + s.name + " وقف (code=" + code + ", signal=" + signal + ") — إعادة تشغيل بعد " + Math.round(next / 1000) + " ث");
        setTimeout(() => start(s, next), next);
    });
}

function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("🛑 إيقاف الخدمات...");
    for (const c of children.values()) { try { c.kill("SIGTERM"); } catch (e) {} }
    setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

services.forEach((s) => start(s));
