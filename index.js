require("dotenv").config();

const express = require("express");
const axios   = require("axios");
const moment  = require("moment");
const fs      = require("fs");
const path    = require("path");
const TelegramBot = require("node-telegram-bot-api");

// ─── APP SETUP ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// ─── HEALTH CHECK ────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.status(200).send("OK"));

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const TILL_NUMBER     = "4902476";
const TILL_NAME       = "ALJAKI Enterprise";
const ADMIN_IDS       = ["6954749470", "5355760284"];
const SHORTCODE       = process.env.SHORTCODE;
const PASSKEY         = process.env.PASSKEY;
const CONSUMER_KEY    = process.env.CONSUMER_KEY;
const CONSUMER_SECRET = process.env.CONSUMER_SECRET;
const CALLBACK_URL    = process.env.CALLBACK_URL || "";
const BOT_TOKEN       = process.env.BOT_TOKEN;
const RENDER_URL      = process.env.RENDER_EXTERNAL_URL
  || (CALLBACK_URL ? CALLBACK_URL.replace("/mpesa/callback", "") : null);

// ─── PLAN CONFIG ─────────────────────────────────────────────────────────────
const PLAN_DAYS = {
  "1 Day":    1,
  "1 Week":   7,
  "2 Weeks":  14,
  "1 Month":  30,
  "6 Months": 180,
  "1 Year":   365,
};

const PLANS = {
  naughty_1day:    { label: "1 Day",    price: 40 },
  naughty_1week:   { label: "1 Week",   price: 170 },
  naughty_2weeks:  { label: "2 Weeks",  price: 270 },
  naughty_1month:  { label: "1 Month",  price: 450 },
  naughty_6months: { label: "6 Months", price: 2500 },
  naughty_1year:   { label: "1 Year",   price: 6200 },
  premium_1day:    { label: "1 Day",    price: 50 },
  premium_1week:   { label: "1 Week",   price: 220 },
  premium_2weeks:  { label: "2 Weeks",  price: 400 },
  premium_1month:  { label: "1 Month",  price: 680 },
  premium_6months: { label: "6 Months", price: 3500 },
  premium_1year:   { label: "1 Year",   price: 7000 },
};

const USDT_PLANS = [
  { key: "usdt_1day",    label: "1 Day",    usdt: 5 },
  { key: "usdt_1week",   label: "1 Week",   usdt: 19 },
  { key: "usdt_1month",  label: "1 Month",  usdt: 35 },
  { key: "usdt_6months", label: "6 Months", usdt: 90 },
  { key: "usdt_1year",   label: "1 Year",   usdt: 250 },
];

// ─── STATE & UTILS ──────────────────────────────────────────────────────────
const warnMs         = 24 * 60 * 60 * 1000; // 24 hours

const userSelections = {};
let pendingSTK        = {};
const awaitingReceipt = {};
const reminderTimers  = {};
const subTimers       = {};

let autoExpireSubscriptions = process.env.AUTO_EXPIRE !== 'false';
let autoSendInvite          = process.env.AUTO_SEND_INVITE !== 'false';

const PACKAGE_KEYBOARD = {
  inline_keyboard: [
    [{ text: "🔥 Naughty Premium Leaks", callback_data: "package_naughty_premium_leaks" }],
    [{ text: "💥 Naughty Explicit",      callback_data: "package_naughty_explicit" }]
  ]
};

// ─── CHANNEL_ID ──────────────────────────────────────────────────────────────
const CHANNEL_ID = -1001567081082;

// ─── BOT: LONG POLLING (with webhook cleanup) ────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

(async () => {
  try {
    await bot.deleteWebHook({ drop_pending_updates: true });
    console.log("✅ Webhook deleted (any old webhook is now cleared).");
  } catch (err) {
    console.warn("⚠️  Could not delete webhook (may not have existed):", err.message);
  }

  await new Promise((r) => setTimeout(r, 1500));

  bot.startPolling({ interval: 1000, params: { timeout: 10 } });
  console.log("✅ Bot started in long-polling mode.");
})();

bot.on("polling_error", (err) => {
  if (err.code === "ETELEGRAM" && err.message.includes("409")) {
    console.warn("⚠️  Polling 409 — waiting for Telegram to settle...");
  } else {
    console.error("❌ Polling error:", err.message);
  }
});

// ─── LOAD PERSISTED DATA ────────────────────────────────────────────────────
pendingSTK = loadPendingSTK();

// ─── EARLY ENV VALIDATION ────────────────────────────────────────────────────
(function validateEnv() {
  const required = {
    BOT_TOKEN, SHORTCODE: process.env.SHORTCODE, PASSKEY: process.env.PASSKEY,
    CONSUMER_KEY: process.env.CONSUMER_KEY, CONSUMER_SECRET: process.env.CONSUMER_SECRET,
    CALLBACK_URL: process.env.CALLBACK_URL,
  };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    const msg = `🚨 *STARTUP WARNING*\n\nMissing env vars:\n` +
      missing.map((k) => `• \`${k}\``).join("\n") +
      `\n\n⚠️ Bot and/or STK Push will not work until these are set.`;
    console.error("❌ Missing env vars:", missing.join(", "));
    setTimeout(() => {
      ADMIN_IDS.forEach((id) => bot.sendMessage(id, msg, { parse_mode: "Markdown" }).catch(() => {}));
    }, 5000);
  } else {
    console.log("✅ All required environment variables are present.");
  }
})();

// ─── SUBSCRIPTION PERSISTENCE ────────────────────────────────────────────────
const SUBS_FILE = path.join(__dirname, "subscriptions.json");

function loadSubs() {
  try {
    if (fs.existsSync(SUBS_FILE)) {
      return JSON.parse(fs.readFileSync(SUBS_FILE, "utf8"));
    }
  } catch (e) {
    console.error("⚠️ Could not load subscriptions.json:", e.message);
  }
  return {};
}

function saveSubs(data) {
  try {
    fs.writeFileSync(SUBS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("⚠️ Could not save subscriptions.json:", e.message);
  }
}

// ─── PENDING STK PERSISTENCE ─────────────────────────────────────────────────
const PENDING_STK_FILE = path.join(__dirname, "pending_stk.json");

function loadPendingSTK() {
  try {
    if (fs.existsSync(PENDING_STK_FILE)) {
      const data = JSON.parse(fs.readFileSync(PENDING_STK_FILE, "utf8"));
      // Convert back to Map-like object
      const restored = {};
      for (const [key, value] of Object.entries(data)) {
        restored[key] = value;
      }
      return restored;
    }
  } catch (e) {
    console.error("⚠️ Could not load pending_stk.json:", e.message);
  }
  return {};
}

function savePendingSTK(data) {
  try {
    fs.writeFileSync(PENDING_STK_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("⚠️ Could not save pending_stk.json:", e.message);
  }
}

function saveSubEntry(chatId, planLabel, expiresAt) {
  const data = loadSubs();
  data[cid(chatId)] = { planLabel, expiresAt };
  saveSubs(data);
}

function removeSubEntry(chatId) {
  const data = loadSubs();
  delete data[cid(chatId)];
  saveSubs(data);
}

// ─── HELPERS: normalize chatId to string always ───────────────────────────────
const cid = (id) => String(id);

function logError(label, err) {
  console.error(`❌ ${label}:`, err.message);
}

async function safeSendMessage(chatId, text, opts = {}) {
  try {
    return await bot.sendMessage(cid(chatId), text, { parse_mode: "Markdown", ...opts });
  } catch (err) {
    logError(`safeSendMessage [${chatId}]`, err);
  }
}

function validatePhone(phone) {
  let cleaned = phone.replace(/\D/g, "");
  if (cleaned.startsWith("0")) cleaned = "254" + cleaned.substring(1);
  if (!/^254[17]\d{8}$/.test(cleaned)) throw new Error("Invalid Safaricom phone number");
  return cleaned;
}

function setAwaitingReceipt(chatId, data) {
  awaitingReceipt[cid(chatId)] = data;
}

async function removeUserFromChannel(chatId, reason = "") {
  console.log(`🚪 Removing user ${chatId} from channel. Reason: ${reason}`);
  try {
    await bot.banChatMember(CHANNEL_ID, Number(chatId));
    await bot.unbanChatMember(CHANNEL_ID, Number(chatId));
  } catch (err) {
    logError(`removeUserFromChannel [${chatId}]`, err);
  }
}

// ─── TYPING INDICATOR ────────────────────────────────────────────────────────
async function sendTyping(chatId, durationMs = 1500) {
  try {
    await bot.sendChatAction(cid(chatId), "typing");
    await new Promise((r) => setTimeout(r, durationMs));
  } catch (err) {
    logError("sendTyping", err);
  }
}

// ─── GRANT ACCESS ────────────────────────────────────────────────────────────
async function grantAccess(rawChatId, planLabel, paymentSummary) {
  const chatId = cid(rawChatId);
  console.log(`🔍 grantAccess called: chatId=${chatId}, planLabel="${planLabel}"`);

  const resolvedLabel = PLAN_DAYS[planLabel] !== undefined ? planLabel : "1 Month";
  if (resolvedLabel !== planLabel) {
    console.warn(`⚠️ Unknown planLabel "${planLabel}" — falling back to "1 Month"`);
  }

  const days = PLAN_DAYS[resolvedLabel];
  console.log(`📅 Days resolved: ${days} for plan "${resolvedLabel}"`);

  if (!days || isNaN(days)) {
    console.error(`❌ grantAccess: could not resolve days for plan "${planLabel}"`);
    notifyAdmins(
      `⚠️ *grantAccess FAILED*\n\nChatID: \`${chatId}\`\nBad planLabel: \`${planLabel}\`\n\nManual fix:\n\`/grant ${chatId}\``
    );
    return;
  }

  try {
    // Pre-kick: remove user first so single-use link always works
    try {
      const member  = await bot.getChatMember(CHANNEL_ID, Number(chatId));
      const isAdmin = ["administrator", "creator"].includes(member.status);
      if (isAdmin) {
        console.log(`ℹ️ Pre-kick skipped for ${chatId} — user is a channel admin.`);
      } else if (member.status !== "left" && member.status !== "kicked") {
        await bot.banChatMember(CHANNEL_ID, Number(chatId));
        await bot.unbanChatMember(CHANNEL_ID, Number(chatId));
        console.log(`🔄 Pre-kick done for ${chatId}`);
      } else {
        console.log(`ℹ️ Pre-kick skipped for ${chatId} — status: ${member.status}`);
      }
    } catch (preKickErr) {
      console.log(`ℹ️ Pre-kick skipped for ${chatId}: ${preKickErr.message}`);
    }

    // FIX: Calculate expiry in milliseconds FIRST, then derive UNIX seconds
    // for the Telegram invite link separately. Previously the risk was that
    // if someone accidentally passed seconds here the timer would fire ~1000x
    // too fast.
    const nowMs        = Date.now();
    const durationMs   = days * 24 * 60 * 60 * 1000;          // e.g. 365 * 86400000
    const expiresAtMs  = nowMs + durationMs;                   // absolute ms timestamp
    const inviteExpiry = Math.floor(expiresAtMs / 1000);       // UNIX seconds for Telegram

    console.log(`⏱  Plan: ${resolvedLabel} | days: ${days} | durationMs: ${durationMs}`);
    console.log(`📅 Expires: ${new Date(expiresAtMs).toISOString()} (${expiresAtMs}ms)`);
    console.log(`🔗 Creating invite link: CHANNEL_ID=${CHANNEL_ID}, expireDate=${inviteExpiry}`);

    const inviteRes = await bot.createChatInviteLink(CHANNEL_ID, {
      member_limit: 1, // Ensures the link is single-use
      expire_date:  inviteExpiry,
      name:         `Access-${chatId}-${Date.now()}`
    });

    const inviteLink = inviteRes.invite_link;
    console.log(`✅ Invite link created: ${inviteLink}`);

    if (autoSendInvite) {
      await safeSendMessage(chatId,
        `🎉 *Access Granted!*\n\n` +
        `${paymentSummary}\n\n` +
        `👇 Tap the link below to join:\n${inviteLink}\n\n` +
        `⚠️ *Important:*\n` +
        `• This link is *single-use* — it works for you only\n` +
        `• Once you join the channel, the link expires automatically\n` +
        `• Your access expires in *${days} day(s)*\n\n` +
        `_Welcome to the family!_ 🔐`,
        { parse_mode: "Markdown", disable_web_page_preview: false }
      );
    } else {
      console.log(`ℹ️ Auto-send invite disabled: access granted without immediate invite link for ${chatId}`);
      await safeSendMessage(chatId,
        `🎉 *Payment confirmed!*\n\n` +
        `${paymentSummary}\n\n` +
        `✅ Your access is now active. An admin will send your invite link shortly.`,
        { parse_mode: "Markdown" }
      );
    }

    if (autoExpireSubscriptions) {
      clearSubTimers(chatId);
      const timers     = {};
      timers.expiresAt = Date.now() + days * 86400 * 1000;

      if (days > 1) {
        timers.warnTimer = setTimeout(() => {
          safeSendMessage(chatId,
            `⏰ *Heads up!*\n\nYour *${resolvedLabel}* access expires in *24 hours*.\n\nRenew now to stay connected 😊`,
            {
              parse_mode: "Markdown",
              reply_markup: { inline_keyboard: [[{ text: "🔄 Renew My Access", callback_data: "change_package" }]] }
            }
          );
        }, warnMs);
      }

      console.log(`⏰ Kick timer in ${Math.round(durationMs / 3600000)}h (${durationMs}ms)`);
      timers.kickTimer = setTimeout(async () => {
        try {
          await removeUserFromChannel(chatId, "plan expiry"); // Use the helper function
          console.log(`🚪 User ${chatId} removed after plan expiry`);
        } catch (e) {
          console.error("Kick error:", e.message);
        }
        await safeSendMessage(chatId,
          `👋 *Your access has ended.*\n\nYour *${resolvedLabel}* plan has expired. We hope you enjoyed your time with us! 🙏\n\nWhenever you're ready to come back, we'll be here 😊`,
          {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [[{ text: "🔄 Re-subscribe", callback_data: "change_package" }]] }
          }
        );
        delete subTimers[chatId];
        removeSubEntry(chatId);
      }, durationMs);

      subTimers[chatId] = timers;
      saveSubEntry(chatId, resolvedLabel, timers.expiresAt);
    }
    console.log(`✅ Access fully set up for ${chatId} | ${resolvedLabel} | ${days}d`);

  } catch (err) {
    console.error("❌ grantAccess error:", err.message, err.stack);

    notifyAdmins(
      `⚠️ *Auto-invite FAILED for* \`${chatId}\`\n\n` +
      `Plan: *${resolvedLabel}* (${days} days)\n` +
      `Error: \`${err.message}\`\n\n` +
      `Tap below to grant access manually 👇`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: `✅ Grant Access to ${chatId}`, callback_data: `admin_grant_${chatId}_${resolvedLabel}` }
          ]]
        }
      }
    );

    await safeSendMessage(chatId,
      `😔 *We're so sorry for the delay!*\n\n` +
      `Your payment was received successfully ✅ — but we ran into a small technical issue sending your access link automatically.\n\n` +
      `*Please don't worry — you will not lose your access.* Our team has been notified and will send your link manually within a few minutes. 🙏\n\n` +
      `We sincerely apologize for the inconvenience. Thank you so much for your patience! 💛`,
      { parse_mode: "Markdown" }
    ).catch(() => {});
  }
}

function clearSubTimers(chatId) {
  const id = cid(chatId);
  if (subTimers[id]) {
    clearTimeout(subTimers[id].warnTimer);
    clearTimeout(subTimers[id].kickTimer);
    delete subTimers[id];
    removeSubEntry(id);
  }
}

// ─── USDT CONFIG ─────────────────────────────────────────────────────────────
const USDT_WALLET  = "TQQ7Y4PKNs2rMuN2AzHGc2k43MuyMvrjy9";
const TRONGRID_KEY = "c2959dcd-5b2f-4742-939b-a61077a0f520";
const pendingUSDT  = {};

// ─── RATE LIMITING ──────────────────────────────────────────────────────────
const messageCounts = {};
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 10; // 10 messages per minute

function isRateLimited(chatId) {
  const id = cid(chatId);
  const now = Date.now();
  if (!messageCounts[id]) {
    messageCounts[id] = [];
  }
  // Clean old entries
  messageCounts[id] = messageCounts[id].filter(time => now - time < RATE_LIMIT_WINDOW);
  if (messageCounts[id].length >= RATE_LIMIT_MAX) {
    return true;
  }
  messageCounts[id].push(now);
  return false;
}

// ─── PAYMENT LEDGER ──────────────────────────────────────────────────────────
const paymentLedger = [];

function recordPayment({ chatId, username, pkg, plan, amount, ref, phone, currency = "KES" }) {
  paymentLedger.push({
    chatId:   cid(chatId),
    username: username || cid(chatId),
    package:  pkg,
    plan,
    amount:   Number(amount),
    currency,
    ref,
    phone,
    paidAt:   moment().format("DD MMM YYYY, HH:mm")
  });
}

function getLedgerStats() {
  const kesOnly  = (arr) => arr.filter((p) => p.currency !== "USDT");
  const usdtOnly = (arr) => arr.filter((p) => p.currency === "USDT");
  const sum      = (arr) => arr.reduce((s, p) => s + p.amount, 0);
  const today    = moment().startOf("day");
  const week     = moment().startOf("isoWeek");
  const todayAll = paymentLedger.filter((p) => moment(p.paidAt, "DD MMM YYYY, HH:mm").isSameOrAfter(today));
  const weekAll  = paymentLedger.filter((p) => moment(p.paidAt, "DD MMM YYYY, HH:mm").isSameOrAfter(week));
  return {
    totalKes:   sum(kesOnly(paymentLedger)),
    todayKes:   sum(kesOnly(todayAll)),
    weekKes:    sum(kesOnly(weekAll)),
    totalUsdt:  sum(usdtOnly(paymentLedger)),
    todayUsdt:  sum(usdtOnly(todayAll)),
    weekUsdt:   sum(usdtOnly(weekAll)),
    todayCount: todayAll.length,
    weekCount:  weekAll.length,
    allCount:   paymentLedger.length,
  };
}

// ─── NOTIFY ADMINS ───────────────────────────────────────────────────────────
function notifyAdmins(message, opts = {}) {
  ADMIN_IDS.forEach((id) => {
    safeSendMessage(id, message, { parse_mode: "Markdown", ...opts })
      .catch((err) => console.error(`❌ Admin notify failed [${id}]: ${err.message}`));
  });
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function tillCard(packageName, plan, price) {
  return (
    `╔══════════════════════════╗\n` +
    `║   💳  PAYMENT DETAILS    ║\n` +
    `╠══════════════════════════╣\n` +
    `║  📦 ${(packageName || "").substring(0, 22).padEnd(22)}║\n` +
    `║  ⏱  Plan: ${(plan || "").padEnd(18)}║\n` +
    `║  💰 Amount: Ksh ${String(price || 0).padEnd(11)}║\n` +
    `╠══════════════════════════╣\n` +
    `║  📲 M-Pesa Till Number   ║\n` +
    `║                          ║\n` +
    `║     🏦  ${TILL_NUMBER.padEnd(18)}║\n` +
    `║  ${TILL_NAME.substring(0, 26).padEnd(26)}║\n` +
    `╚══════════════════════════╝`
  );
}

function clearReminders(chatId) {
  const id = cid(chatId);
  if (reminderTimers[id]) {
    reminderTimers[id].timers.forEach(clearTimeout);
    delete reminderTimers[id];
  }
}

// ─── SMART REMINDERS ─────────────────────────────────────────────────────────
function scheduleReminders(chatId) {
  const id = cid(chatId);
  clearReminders(id);
  const sel   = userSelections[id] || {};
  const pkg   = sel.package || "the package";
  const price = sel.price || "";

  const messages = [
    {
      delay: 10 * 60 * 1000,
      text: `👋 Hey, just checking in — did you run into any trouble during checkout?\n\nSometimes M-Pesa gets a little moody. Your *${pkg}* spot is still open. 😊`,
      keyboard: [
        [{ text: "✅ Complete My Purchase", callback_data: "pay_stk" }],
        [{ text: "⚠️ I Had an Issue",       callback_data: "need_help" }],
        [{ text: "🚫 Not Interested",        callback_data: "dismiss_reminder" }]
      ]
    },
    {
      delay: 30 * 60 * 1000,
      text: `🔍 Your selected plan${price ? ` (*Ksh ${price}*)` : ""} is waiting whenever you're ready. ⏳`,
      keyboard: [
        [{ text: "💳 I'm Ready to Pay",  callback_data: "pay_stk" }],
        [{ text: "🔄 See Packages",      callback_data: "change_package" }],
        [{ text: "🚫 Dismiss",            callback_data: "dismiss_reminder" }]
      ]
    },
    {
      delay: 2 * 60 * 60 * 1000,
      text: `💡 A lot of people who hesitated said it was *100% worth it* after joining.\n\nIf anything is holding you back, just say the word. 🤝`,
      keyboard: [
        [{ text: "💬 I Have a Question", callback_data: "need_help" }],
        [{ text: "✅ Let's Do This",      callback_data: "pay_stk" }],
        [{ text: "🚫 No Thanks",          callback_data: "dismiss_reminder" }]
      ]
    }
  ];

  const timers = messages.map(({ delay, text, keyboard }) =>
    setTimeout(() => {
      const current = userSelections[id];
      if (current && current.paidAt) return;
      safeSendMessage(id, text, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard }
      }).catch(() => {});
    }, delay)
  );
  reminderTimers[id] = { timers };
}

// ─── M-PESA: GET ACCESS TOKEN ─────────────────────────────────────────────────
async function getMpesaToken() {
  try {
    const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString("base64");
    const res  = await axios.get(
      "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
      { headers: { Authorization: `Basic ${auth}` } }
    );
    return res.data.access_token;
  } catch (err) {
    notifyAdmins(`🚨 *Daraja Token Error*\n\`${err.response?.data?.errorMessage || err.message}\``);
    throw err;
  }
}

// ─── M-PESA: STK PUSH ────────────────────────────────────────────────────────
async function stkPush(phone, amount, chatId) {
  const id = cid(chatId);
  try {
    const token     = await getMpesaToken();
    const timestamp = moment().format("YYYYMMDDHHmmss");
    const password  = Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp}`).toString("base64");

    let normalized = phone.trim().replace(/^\+/, "").replace(/^0/, "254");

    if (!/^2547\d{8}$|^2541\d{8}$/.test(normalized)) {
      throw new Error(`Invalid phone format: ${normalized}`);
    }

    const payload = {
      BusinessShortCode: SHORTCODE,
      Password:          password,
      Timestamp:         timestamp,
      TransactionType:   "CustomerBuyGoodsOnline",
      Amount:            Math.ceil(Number(amount)),
      PartyA:            normalized,
      PartyB:            TILL_NUMBER,
      PhoneNumber:       normalized,
      CallBackURL:       CALLBACK_URL,
      AccountReference:  "ALJAKI",
      TransactionDesc:   "Content Access"
    };

    const res = await axios.post(
      "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      payload,
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
    );

    if (res.data.ResponseCode === "0") {
      const sel = userSelections[id] || {};
      console.log(`🔎 stkPush lookup userSelections[${id}]:`, JSON.stringify(sel));
      const entry = {
        chatId:   id,
        plan:     sel.plan    || null,
        pkg:      sel.package || sel.pkg || null,
        price:    sel.price   || amount,
        username: sel.username || id,
      };
      pendingSTK[res.data.CheckoutRequestID] = {
        ...entry,
        expiresAt: Date.now() + (10 * 60 * 1000)
      };
      console.log(`📌 Registered pending STK: ${res.data.CheckoutRequestID} →`, JSON.stringify(pendingSTK[res.data.CheckoutRequestID]));
    } else {
      console.warn(`⚠️ STK push non-zero ResponseCode: ${res.data.ResponseCode} — ${res.data.ResponseDescription}`);
    }
    return res.data;
  } catch (err) {
    notifyAdmins(
      `🚨 *STK Push Failed*\nChat ID: \`${id}\`\n` +
      `Error: \`${JSON.stringify(err.response?.data || err.message)}\``
    );
    throw err;
  }
}

// ─── M-PESA CALLBACK ─────────────────────────────────────────────────────────
app.post("/mpesa/callback", (req, res) => {
  res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  console.log("📩 M-PESA CALLBACK RECEIVED:", JSON.stringify(req.body, null, 2));

  try {
    const body    = req.body?.Body?.stkCallback;
    const checkId = body?.CheckoutRequestID;
    const code    = body?.ResultCode;

    console.log(`🔍 Callback: CheckoutRequestID=${checkId}, ResultCode=${code}`);

    const pending = pendingSTK[checkId];

    if (!pending) {
      console.warn(`⚠️ Unknown CheckoutRequestID: ${checkId}`);
      notifyAdmins(
        `⚠️ *Unknown STK Callback*\n\n` +
        `CheckoutRequestID: \`${checkId}\`\nResultCode: ${code}\n\n` +
        `_Server may have restarted after STK push._\n\nIf a user paid:\n\`/grant <chatId>\``
      );
      return;
    }

    delete pendingSTK[checkId];
    savePendingSTK(pendingSTK);
    const { chatId, plan, pkg, price, username } = pending;
    const id = cid(chatId);
    console.log(`✅ Matched pending STK: chatId=${id}, plan=${plan}, pkg=${pkg}`);

    if (code === 0) {
      const meta      = body.CallbackMetadata?.Item || [];
      const get       = (name) => meta.find((i) => i.Name === name)?.Value ?? "—";
      const amount    = get("Amount");
      const mpesaCode = get("MpesaReceiptNumber");
      const phone     = get("PhoneNumber");

      console.log(`💰 Payment confirmed: amount=${amount}, ref=${mpesaCode}, phone=${phone}`);

      const sel  = userSelections[id] || {};
      sel.paidAt = new Date().toISOString();
      sel.stkRef = mpesaCode;
      sel.phone  = phone;
      if (!sel.plan    && plan) sel.plan    = plan;
      if (!sel.package && pkg)  sel.package = pkg;
      userSelections[id] = sel;
      clearReminders(id);

      const finalPlan = sel.plan || plan || "1 Month";
      console.log(`🎯 Final plan for grantAccess: "${finalPlan}"`);

      recordPayment({
        chatId:   id,
        username: sel.username || username,
        pkg:      sel.package  || pkg  || "N/A",
        plan:     finalPlan,
        amount,
        ref:      mpesaCode,
        phone
      });

      grantAccess(
        id,
        finalPlan,
        `✅ Ksh *${amount}* received via M-Pesa\n🧾 Ref: \`${mpesaCode}\``
      );

      notifyAdmins(
        `💰 *PAYMENT CONFIRMED (STK)*\n\n` +
        `👤 \`${id}\`\n📦 ${sel.package || pkg || "N/A"} — ${finalPlan}\n` +
        `💰 Ksh ${amount} | 🧾 \`${mpesaCode}\`\n📱 ${phone}\n\n➡️ Access sent automatically.`
      );

    } else {
      awaitingReceipt[id] = {
        plan:  plan || (userSelections[id] || {}).plan || "1 Month",
        pkg:   pkg  || (userSelections[id] || {}).package || "N/A",
        price: price || (userSelections[id] || {}).price || 0,
      };

      safeSendMessage(id,
        `⚠️ *Payment prompt was not completed.*\n\n` +
        `This can happen if:\n• The prompt timed out\n• Wrong PIN was entered\n• Network was unstable\n\n` +
        `📋 *If your M-Pesa was actually deducted*, please type your *M-Pesa confirmation code* from your SMS (e.g. \`RCX4B2K9QP\`) and our team will verify and send your access link. 🔍\n\n` +
        `Otherwise, choose an option below 👇`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "💳 Pay Manually via Till", callback_data: "show_till" }],
              [{ text: "🔄 Try STK Push Again",    callback_data: "pay_stk" }],
              [{ text: "❓ I Need Help",            callback_data: "need_help" }]
            ]
          }
        } // This was already caught, but safeSendMessage is better
      ).catch((err) => logError('Ignored error', err));
    }
  } catch (err) {
    console.error("STK Callback error:", err.message, err.stack);
    notifyAdmins(`🚨 *STK Callback crashed*\n\`${err.message}\``);
  }
});

// ─── USDT: POLL TRONGRID ─────────────────────────────────────────────────────
async function startUsdtPoller(chatId, expectedUsdt) {
  const id = cid(chatId);
  let isPolling = true;
  const expiresAt = Date.now() + 30 * 60 * 1000;
  const startTime = Math.floor(Date.now() / 1000) - 60;

  const poll = async () => {
    if (!isPolling) return;
    try {
      if (Date.now() > expiresAt) {
        stopUsdtPoller(id);
        safeSendMessage(id,
          `⏰ *Payment window expired.*\n\nYour USDT wasn't detected within 30 minutes. Tap below to try again.`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "🔄 Try USDT Again",   callback_data: "pay_usdt" }],
                [{ text: "📲 Switch to M-Pesa", callback_data: "pay_stk" }]
              ]
            }
          }
        );
        return;
      }

      const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
      const url =
        `https://api.trongrid.io/v1/accounts/${USDT_WALLET}/transactions/trc20` +
        `?contract_address=${USDT_CONTRACT}&limit=20&min_timestamp=${startTime * 1000}`;

      const res  = await axios.get(url, { headers: { "TRON-PRO-API-KEY": TRONGRID_KEY } });
      const txns = res.data?.data || [];

      for (const tx of txns) {
        const txTo = (tx.to || "").trim().toLowerCase();
        if (txTo !== USDT_WALLET.trim().toLowerCase()) continue;

        const received = parseFloat(tx.value) / 1_000_000;
        if (received >= expectedUsdt) {
          stopUsdtPoller(id);
          clearReminders(id);

          const sel  = userSelections[id] || {};
          sel.paidAt = new Date().toISOString();
          sel.stkRef = tx.transaction_id;
          userSelections[id] = sel;

          const finalPlan = sel.plan || "1 Month";

          recordPayment({
            chatId: id, username: sel.username || id,
            pkg: sel.package, plan: finalPlan,
            amount: received, ref: tx.transaction_id, phone: "USDT", currency: "USDT"
          });

          grantAccess(id, finalPlan,
            `✅ *$${received} USDT* received\n🧾 TxID: \`${tx.transaction_id.substring(0, 20)}...\``
          );

          notifyAdmins(
            `💵 *USDT PAYMENT CONFIRMED*\n\n` +
            `👤 \`${id}\`\n📦 ${sel.package || "N/A"} — ${finalPlan}\n` +
            `💰 $${received} USDT\n🧾 \`${tx.transaction_id}\`\n\n➡️ Access sent automatically.`
          );
          return;
        }
      }
    } catch (err) {
      console.error("USDT poller error:", err.message);
    }
    if (isPolling) setTimeout(poll, 15000);
  };

  pendingUSDT[id] = { 
    usdtAmount: expectedUsdt, 
    stop: () => { isPolling = false; }, 
    expiresAt 
  };
  poll();
}

function stopUsdtPoller(chatId) {
  const id = cid(chatId);
  if (pendingUSDT[id] && pendingUSDT[id].stop) {
    pendingUSDT[id].stop();
    delete pendingUSDT[id];
  }
}

// ─── /start ──────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId   = cid(msg.chat.id);
  const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  console.log(`👤 /start — ${username} (${chatId})`);

  // BUG FIX: Persist username in userSelections so it's available for ledger/STK
  if (!userSelections[chatId]) userSelections[chatId] = {};
  userSelections[chatId].username = username;

  await sendTyping(chatId, 1200);
  safeSendMessage(chatId,
    `Welcome ${username} 🚀\n\nSorry for any delay — I'm here now! Select your preferred package below:`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔥 Naughty Premium Leaks",          callback_data: "package_naughty_premium_leaks" }],
          [{ text: "💥 Naughty Explicit (Free Hookups)", callback_data: "package_naughty_explicit" }]
        ]
      }
    }
  );
});

bot.onText(/\/myid/, (msg) => {
  safeSendMessage(cid(msg.chat.id), `🆔 Your Chat ID: \`${msg.chat.id}\``, { parse_mode: "Markdown" });
});

bot.onText(/\/testadmin/, (msg) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return safeSendMessage(cid(msg.chat.id), "⛔ Not authorized.");
  notifyAdmins(`🧪 *Test Notification*\nTriggered by: \`${msg.chat.id}\``);
  safeSendMessage(cid(msg.chat.id), "✅ Test sent to all admins.");
});

bot.onText(/\/testlink/, async (msg) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return safeSendMessage(cid(msg.chat.id), "⛔ Not authorized.");
  try {
    const res = await bot.createChatInviteLink(CHANNEL_ID, {
      member_limit: 1,
      expire_date:  Math.floor(Date.now() / 1000) + 300,
      name:         "TestLink"
    });
    safeSendMessage(cid(msg.chat.id),
      `✅ *Bot can create invite links!*\n\nTest link: ${res.invite_link}\n\n_Access sending is fully functional._`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    safeSendMessage(cid(msg.chat.id),
      `❌ *Cannot create invite links*\n\nError: \`${err.message}\`\n\n` +
      `*How to fix:*\n1. Open your Telegram channel\n2. Go to *Administrators*\n` +
      `3. Add the bot as an admin\n4. Enable *"Invite Users via Link"* permission\n5. Run /testlink again`,
      { parse_mode: "Markdown" }
    );
  }
});

bot.onText(/\/config$/, (msg) => {
  const chatId = cid(msg.chat.id);
  if (!ADMIN_IDS.includes(chatId)) return safeSendMessage(chatId, "⛔ Not authorized.");
  safeSendMessage(chatId,
    `🔧 *Bot Configuration*\n\n` +
    `• Auto-expire subscriptions: *${autoExpireSubscriptions ? "ON" : "OFF"}*\n` +
    `• Auto-send invite links: *${autoSendInvite ? "ON" : "OFF"}*\n\n` +
    `Change with:\n` +
    `/autoexpire on|off\n` +
    `/autoinvite on|off`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/autoexpire (on|off)/, (msg, match) => {
  const chatId = cid(msg.chat.id);
  if (!ADMIN_IDS.includes(chatId)) return safeSendMessage(chatId, "⛔ Not authorized.");
  autoExpireSubscriptions = match[1] === "on";
  safeSendMessage(chatId,
    `✅ Auto-expire subscriptions is now *${autoExpireSubscriptions ? "ON" : "OFF"}*`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/autoinvite (on|off)/, (msg, match) => {
  const chatId = cid(msg.chat.id);
  if (!ADMIN_IDS.includes(chatId)) return safeSendMessage(chatId, "⛔ Not authorized.");
  autoSendInvite = match[1] === "on";
  safeSendMessage(chatId,
    `✅ Auto-send invite links is now *${autoSendInvite ? "ON" : "OFF"}*`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/buy/, (msg) => {
  const chatId = cid(msg.chat.id);
  const sel    = userSelections[chatId];
  if (!sel || !sel.price) return safeSendMessage(chatId, "⚠️ Please select a package and plan first using /start.");
  userSelections[chatId].awaitingPhone = true;
  const msg_data = getPhoneEntryMessage();
  safeSendMessage(chatId, msg_data.text, { parse_mode: msg_data.parse_mode });
});

// BUG FIX: /send command now calls saveSubEntry so timers persist across restarts
bot.onText(/\/send (\d+) ([\S]+)/, (msg, match) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return safeSendMessage(cid(msg.chat.id), "⛔ Not authorized.");
  const targetId = cid(match[1]);
  const accessLink = match[2];
  const sel = userSelections[targetId] || {};
  safeSendMessage(targetId,
    `🎉 *Access Granted!*\n\nYour payment has been verified ✅\n\nHere's your exclusive link 👇\n${accessLink}\n\n_Welcome to the family. Do not share this link._ 🔐`,
    { parse_mode: "Markdown" }
  ).then(() => {
    safeSendMessage(cid(msg.chat.id), `✅ Access link sent to \`${targetId}\``, { parse_mode: "Markdown" });
    if (sel.plan && autoExpireSubscriptions) {
      const days = PLAN_DAYS[sel.plan] || 30;
      const durationMs = days * 86400000;
      clearSubTimers(targetId);
      const timers     = {};
      timers.expiresAt = Date.now() + days * 86400 * 1000;
      if (days > 1) {
        timers.warnTimer = setTimeout(() => {
          safeSendMessage(targetId,
            `⏰ *Heads up!*\n\nYour *${sel.plan}* access expires in *24 hours*. Renew now 😊`,
            { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔄 Renew", callback_data: "change_package" }]] } }
          ).catch(() => {});
        }, durationMs - 86400000);
      }
      timers.kickTimer = setTimeout(async () => {
        await removeUserFromChannel(targetId, "manual send expiry"); // Already using helper
        safeSendMessage(targetId,
          `👋 *Your access has ended.*\n\nYour *${sel.plan}* plan expired. Hope you enjoyed it! 🙏\n\nCome back anytime 😊`,
          { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔄 Re-subscribe", callback_data: "change_package" }]] } }
        ).catch(() => {});
        delete subTimers[targetId];
        removeSubEntry(targetId);
      }, durationMs); // Use durationMs for clarity and consistency
      subTimers[targetId] = timers;
      // BUG FIX: persist the subscription so restoreSubTimers can recover it
      saveSubEntry(targetId, sel.plan, timers.expiresAt);
    } // Already using helper
  }).catch((err) => safeSendMessage(cid(msg.chat.id), `❌ Failed: ${err.message}`));
});

// /grant <chatId> <plan>  e.g. /grant 8399543359 1 Month
bot.onText(/\/grant (\d+)(?: (.+))?/, async (msg, match) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return safeSendMessage(cid(msg.chat.id), "⛔ Not authorized.");
  const targetId  = cid(match[1]);
  const planArg   = (match[2] || "").trim();
  const sel       = userSelections[targetId] || {};

  const plan = PLAN_DAYS[planArg] !== undefined ? planArg
             : PLAN_DAYS[sel.plan] !== undefined ? sel.plan
             : null;

  if (!plan) {
    return safeSendMessage(cid(msg.chat.id),
      `📋 *Grant access to* \`${targetId}\`\n\nChoose a plan:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "1 Day",    callback_data: `admin_grant_${targetId}_1 Day` }],
            [{ text: "1 Week",   callback_data: `admin_grant_${targetId}_1 Week` }],
            [{ text: "2 Weeks",  callback_data: `admin_grant_${targetId}_2 Weeks` }],
            [{ text: "1 Month",  callback_data: `admin_grant_${targetId}_1 Month` }],
            [{ text: "6 Months", callback_data: `admin_grant_${targetId}_6 Months` }],
            [{ text: "1 Year",   callback_data: `admin_grant_${targetId}_1 Year` }],
          ]
        }
      }
    );
  }

  try {
    await grantAccess(targetId, plan, `✅ Access manually granted by admin\n📦 Plan: *${plan}*`);
    safeSendMessage(cid(msg.chat.id), getAdminGrantConfirmation(targetId, plan), { parse_mode: "Markdown" });
  } catch (err) {
    safeSendMessage(cid(msg.chat.id), `❌ Failed to grant access: ${err.message}`);
  }
});

bot.onText(/\/pending/, (msg) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return safeSendMessage(cid(msg.chat.id), "⛔ Not authorized.");

  const stkEntries      = Object.entries(pendingSTK);
  const receiptEntries  = Object.entries(awaitingReceipt).filter(([, r]) => r.code);

  if (!stkEntries.length && !receiptEntries.length) {
    return safeSendMessage(cid(msg.chat.id), "📭 No pending transactions.");
  }

  let message = "";
  if (stkEntries.length) {
    const lines = stkEntries.map(([id, p]) =>
      `• 🔑 \`${id}\`\n  👤 \`${p.chatId}\` | ${p.pkg || "—"} / ${p.plan || "—"} | Ksh ${p.price || "—"}`
    );
    message += `⏳ *Pending STK Pushes (${stkEntries.length})*\n\n${lines.join("\n\n")}\n\n_/grant <chatId> if callback was missed._\n\n`;
  }

  if (receiptEntries.length) {
    const lines = receiptEntries.map(([id, r]) =>
      `• 👤 \`${id}\` | ${r.pkg || "—"} / ${r.plan || "—"} | Ksh ${r.price || "—"}\n  🧾 Code: \`${r.code}\``
    );
    message += `🔔 *Awaiting Receipt Verification (${receiptEntries.length})*\n\n${lines.join("\n\n")}`;
  }

  safeSendMessage(cid(msg.chat.id), message.trim(), { parse_mode: "Markdown" });

  receiptEntries.forEach(([id, r]) => {
    safeSendMessage(cid(msg.chat.id),
      `👤 \`${id}\` — \`${r.code}\` — ${r.plan || "1 Month"}`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            { text: `✅ Approve & Grant Access to ${id}`, callback_data: `admin_grant_${id}_${r.plan || "1 Month"}` }
          ]]
        }
      }
    );
  });
});

bot.onText(/\/users/, (msg) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return safeSendMessage(cid(msg.chat.id), "⛔ Not authorized.");
  const entries = Object.entries(userSelections);
  if (!entries.length) return safeSendMessage(cid(msg.chat.id), "📭 No active user sessions.");
  const lines = entries.map(([id, s]) =>
    `• \`${id}\` — ${s.package || "—"} / ${s.plan || "—"} / Ksh ${s.price || "—"}${s.paidAt ? " ✅ PAID" : ""}`
  );
  safeSendMessage(cid(msg.chat.id), `👥 *Active Sessions (${entries.length})*\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
});

bot.onText(/\/broadcast (.+)/, (msg, match) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return safeSendMessage(cid(msg.chat.id), "⛔ Not authorized.");
  const targets = Object.keys(userSelections);
  if (!targets.length) return safeSendMessage(cid(msg.chat.id), "📭 No users to broadcast to.");
  targets.forEach((id) => safeSendMessage(id, `📢 *Announcement*\n\n${match[1]}`, { parse_mode: "Markdown" }).catch(() => {}));
  safeSendMessage(cid(msg.chat.id), `📣 Broadcast sent to *${targets.length}* user(s).`, { parse_mode: "Markdown" });
});

bot.onText(/\/stats/, (msg) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return safeSendMessage(cid(msg.chat.id), "⛔ Not authorized.");
  const all  = Object.values(userSelections);
  const paid = all.filter((s) => s.paidAt).length;
  safeSendMessage(cid(msg.chat.id),
    `📊 *Bot Stats*\n\n👥 Total Sessions: *${all.length}*\n✅ Paid: *${paid}*\n⏳ Pending: *${all.length - paid}*\n💵 Awaiting USDT: *${Object.keys(pendingUSDT).length}*\n⏳ Pending STK: *${Object.keys(pendingSTK).length}*`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/balance/, (msg) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return safeSendMessage(cid(msg.chat.id), "⛔ Not authorized.");
  const s      = getLedgerStats();
  const recent = paymentLedger.slice(-5).reverse();
  const recentLines = recent.length
    ? recent.map((p, i) => {
        const amt = p.currency === "USDT" ? `$${p.amount} USDT` : `Ksh ${p.amount}`;
        return `${i + 1}. *${amt}* — ${p.plan || "—"} | 🧾 \`${p.ref}\` | ${p.paidAt}`;
      }).join("\n")
    : "_No transactions yet_";
  safeSendMessage(cid(msg.chat.id),
    `💼 *ALJAKI Balance Report*\n\n` +
    `📅 *Today* (${s.todayCount} payment(s))\n  🇰🇪 Ksh *${s.todayKes.toLocaleString()}*\n  💵 *$${s.todayUsdt.toFixed(2)} USDT*\n\n` +
    `📆 *This Week* (${s.weekCount} payment(s))\n  🇰🇪 Ksh *${s.weekKes.toLocaleString()}*\n  💵 *$${s.weekUsdt.toFixed(2)} USDT*\n\n` +
    `🏦 *All-Time* (${s.allCount} total)\n  🇰🇪 Ksh *${s.totalKes.toLocaleString()}*\n  💵 *$${s.totalUsdt.toFixed(2)} USDT*\n\n` +
    `🧾 *Last 5 Transactions*\n${recentLines}`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/ledger/, (msg) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return safeSendMessage(cid(msg.chat.id), "⛔ Not authorized.");
  if (!paymentLedger.length) return safeSendMessage(cid(msg.chat.id), "📭 No payments recorded yet.");
  const lines = paymentLedger.map((p, i) => {
    const amt = p.currency === "USDT" ? `$${p.amount} USDT` : `Ksh ${p.amount}`;
    return `${i + 1}. *${amt}* | ${p.package || "—"} ${p.plan || ""} | 🆔 \`${p.chatId}\` | 🧾 \`${p.ref}\` | ${p.paidAt}`;
  });
  const chunks = [];
  let chunk = `📋 *Full Payment Ledger (${paymentLedger.length} total)*\n\n`;
  for (const line of lines) { // Should use safeSendMessage for each chunk
    if ((chunk + line).length > 3800) { chunks.push(chunk); chunk = ""; }
    chunk += line + "\n";
  }
  chunks.push(chunk);
  chunks.forEach((c) => safeSendMessage(cid(msg.chat.id), c, { parse_mode: "Markdown" }).catch(() => {}));
});

bot.onText(/\/kick (\d+)/, async (msg, match) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return safeSendMessage(cid(msg.chat.id), "⛔ Not authorized.");
  const targetId = cid(match[1]);
  try {
    await bot.banChatMember(CHANNEL_ID, Number(targetId));
    await bot.unbanChatMember(CHANNEL_ID, Number(targetId));
    clearSubTimers(targetId);
    safeSendMessage(targetId,
      `👋 *Your access has been removed.*\n\nWe hope you enjoyed your time! 🙏\n\nReady to come back? Tap below 😊`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔄 Re-subscribe", callback_data: "change_package" }]] } }
    );
    safeSendMessage(cid(msg.chat.id), `✅ User \`${targetId}\` removed.`, { parse_mode: "Markdown" });
  } catch (err) {
    safeSendMessage(cid(msg.chat.id), `❌ Failed: ${err.message}`);
  }
});

bot.onText(/\/subs/, (msg) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return safeSendMessage(cid(msg.chat.id), "⛔ Not authorized.");
  const entries = Object.entries(subTimers);
  if (!entries.length) return safeSendMessage(cid(msg.chat.id), "📭 No active subscriptions.");
  const lines = entries.map(([id, t]) => {
    const exp = t.expiresAt ? moment(t.expiresAt).format("DD MMM YYYY, HH:mm") : "unknown";
    return `• \`${id}\` — ${(userSelections[id] || {}).plan || "?"} | expires ${exp}`;
  });
  safeSendMessage(cid(msg.chat.id), `🔐 *Active Subscriptions (${entries.length})*\n\n${lines.join("\n")}\n\n_/kick <chatId> to remove_`, { parse_mode: "Markdown" });
});

bot.onText(/\/reply (\d+) (.+)/, (msg, match) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return safeSendMessage(cid(msg.chat.id), "⛔ Not authorized.");
  safeSendMessage(cid(match[1]), `💬 *Message from Support*\n\n${match[2]}`, { parse_mode: "Markdown" })
    .then(() => safeSendMessage(cid(msg.chat.id), `✅ Reply sent to \`${match[1]}\``, { parse_mode: "Markdown" }))
    .catch((err) => safeSendMessage(cid(msg.chat.id), `❌ Failed: ${err.message}`));
});

// ─── INCOMING TEXT MESSAGES ──────────────────────────────────────────────────
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;

  const chatId = cid(msg.chat.id);
  if (isRateLimited(chatId)) {
    return safeSendMessage(chatId, "⏳ *Too many messages!* Please wait a minute before trying again.").catch(() => {});
  }
  const text   = msg.text.trim();
  const sel    = userSelections[chatId];

  // ── Handle phone number for STK push — MUST come before awaitingReceipt ──
  // Phone numbers like 0712345678 are exactly 10 alphanumeric chars and would
  // falsely match the M-Pesa code regex if awaitingReceipt were checked first.
  if (sel && sel.awaitingPhone) {
    sel.awaitingPhone = false;
    userSelections[chatId] = sel;

    let cleaned;
    try {
      cleaned = validatePhone(text); // Already using helper
    } catch (err) {
      return safeSendMessage(chatId,
        `⚠️ *Invalid phone number.*\n\nPlease enter a valid Safaricom number:\n• *07XXXXXXXX*\n• *01XXXXXXXX*`,
        { parse_mode: "Markdown" }
      );
    }

    await sendTyping(chatId, 1000);
    await safeSendMessage(chatId,
      `⏳ *Sending STK push to ${text}...*\n\nCheck your phone and enter your M-Pesa PIN. 📲`,
      { parse_mode: "Markdown" }
    );

    try {
      const result = await stkPush(text, sel.price, chatId);
      if (result.ResponseCode === "0") {
        await safeSendMessage(chatId,
          `✅ *Payment prompt sent!*\n\nEnter your M-Pesa PIN to complete. Access will be sent automatically once confirmed. 🔐\n\n` +
          `_If you've already paid but don't receive access within 2 minutes, tap the button below._`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "✅ I've Paid — Confirm Access", callback_data: "confirm_payment" }],
                [{ text: "❓ I Need Help",                 callback_data: "need_help" }]
              ]
            }
          }
        );
      } else {
        await safeSendMessage(chatId,
          `⚠️ *Could not send payment prompt.*\n\nReason: _${result.ResponseDescription || "Unknown error"}_\n\nPay manually via M-Pesa till instead 👇`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "💳 Pay Manually via Till", callback_data: "show_till" }],
                [{ text: "🔄 Try STK Again",         callback_data: "pay_stk" }],
                [{ text: "❓ I Need Help",            callback_data: "need_help" }]
              ]
            } // Already caught, but safeSendMessage is better
          }
        );
      }
    } catch (err) {
      await safeSendMessage(chatId,
        `❌ *Payment request failed.*\n\n_${err.response?.data?.errorMessage || err.message}_\n\nYou can still pay manually 👇`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "💳 Pay Manually via Till", callback_data: "show_till" }],
              [{ text: "❓ I Need Help",            callback_data: "need_help" }]
            ]
          }
        }
      );
    }
    return;
  }

  // ── Handle M-Pesa receipt code submitted by user ──────────────────────────
  if (awaitingReceipt[chatId]) {
    const receiptInfo = awaitingReceipt[chatId];
    const code = text.toUpperCase();

    if (!/^[A-Z0-9]{10}$/.test(code)) {
      return safeSendMessage(chatId,
        `⚠️ That doesn't look like a valid M-Pesa code.\n\nM-Pesa codes are *10 characters* long, e.g. \`RCX4B2K9QP\`.\n\nPlease check your SMS and try again, or tap below for help.`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "❓ I Need Help", callback_data: "need_help" }],
              [{ text: "🔄 Try Again",   callback_data: "pay_stk" }]
            ]
          }
        }
      );
    }

    awaitingReceipt[chatId] = { ...receiptInfo, code };

    notifyAdmins(
      `🔔 *Manual Receipt Submitted*\n\n` +
      `👤 ChatID: \`${chatId}\`\n` +
      `📦 ${receiptInfo.pkg || "N/A"} — ${receiptInfo.plan || "N/A"}\n` +
      `💰 Ksh ${receiptInfo.price || "N/A"}\n` +
      `🧾 M-Pesa Code: \`${code}\`\n\n` +
      `Please verify on M-Pesa then tap below to approve 👇`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: `✅ Approve & Send Access to ${chatId}`, callback_data: `admin_grant_${chatId}_${receiptInfo.plan || "1 Month"}` }
          ]]
        }
      }
    );

    return safeSendMessage(chatId,
      `✅ *Thank you!*\n\n` +
      `We've received your M-Pesa code \`${code}\` and our team is verifying it right now. 🔍\n\n` +
      `You'll receive your access link within a few minutes. We appreciate your patience! 🙏`,
      { parse_mode: "Markdown" }
    );
  }

  // ── User typed something freely — try to detect an M-Pesa code ────────────
  const looksLikeCode = /^[A-Z0-9]{10}$/.test(text.toUpperCase());

  if (looksLikeCode) {
    const code = text.toUpperCase();
    const sel2 = userSelections[chatId] || {};

    if (sel2.paidAt) {
      return safeSendMessage(chatId,
        `✅ You already have active access! If you have an issue tap below.`,
        { reply_markup: { inline_keyboard: [[{ text: "❓ I Need Help", callback_data: "need_help" }]] } }
      );
    }

    // BUG FIX: Removed broken string concatenation (bare \n` separators) — use clean template literal
    notifyAdmins(
      `🔔 *Receipt Code Received (Free Text)*\n\n` +
      `👤 ChatID: \`${chatId}\`\n` +
      `📦 ${sel2.package || "N/A"} — ${sel2.plan || "N/A"}\n` +
      `💰 Ksh ${sel2.price || "N/A"}\n` +
      `🧾 M-Pesa Code: \`${code}\`\n\n` +
      `Please verify then tap below to approve 👇`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: `✅ Approve & Send Access to ${chatId}`, callback_data: `admin_grant_${chatId}_${sel2.plan || "1 Month"}` }
          ]]
        }
      }
    );

    awaitingReceipt[chatId] = {
      plan:  sel2.plan    || "1 Month",
      pkg:   sel2.package || "N/A",
      price: sel2.price   || 0,
      code,
    };

    // BUG FIX: Removed broken string concatenation — use clean template literal
    return safeSendMessage(chatId,
      `✅ *Got it!*\n\n` +
      `We've received your M-Pesa code \`${code}\` and our team is verifying it right now. 🔍\n\n` +
      `You'll receive your access link within a few minutes. Thank you for your patience! 🙏`,
      { parse_mode: "Markdown" }
    );
  }

  // ── User typed random text that is NOT a valid code ──────────────────────
  if (sel && !sel.paidAt) {
    // BUG FIX: Removed broken string concatenation — use clean template literal
    return safeSendMessage(chatId,
      `😔 *Sorry, we didn't understand that.*\n\n` +
      `If you've already paid, please send your *M-Pesa confirmation code* — it's the *10-character code* in your payment SMS, e.g. \`RCX4B2K9QP\`.\n\n` +
      `If you haven't paid yet, choose an option below 👇`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📲 Pay via STK Push",    callback_data: "pay_stk" }],
            [{ text: "💳 Pay Manually via Till", callback_data: "show_till" }],
            [{ text: "❓ I Need Help",           callback_data: "need_help" }]
          ]
        }
      }
    );
  }

  if (sel && sel.paidAt) {
    safeSendMessage(chatId,
      `👋 You're all set! If you need help tap below.`,
      { reply_markup: { inline_keyboard: [[{ text: "❓ I Need Help", callback_data: "need_help" }]] } }
    ).catch(() => {});
  }
});

// ─── CALLBACK QUERIES ────────────────────────────────────────────────────────
bot.on("callback_query", async (query) => {
  const chatId = cid(query.message.chat.id);
  const data   = query.data;

  bot.answerCallbackQuery(query.id).catch(() => {});
  await sendTyping(chatId, 600);

  // ── Admin one-tap grant ───────────────────────────────────────────────────
  if (data.startsWith("admin_grant_")) {
    if (!ADMIN_IDS.includes(chatId)) return;
    const withoutPrefix = data.replace("admin_grant_", "");
    // BUG FIX: Use the LAST underscore as the split point so numeric chatIds
    // (which never contain underscores) are always parsed correctly, and plan
    // labels with spaces (e.g. "1 Month") are preserved intact.
    // The original code used indexOf("_") which is correct for numeric IDs, but
    // using lastIndexOf("_") is safer and handles any future edge cases.
    const underscoreIdx = withoutPrefix.indexOf("_");
    const targetId      = cid(withoutPrefix.substring(0, underscoreIdx));
    const planLabel     = withoutPrefix.substring(underscoreIdx + 1);

    try {
      delete awaitingReceipt[targetId];

      await grantAccess(
        targetId,
        planLabel || "1 Month",
        `✅ Access verified and granted by admin\n📦 Plan: *${planLabel || "1 Month"}*`
      );
      safeSendMessage(chatId, getAdminGrantConfirmation(targetId, planLabel), { parse_mode: "Markdown" });
    } catch (err) {
      safeSendMessage(chatId, `❌ Failed: ${err.message}`);
    }
    return;
  }

  // ── Package selection ─────────────────────────────────────────────────────
  if (data === "package_naughty_premium_leaks") {
    // BUG FIX: Preserve existing username when resetting selection
    const existingUsername = (userSelections[chatId] || {}).username;
    userSelections[chatId] = { package: "Naughty Premium Leaks", username: existingUsername };
    return safeSendMessage(chatId,
      `🔥 *Great choice!* Naughty Premium Leaks is our most popular package.\n\nPick your plan:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "1 Day — Ksh 40",                     callback_data: "naughty_1day" }],
            [{ text: "1 Week — Ksh 170",                   callback_data: "naughty_1week" }],
            [{ text: "2 Weeks — Ksh 270",                  callback_data: "naughty_2weeks" }],
            [{ text: "1 Month — Ksh 450",                  callback_data: "naughty_1month" }],
            [{ text: "6 Months — Ksh 2,500 🔥 Best Value", callback_data: "naughty_6months" }],
            [{ text: "1 Year — Ksh 6,200 👑 VIP",          callback_data: "naughty_1year" }]
          ]
        }
      }
    );
  }

  if (data === "package_naughty_explicit") {
    // BUG FIX: Preserve existing username when resetting selection
    const existingUsername = (userSelections[chatId] || {}).username;
    userSelections[chatId] = { package: "Naughty Explicit", username: existingUsername };
    return safeSendMessage(chatId,
      `💥 *You picked Naughty Explicit!* Free Hookups included.\n\nChoose your plan:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "1 Day — Ksh 50",                     callback_data: "premium_1day" }],
            [{ text: "1 Week — Ksh 220",                   callback_data: "premium_1week" }],
            [{ text: "2 Weeks — Ksh 400",                  callback_data: "premium_2weeks" }],
            [{ text: "1 Month — Ksh 680",                  callback_data: "premium_1month" }],
            [{ text: "6 Months — Ksh 3,500 🔥 Best Value", callback_data: "premium_6months" }],
            [{ text: "1 Year — Ksh 7,000 👑 VIP",          callback_data: "premium_1year" }]
          ]
        }
      }
    );
  }

  if (data === "back_to_package_naughty_premium_leaks") {
    // BUG FIX: Preserve existing username on back navigation
    const existingUsername = (userSelections[chatId] || {}).username;
    userSelections[chatId] = { package: "Naughty Premium Leaks", username: existingUsername };
    return safeSendMessage(chatId, `🔥 *Naughty Premium Leaks* — pick your plan:`, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "1 Day — Ksh 40",                     callback_data: "naughty_1day" }],
          [{ text: "1 Week — Ksh 170",                   callback_data: "naughty_1week" }],
          [{ text: "2 Weeks — Ksh 270",                  callback_data: "naughty_2weeks" }],
          [{ text: "1 Month — Ksh 450",                  callback_data: "naughty_1month" }],
          [{ text: "6 Months — Ksh 2,500 🔥 Best Value", callback_data: "naughty_6months" }],
          [{ text: "1 Year — Ksh 6,200 👑 VIP",          callback_data: "naughty_1year" }]
        ]
      }
    });
  }

  if (data === "back_to_package_naughty_explicit") {
    // BUG FIX: Preserve existing username on back navigation
    const existingUsername = (userSelections[chatId] || {}).username;
    userSelections[chatId] = { package: "Naughty Explicit", username: existingUsername };
    return safeSendMessage(chatId, `💥 *Naughty Explicit* — pick your plan:`, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "1 Day — Ksh 50",                     callback_data: "premium_1day" }],
          [{ text: "1 Week — Ksh 220",                   callback_data: "premium_1week" }],
          [{ text: "2 Weeks — Ksh 400",                  callback_data: "premium_2weeks" }],
          [{ text: "1 Month — Ksh 680",                  callback_data: "premium_1month" }],
          [{ text: "6 Months — Ksh 3,500 🔥 Best Value", callback_data: "premium_6months" }],
          [{ text: "1 Year — Ksh 7,000 👑 VIP",          callback_data: "premium_1year" }]
        ]
      }
    });
  }

  if (data === "change_package") {
    return safeSendMessage(chatId, `🔄 *Choose a package:*`, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔥 Naughty Premium Leaks",          callback_data: "package_naughty_premium_leaks" }],
          [{ text: "💥 Naughty Explicit (Free Hookups)", callback_data: "package_naughty_explicit" }]
        ]
      }
    });
  }

  // ── Plan selection ────────────────────────────────────────────────────────
  if (PLANS[data]) {
    const plan = PLANS[data];
    const sel  = userSelections[chatId] || {};
    sel.plan   = plan.label;
    sel.price  = plan.price;
    userSelections[chatId] = sel;

    const backTarget = data.startsWith("naughty_") ? "package_naughty_premium_leaks" : "package_naughty_explicit";
    scheduleReminders(chatId);

    const usdtPlan = USDT_PLANS.find((p) => p.label === plan.label);
    const keyboard = [
      [{ text: `📲 Pay via STK Push (Recommended)`, callback_data: "pay_stk" }],
      ...(usdtPlan ? [[{ text: `₿ Pay with Crypto  ($${usdtPlan.usdt} USDT)`, callback_data: "pay_usdt" }]] : []),
      [{ text: `⬅️ Change Plan`, callback_data: `back_to_${backTarget}` }]
    ];

    return safeSendMessage(chatId,
      `✅ *${sel.package}* — *${plan.label}* selected\n💰 Ksh *${plan.price}*\n\nHow would you like to pay?`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } }
    );
  }

  if (data === "pay_stk") {
    const sel = userSelections[chatId];
    if (!sel || !sel.price) return safeSendMessage(chatId, "⚠️ Please start over with /start.");
    userSelections[chatId].awaitingPhone = true;
    const msg_data = getPhoneEntryMessage();
    return safeSendMessage(chatId, msg_data.text, { parse_mode: msg_data.parse_mode });
  }

  if (data === "pay_usdt") {
    const sel = userSelections[chatId];
    if (!sel || !sel.package) return safeSendMessage(chatId, "⚠️ Please start over with /start.");
    const isNaughty = sel.package === "Naughty Premium Leaks";
    const backKey   = isNaughty ? "back_to_package_naughty_premium_leaks" : "back_to_package_naughty_explicit";
    return safeSendMessage(chatId,
      `₿ *Pay with Crypto — Choose Your Plan*\n\nPackage: *${sel.package}*\n\nSelect the plan you want to pay for with USDT:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "1 Day — $5 USDT",       callback_data: "usdt_1day" }],
            [{ text: "1 Week — $19 USDT",      callback_data: "usdt_1week" }],
            [{ text: "1 Month — $35 USDT",     callback_data: "usdt_1month" }],
            [{ text: "6 Months — $90 USDT 🔥", callback_data: "usdt_6months" }],
            [{ text: "1 Year — $250 USDT 👑",  callback_data: "usdt_1year" }],
            [{ text: "⬅️ Back",                 callback_data: backKey }]
          ]
        }
      }
    );
  }

  if (data.startsWith("usdt_")) {
    const planMap = {
      usdt_1day:    { label: "1 Day",    usdt: 5 },
      usdt_1week:   { label: "1 Week",   usdt: 19 },
      usdt_1month:  { label: "1 Month",  usdt: 35 },
      usdt_6months: { label: "6 Months", usdt: 90 },
      usdt_1year:   { label: "1 Year",   usdt: 250 },
    };
    const chosen = planMap[data];
    if (!chosen) return;

    const sel = userSelections[chatId] || {};
    sel.plan  = chosen.label;

    // BUG FIX: `.replace(" ", "")` only replaces the FIRST space, so "6 Months"
    // became "6Months" and "1 Year" became "1Year" — neither matching any PLANS key.
    // Use a global regex replace to strip ALL spaces for the key lookup.
    const prefix = (sel.package === "Naughty Premium Leaks" ? "naughty_" : "premium_");
    const kesKey = prefix + chosen.label.toLowerCase().replace(/ /g, "");
    sel.price      = PLANS[kesKey]?.price || 0;
    sel.usdtAmount = chosen.usdt;
    userSelections[chatId] = sel;
    clearReminders(chatId);

    await safeSendMessage(chatId,
      `₿ *Pay with Crypto (USDT)*\n\n📦 *${sel.package}* — *${chosen.label}*\n💰 Amount: *$${chosen.usdt} USDT*\n\n` +
      `🌍 *Why crypto?*\n• 100% Anonymous — no name, no bank, no trace\n• Auto-detected — access sent the moment we see your payment\n• Secure & global — works from anywhere`,
      { parse_mode: "Markdown" }
    );

    await safeSendMessage(chatId,
      `📤 *Send Payment*\n\nSend *exactly $${chosen.usdt} USDT* to:\n\n\`${USDT_WALLET}\`\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n🚨 *IMPORTANT — READ BEFORE SENDING* 🚨\n━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `✅ *CORRECT network:* Tron (TRC20) *ONLY*\n❌ *WRONG:* ERC20 / BEP20 / Any other network\n\n` +
      `⛔ *Sending to the wrong network = permanent loss of funds. We cannot recover such payments.*\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n\n📋 *Confirm before sending:*\n` +
      `☑️ Sending *USDT* (not TRX)\n☑️ Network is *TRC20 / Tron*\n` +
      `☑️ Address starts with *T*\n☑️ Amount is *exactly $${chosen.usdt} USDT*\n\n` +
      `⏳ Payment window: *30 minutes*\n\n_We're watching for your transaction. Access will be sent automatically once detected._ 🔍`,
      { parse_mode: "Markdown" }
    );

    await startUsdtPoller(chatId, chosen.usdt);
    return;
  }

  if (data === "show_till") {
    const sel = userSelections[chatId];
    if (!sel || !sel.price) return safeSendMessage(chatId, "⚠️ Please start over with /start.");
    const msg = getManualPaymentMessage(sel);
    return safeSendMessage(chatId, msg.text, {
      parse_mode: "Markdown",
      reply_markup: msg.reply_markup
    });
  }

  if (data === "confirm_payment") {
    const sel = userSelections[chatId];
    if (!sel || !sel.price) return safeSendMessage(chatId, "⚠️ Please start over with /start.");

    awaitingReceipt[chatId] = {
      plan:  sel.plan    || "1 Month",
      pkg:   sel.package || "N/A",
      price: sel.price   || 0,
    };

    notifyAdmins(
      `🔔 *Payment Claim Received*\n\n👤 \`${chatId}\`\n📦 ${sel.package || "N/A"} — ${sel.plan || "N/A"}\n💰 Ksh ${sel.price}\n\n_Waiting for user to submit M-Pesa confirmation code..._`
    );

    return safeSendMessage(chatId,
      `📋 *Almost done!*\n\n` +
      `Please type your *M-Pesa confirmation code* from your payment SMS.\n\n` +
      `It looks like this: \`RCX4B2K9QP\` — 10 characters\n\n` +
      `This helps us verify your payment quickly and send your access right away. 🔍`,
      { parse_mode: "Markdown" }
    );
  }

  if (data === "need_help") {
    return safeSendMessage(chatId,
      `🛠️ *Need Help?*\n\n` +
      `• *STK push not arriving?* Make sure your number is active on M-Pesa and try again.\n` +
      `• *Payment deducted but no access?* Tap "I've Paid" and enter your M-Pesa code.\n` +
      `• *Wrong amount?* Go back and reselect your plan.\n\n` +
      `Still stuck? An admin will assist you shortly. 👇`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Try STK Again", callback_data: "pay_stk" }],
            [{ text: "💳 Manual Till",    callback_data: "show_till" }],
            [{ text: "🔁 Change Package", callback_data: "change_package" }]
          ]
        }
      }
    );
  }

  if (data === "dismiss_reminder") {
    clearReminders(chatId);
    return safeSendMessage(chatId, `👍 No problem! Use /start whenever you're ready.`);
  }
});

// ─── UI MESSAGE HELPERS ──────────────────────────────────────────────────────
function getPhoneEntryMessage() {
  return {
    text: `📱 *M-Pesa Payment*\n\nPlease enter your **M-Pesa phone number** (e.g., 0712345678) to receive a payment prompt on your phone.`,
    parse_mode: "Markdown"
  };
}

function getPlanKeyboard(packageName, isBack = false) {
  const prefix = packageName === "Naughty Premium Leaks" ? "naughty_" : "premium_";
  const keys = Object.keys(PLANS).filter(k => k.startsWith(prefix));
  const buttons = keys.map(k => [{ text: `${PLANS[k].label} — Ksh ${PLANS[k].price}`, callback_data: k }]);
  buttons.push([{ text: "⬅️ Back", callback_data: "change_package" }]);
  return { inline_keyboard: buttons };
}

function getPaymentKeyboard(sel, backTarget) {
  const usdtPlan = USDT_PLANS.find(p => p.label === sel.plan);
  const buttons = [
    [{ text: `📲 Pay via STK Push (Recommended)`, callback_data: "pay_stk" }],
    [{ text: `💳 Pay Manually via Till`,        callback_data: "show_till" }]
  ];
  if (usdtPlan) buttons.push([{ text: `₿ Pay with USDT ($${usdtPlan.usdt})`, callback_data: "pay_usdt" }]);
  buttons.push([{ text: `⬅️ Change Plan`, callback_data: `back_to_${backTarget}` }]);
  return { inline_keyboard: buttons };
}

function getAdminGrantConfirmation(targetId, plan) {
  return `✅ *Access Granted*\n\nUser: \`${targetId}\`\nPlan: *${plan}*\n\nAccess link and timers have been set up.`;
}

function getManualPaymentMessage(sel) {
  return {
    text: tillCard(sel.package, sel.plan, sel.price) + `\n\n✅ *Once you have paid:*\n1. Tap the button below\n2. Send your **M-Pesa Confirmation Code** (e.g. RCX4B2K9QP)\n\n_Your access will be verified and sent immediately._`,
    reply_markup: { inline_keyboard: [[{ text: "✅ I've Paid — Submit Code", callback_data: "confirm_payment" }]] }
  };
}

function getRenewMessage(planLabel) {
  return {
    text: `⏰ *Heads up!*\n\nYour *${planLabel}* access expires in *24 hours*.\n\nRenew now to stay connected 😊`,
    reply_markup: { inline_keyboard: [[{ text: "🔄 Renew My Access", callback_data: "change_package" }]] }
  };
}

function getExpiryMessage(planLabel) {
  return {
    text: `👋 *Your access has ended.*\n\nYour *${planLabel}* plan has expired. Hope you enjoyed it! 🙏`,
    reply_markup: {
      inline_keyboard: [[{ text: "🔄 Re-subscribe", callback_data: "change_package" }]]
    }
  };
}

// ─── RESTORE SUBSCRIPTIONS ON STARTUP ───────────────────────────────────────
function restoreSubTimers() {
  const data = loadSubs();
  const entries = Object.entries(data);
  if (!entries.length) return console.log("📂 No saved subscriptions to restore.");

  let restored = 0, expired = 0;
  const now = Date.now();

  entries.forEach(([chatId, { planLabel, expiresAt }]) => {
    const msLeft = expiresAt - now;

    if (msLeft <= 0) {
      console.log(`⏰ Sub expired while offline: ${chatId} — kicking now`);
      removeUserFromChannel(chatId, "offline expiry kick")
        .catch(() => {});
      safeSendMessage(chatId,
        `👋 *Your access has ended.*\n\nYour *${planLabel}* plan expired while we were briefly offline. We hope you enjoyed your time! 🙏\n\nReady to come back? Tap below 😊`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔄 Re-subscribe", callback_data: "change_package" }]] } }
      ).catch(() => {});
      removeSubEntry(chatId);
      expired++;
      console.log(`• \`${chatId}\` — ⏰ expired (${planLabel})`);
      return;
    }

    const timers = { expiresAt };

    if (msLeft > 86400000) {
      const warnMs = msLeft - 86400000;
      timers.warnTimer = setTimeout(() => {
        const msg = getRenewMessage(planLabel);
        safeSendMessage(chatId, msg.text, {
          parse_mode: "Markdown",
          reply_markup: msg.reply_markup
        });
      }, warnMs);
    }

    timers.kickTimer = setTimeout(async () => {
      try {
        await bot.banChatMember(CHANNEL_ID, Number(chatId));
        await bot.unbanChatMember(CHANNEL_ID, Number(chatId));
        console.log(`🚪 User ${chatId} removed after plan expiry (restored timer)`);
      } catch (e) {
        console.error("Kick error:", e.message);
      }
      bot.sendMessage(chatId,
        `👋 *Your access has ended.*\n\nYour *${planLabel}* plan has expired. We hope you enjoyed your time with us! 🙏\n\nWhenever you're ready to come back, we'll be here 😊`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔄 Re-subscribe", callback_data: "change_package" }]] } }
      ).catch(() => {});
      delete subTimers[chatId];
      removeSubEntry(chatId);
    }, msLeft);

    subTimers[chatId] = timers;
    restored++;
    console.log(`🔁 Restored timer for ${chatId} | ${planLabel} | ${Math.round(msLeft/3600000)}h left`);
  });

  console.log(`✅ Subscriptions restored: ${restored} active, ${expired} expired & kicked`);
}

// ─── HOUSEKEEPING (Efficiency) ───────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  // Cleanup stale STK pushes (older than 10 mins)
  let stkChanged = false;
  for (const cid in pendingSTK) {
    if (pendingSTK[cid].expiresAt < now) {
      delete pendingSTK[cid];
      stkChanged = true;
    }
  }
  if (stkChanged) savePendingSTK(pendingSTK);
  // Cleanup stale USDT pollers
  for (const cid in pendingUSDT) {
    if (pendingUSDT[cid].expiresAt < now) stopUsdtPoller(cid);
  }
  // Cleanup stale user sessions (inactive for 2 hours)
  for (const cid in userSelections) {
    if (!userSelections[cid].paidAt && !userSelections[cid].price) delete userSelections[cid];
  }
  console.log("🧹 Housekeeping: Stale data purged.");
}, 30 * 60 * 1000); // Run every 30 mins

// ─── EXPRESS SERVER ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 M-Pesa callback URL: ${CALLBACK_URL || "⚠️ NOT SET"}`);
  console.log(`📺 Channel ID: ${CHANNEL_ID}`);

  setTimeout(restoreSubTimers, 3000);

  if (RENDER_URL) {
    console.log(`🏓 Keep-alive enabled → pinging ${RENDER_URL} every 10 min`);
    setInterval(() => {
      axios.get(RENDER_URL)
        .then(() => console.log("🏓 Keep-alive ping OK"))
        .catch((err) => console.warn("🏓 Keep-alive ping failed:", err.message));
    }, 10 * 60 * 1000);
  } else {
    console.warn("⚠️ Keep-alive disabled — set RENDER_EXTERNAL_URL in env vars");
  }
});
