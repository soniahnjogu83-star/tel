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
  "20 Min Test": 0.0139,
};

const PLANS = {
  naughty_1day:    { label: "1 Day",    price: 40 },
  naughty_1week:   { label: "1 Week",   price: 170 },
  naughty_2weeks:  { label: "2 Weeks",  price: 270 },
  naughty_1month:  { label: "1 Month",  price: 450 },
  naughty_6months: { label: "6 Months", price: 2500 },
  naughty_1year:   { label: "1 Year",   price: 6200 },
  naughty_test:    { label: "20 Min Test", price: 1 },
  premium_1day:    { label: "1 Day",    price: 50 },
  premium_1week:   { label: "1 Week",   price: 220 },
  premium_2weeks:  { label: "2 Weeks",  price: 400 },
  premium_1month:  { label: "1 Month",  price: 680 },
  premium_6months: { label: "6 Months", price: 3500 },
  premium_1year:   { label: "1 Year",   price: 7000 },
  premium_test:    { label: "20 Min Test", price: 1 },
};

const USDT_PLANS = [
  { key: "usdt_1day",    label: "1 Day",    usdt: 5 },
  { key: "usdt_1week",   label: "1 Week",   usdt: 19 },
  { key: "usdt_1month",  label: "1 Month",  usdt: 35 },
  { key: "usdt_6months", label: "6 Months", usdt: 90 },
  { key: "usdt_1year",   label: "1 Year",   usdt: 250 },
];

// ─── STATE & UTILS ──────────────────────────────────────────────────────────
const warnMs         = 24 * 60 * 60 * 1000;

const userSelections = {};
let pendingSTK        = {};
const awaitingReceipt = {};
const reminderTimers  = {};
const subTimers       = {};
const accessAttempts  = {};

let autoExpireSubscriptions = true;
let autoSendInvite          = true;
let botIsReady = false; // Track if bot is ready to respond

// ─── CHANNEL_ID ──────────────────────────────────────────────────────────────
const CHANNEL_ID = -1001567081082;

// ─── BOT INITIALIZATION WITH IMPROVED STARTUP ────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { 
  polling: false,
  request: {
    timeout: 60000,
  }
});

// Global error handlers
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled Rejection:', err);
});

// Improved bot startup function
async function startBot() {
  console.log("🚀 Starting bot...");
  
  try {
    // Try to delete webhook with retries
    for (let i = 0; i < 3; i++) {
      try {
        await bot.deleteWebHook({ drop_pending_updates: true });
        console.log("✅ Webhook deleted");
        break;
      } catch (err) {
        console.log(`Webhook delete attempt ${i + 1} failed: ${err.message}`);
        if (i < 2) await new Promise(r => setTimeout(r, 1000));
      }
    }
    
    await new Promise(r => setTimeout(r, 2000));
    
    // Start polling
    await bot.startPolling({ 
      polling: true,
      interval: 300,
      params: { timeout: 30 }
    });
    
    botIsReady = true;
    console.log("✅ Bot started successfully and is ready to respond!");
    
    // Notify admins
    const botInfo = await bot.getMe();
    console.log(`🤖 Bot: @${botInfo.username}`);
    
    for (const adminId of ADMIN_IDS) {
      try {
        await bot.sendMessage(adminId, `✅ *Bot is online and ready!*\n\nCommands:\n/start - Start the bot\n/testlink - Test channel link\n/myid - Get your chat ID`, { parse_mode: "Markdown" });
      } catch(e) {
        console.log(`Could not notify admin ${adminId}`);
      }
    }
    
  } catch (err) {
    console.error("❌ Failed to start bot:", err.message);
    botIsReady = false;
    // Retry after 10 seconds
    setTimeout(startBot, 10000);
  }
}

// Handle polling errors
bot.on("polling_error", (err) => {
  console.error("❌ Polling error:", err.message);
  if (err.message.includes("409") || err.message.includes("terminated")) {
    console.log("🔄 Restarting bot...");
    botIsReady = false;
    setTimeout(startBot, 5000);
  }
});

// ─── LOAD PERSISTED DATA ────────────────────────────────────────────────────
function loadPendingSTK() {
  try {
    const PENDING_STK_FILE = path.join(__dirname, "pending_stk.json");
    if (fs.existsSync(PENDING_STK_FILE)) {
      return JSON.parse(fs.readFileSync(PENDING_STK_FILE, "utf8"));
    }
  } catch (e) {
    console.error("⚠️ Could not load pending_stk.json:", e.message);
  }
  return {};
}

function savePendingSTK(data) {
  try {
    const PENDING_STK_FILE = path.join(__dirname, "pending_stk.json");
    fs.writeFileSync(PENDING_STK_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("⚠️ Could not save pending_stk.json:", e.message);
  }
}

function loadUserSelections() {
  try {
    const USER_SEL_FILE = path.join(__dirname, "user_selections.json");
    if (fs.existsSync(USER_SEL_FILE)) {
      return JSON.parse(fs.readFileSync(USER_SEL_FILE, "utf8"));
    }
  } catch (e) {
    console.error("⚠️ Could not load user_selections.json:", e.message);
  }
  return {};
}

function saveUserSelection(chatId, data) {
  try {
    const USER_SEL_FILE = path.join(__dirname, "user_selections.json");
    const all = loadUserSelections();
    all[cid(chatId)] = data;
    fs.writeFileSync(USER_SEL_FILE, JSON.stringify(all, null, 2));
  } catch (e) {
    console.error("⚠️ Could not save user_selections.json:", e.message);
  }
}

function deleteUserSelection(chatId) {
  try {
    const USER_SEL_FILE = path.join(__dirname, "user_selections.json");
    const all = loadUserSelections();
    delete all[cid(chatId)];
    fs.writeFileSync(USER_SEL_FILE, JSON.stringify(all, null, 2));
  } catch (e) {
    console.error("⚠️ Could not delete user_selections.json entry:", e.message);
  }
}

function loadSubs() {
  try {
    const SUBS_FILE = path.join(__dirname, "subscriptions.json");
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
    const SUBS_FILE = path.join(__dirname, "subscriptions.json");
    fs.writeFileSync(SUBS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("⚠️ Could not save subscriptions.json:", e.message);
  }
}

pendingSTK = loadPendingSTK();
Object.assign(userSelections, loadUserSelections());

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

// ─── HELPERS ─────────────────────────────────────────────────────────────────
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

async function removeUserFromChannel(chatId, reason = "") {
  console.log(`🚪 Removing user ${chatId} from channel. Reason: ${reason}`);
  try {
    await bot.banChatMember(CHANNEL_ID, Number(chatId));
    await bot.unbanChatMember(CHANNEL_ID, Number(chatId));
    console.log(`✅ User ${chatId} removed successfully`);
  } catch (err) {
    logError(`removeUserFromChannel [${chatId}]`, err);
  }
}

async function sendTyping(chatId, durationMs = 1500) {
  try {
    await bot.sendChatAction(cid(chatId), "typing");
    await new Promise((r) => setTimeout(r, durationMs));
  } catch (err) {
    // Silently fail
  }
}

// ─── GRANT ACCESS ────────────────────────────────────────────────────────────
async function grantAccess(rawChatId, planLabel, paymentSummary) {
  const chatId = cid(rawChatId);
  console.log(`🔍 grantAccess called: chatId=${chatId}, planLabel="${planLabel}"`);

  if (accessAttempts[chatId]) {
    console.log(`⚠️ Grant access already in progress for ${chatId}, skipping duplicate`);
    return;
  }
  accessAttempts[chatId] = true;
  setTimeout(() => { delete accessAttempts[chatId]; }, 10000);

  const resolvedLabel = PLAN_DAYS[planLabel] !== undefined ? planLabel : "1 Month";
  const days = PLAN_DAYS[resolvedLabel];
  
  if (!days || isNaN(days)) {
    console.error(`❌ grantAccess: could not resolve days for plan "${planLabel}"`);
    delete accessAttempts[chatId];
    return;
  }

  try {
    // Verify bot has channel permissions
    try {
      const botMember = await bot.getChatMember(CHANNEL_ID, (await bot.getMe()).id);
      if (!["administrator", "creator"].includes(botMember.status)) {
        throw new Error("Bot is not an admin in the channel");
      }
    } catch (permErr) {
      console.error("❌ Bot permission check failed:", permErr.message);
      await safeSendMessage(chatId,
        `⚠️ *Configuration Error*\n\nThe bot is not properly configured as an admin in the channel.\n\nPlease add the bot as admin with "Invite Users via Link" permission.`,
        { parse_mode: "Markdown" }
      );
      delete accessAttempts[chatId];
      return;
    }

    // Pre-kick user if needed
    try {
      const member = await bot.getChatMember(CHANNEL_ID, Number(chatId));
      const isAdmin = ["administrator", "creator"].includes(member.status);
      if (!isAdmin && member.status !== "left" && member.status !== "kicked") {
        await bot.banChatMember(CHANNEL_ID, Number(chatId));
        await bot.unbanChatMember(CHANNEL_ID, Number(chatId));
        console.log(`🔄 Pre-kick done for ${chatId}`);
      }
    } catch (preKickErr) {
      console.log(`ℹ️ Pre-kick skipped for ${chatId}: ${preKickErr.message}`);
    }

    const nowMs = Date.now();
    let durationMs, expiresAtMs, inviteExpiry;
    
    if (resolvedLabel === "20 Min Test") {
      durationMs = 20 * 60 * 1000;
      expiresAtMs = nowMs + durationMs;
      inviteExpiry = Math.floor(expiresAtMs / 1000);
    } else {
      durationMs = days * 24 * 60 * 60 * 1000;
      expiresAtMs = nowMs + durationMs;
      inviteExpiry = Math.floor(expiresAtMs / 1000);
    }

    console.log(`⏱ Plan: ${resolvedLabel} | durationMs: ${durationMs}`);
    
    const inviteRes = await bot.createChatInviteLink(CHANNEL_ID, {
      member_limit: 1,
      expire_date: inviteExpiry,
      name: `Access-${chatId}-${Date.now()}`
    });

    const inviteLink = inviteRes.invite_link;
    console.log(`✅ Invite link created`);

    const dayText = resolvedLabel === "20 Min Test" ? "20 minutes" : `${days} day(s)`;
    await safeSendMessage(chatId,
      `🎉 *Access Granted!*\n\n${paymentSummary}\n\n👇 *Tap the link below to join the channel:*\n${inviteLink}\n\n` +
      `⚠️ *Important:*\n• This link is *single-use*\n• Your access expires in *${dayText}*\n\n_Welcome to the family!_ 🔐`,
      { parse_mode: "Markdown", disable_web_page_preview: false }
    );

    if (autoExpireSubscriptions) {
      clearSubTimers(chatId);
      
      const kickTimer = setTimeout(async () => {
        try {
          await removeUserFromChannel(chatId, "plan expiry");
          await safeSendMessage(chatId,
            `👋 *Your access has ended.*\n\nYour *${resolvedLabel}* plan has expired.\n\nTap below to renew 😊`,
            {
              parse_mode: "Markdown",
              reply_markup: { inline_keyboard: [[{ text: "🔄 Re-subscribe", callback_data: "change_package" }]] }
            }
          );
        } catch (e) {
          console.error("Kick error:", e.message);
        }
        delete subTimers[chatId];
        removeSubEntry(chatId);
      }, durationMs);
      
      subTimers[chatId] = { expiresAt: expiresAtMs, kickTimer };
      saveSubEntry(chatId, resolvedLabel, expiresAtMs);
    }

    console.log(`✅ Access set up for ${chatId} | ${resolvedLabel}`);
    delete accessAttempts[chatId];

  } catch (err) {
    console.error("❌ grantAccess error:", err.message);
    
    if (!accessAttempts[`${chatId}_error`]) {
      accessAttempts[`${chatId}_error`] = true;
      setTimeout(() => { delete accessAttempts[`${chatId}_error`]; }, 60000);
      
      await safeSendMessage(chatId,
        `✅ *Payment Received!*\n\nYour payment has been confirmed, but we're having a small technical issue.\n\n*Don't worry!* An admin has been notified and will send your access link within 5 minutes. 🙏`,
        { parse_mode: "Markdown" }
      );
      
      notifyAdmins(`⚠️ *Auto-invite FAILED for* \`${chatId}\`\nPlan: *${resolvedLabel}*\nError: \`${err.message}\`\n\n/grant ${chatId} "${resolvedLabel}"`);
    }
    delete accessAttempts[chatId];
  }
}

function clearSubTimers(chatId) {
  const id = cid(chatId);
  if (subTimers[id]) {
    if (subTimers[id].kickTimer) clearTimeout(subTimers[id].kickTimer);
    delete subTimers[id];
    removeSubEntry(id);
  }
}

function notifyAdmins(message, opts = {}) {
  ADMIN_IDS.forEach((id) => {
    safeSendMessage(id, message, { parse_mode: "Markdown", ...opts })
      .catch((err) => console.error(`❌ Admin notify failed [${id}]: ${err.message}`));
  });
}

// ─── M-PESA FUNCTIONS ────────────────────────────────────────────────────────
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
      const entry = {
        chatId:   id,
        plan:     sel.plan    || null,
        pkg:      sel.package || null,
        price:    sel.price   || amount,
        username: sel.username || id,
        expiresAt: Date.now() + (10 * 60 * 1000),
      };
      pendingSTK[res.data.CheckoutRequestID] = entry;
      savePendingSTK(pendingSTK);
      console.log(`📌 Registered pending STK: ${res.data.CheckoutRequestID}`);
    }
    return res.data;
  } catch (err) {
    notifyAdmins(`🚨 *STK Push Failed*\nChat ID: \`${id}\`\nError: \`${err.message}\``);
    throw err;
  }
}

// ─── M-PESA CALLBACK ─────────────────────────────────────────────────────────
app.post("/mpesa/callback", (req, res) => {
  res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  console.log("📩 M-PESA CALLBACK RECEIVED");

  try {
    const body    = req.body?.Body?.stkCallback;
    const checkId = body?.CheckoutRequestID;
    const code    = body?.ResultCode;

    const pending = pendingSTK[checkId];
    if (!pending) return;

    delete pendingSTK[checkId];
    savePendingSTK(pendingSTK);
    
    const { chatId, plan, pkg } = pending;
    const id = cid(chatId);

    if (code === 0) {
      const meta = body.CallbackMetadata?.Item || [];
      const get = (name) => meta.find((i) => i.Name === name)?.Value ?? "—";
      const amount = get("Amount");
      const mpesaCode = get("MpesaReceiptNumber");
      const phone = get("PhoneNumber");

      const sel = userSelections[id] || {};
      sel.paidAt = new Date().toISOString();
      sel.stkRef = mpesaCode;
      if (!sel.plan && plan) sel.plan = plan;
      if (!sel.package && pkg) sel.package = pkg;
      userSelections[id] = sel;
      saveUserSelection(id, sel);

      const finalPlan = sel.plan || plan || "1 Month";
      
      grantAccess(id, finalPlan, `✅ Ksh *${amount}* received via M-Pesa\n🧾 Ref: \`${mpesaCode}\``);
      notifyAdmins(`💰 *PAYMENT CONFIRMED (STK)*\n👤 \`${id}\`\n💰 Ksh ${amount} | 🧾 \`${mpesaCode}\``);
    }
  } catch (err) {
    console.error("STK Callback error:", err.message);
  }
});

// ─── BOT COMMANDS WITH READY CHECK ───────────────────────────────────────────
// Wrapper to ensure bot is ready
function onCommand(regex, handler) {
  bot.onText(regex, async (msg, match) => {
    if (!botIsReady) {
      await safeSendMessage(cid(msg.chat.id), "⏳ Bot is starting up, please wait a moment...");
      return;
    }
    try {
      await handler(msg, match);
    } catch (err) {
      console.error(`Command error:`, err);
      await safeSendMessage(cid(msg.chat.id), `❌ An error occurred. Please try again.`);
    }
  });
}

// /start command
onCommand(/\/start/, async (msg) => {
  const chatId = cid(msg.chat.id);
  const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  console.log(`📱 /start from ${username} (${chatId})`);
  
  if (!userSelections[chatId]) userSelections[chatId] = {};
  userSelections[chatId].username = username;
  saveUserSelection(chatId, userSelections[chatId]);

  await safeSendMessage(chatId,
    `🎉 *Welcome ${username}!*\n\nSelect your package below:`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔥 Naughty Premium Leaks", callback_data: "package_naughty_premium_leaks" }],
          [{ text: "💥 Naughty Explicit", callback_data: "package_naughty_explicit" }],
          [{ text: "🧪 TEST: 20 Min Access (1 KSH)", callback_data: "package_test" }]
        ]
      }
    }
  );
});

// /myid command
onCommand(/\/myid/, (msg) => {
  safeSendMessage(cid(msg.chat.id), `🆔 Your Chat ID: \`${msg.chat.id}\``, { parse_mode: "Markdown" });
});

// /testlink command (admin only)
onCommand(/\/testlink/, async (msg) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) {
    await safeSendMessage(cid(msg.chat.id), "⛔ Not authorized.");
    return;
  }
  try {
    const res = await bot.createChatInviteLink(CHANNEL_ID, {
      member_limit: 1,
      expire_date: Math.floor(Date.now() / 1000) + 300,
    });
    await safeSendMessage(cid(msg.chat.id), `✅ Test link: ${res.invite_link}`);
  } catch (err) {
    await safeSendMessage(cid(msg.chat.id), `❌ Error: ${err.message}\n\nMake sure bot is admin in the channel!`);
  }
});

// /grant command (admin only)
onCommand(/\/grant (\d+)(?: (.+))?/, async (msg, match) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) {
    await safeSendMessage(cid(msg.chat.id), "⛔ Not authorized.");
    return;
  }
  const targetId = cid(match[1]);
  const plan = match[2] || "1 Month";
  
  try {
    await grantAccess(targetId, plan, `✅ Manually granted by admin`);
    await safeSendMessage(cid(msg.chat.id), `✅ Access granted to ${targetId} for ${plan}`);
  } catch (err) {
    await safeSendMessage(cid(msg.chat.id), `❌ Failed: ${err.message}`);
  }
});

// /status command
onCommand(/\/status/, async (msg) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return;
  await safeSendMessage(cid(msg.chat.id),
    `📊 *Bot Status*\n\n` +
    `Bot Ready: ${botIsReady ? "✅" : "❌"}\n` +
    `Pending STK: ${Object.keys(pendingSTK).length}\n` +
    `Active Subs: ${Object.keys(subTimers).length}\n` +
    `Active Users: ${Object.keys(userSelections).length}`,
    { parse_mode: "Markdown" }
  );
});

// ─── CALLBACK QUERY HANDLER ───────────────────────────────────────────────────
bot.on("callback_query", async (query) => {
  const chatId = cid(query.message.chat.id);
  const data = query.data;
  
  await bot.answerCallbackQuery(query.id).catch(() => {});
  
  if (!botIsReady) {
    await safeSendMessage(chatId, "⏳ Bot is starting up, please wait...");
    return;
  }
  
  try {
    if (data === "package_test") {
      userSelections[chatId] = { package: "Test Package", plan: "20 Min Test", price: 1, username: userSelections[chatId]?.username };
      saveUserSelection(chatId, userSelections[chatId]);
      await safeSendMessage(chatId,
        `🧪 *Test Mode - 20 Minute Access*\n💰 Cost: Ksh 1\n\nHow would you like to pay?`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "📲 Pay via STK Push", callback_data: "pay_stk" }],
              [{ text: "💳 Manual via Till", callback_data: "show_till" }]
            ]
          }
        }
      );
      return;
    }
    
    if (data === "package_naughty_premium_leaks") {
      userSelections[chatId] = { package: "Naughty Premium Leaks", username: userSelections[chatId]?.username };
      saveUserSelection(chatId, userSelections[chatId]);
      await safeSendMessage(chatId, `🔥 *Naughty Premium Leaks*\n\nSelect plan:`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "1 Day — Ksh 40", callback_data: "naughty_1day" }],
            [{ text: "1 Week — Ksh 170", callback_data: "naughty_1week" }],
            [{ text: "1 Month — Ksh 450", callback_data: "naughty_1month" }],
            [{ text: "🧪 TEST: 20 Min (1 KSH)", callback_data: "naughty_test" }]
          ]
        }
      });
      return;
    }
    
    if (data === "package_naughty_explicit") {
      userSelections[chatId] = { package: "Naughty Explicit", username: userSelections[chatId]?.username };
      saveUserSelection(chatId, userSelections[chatId]);
      await safeSendMessage(chatId, `💥 *Naughty Explicit*\n\nSelect plan:`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "1 Day — Ksh 50", callback_data: "premium_1day" }],
            [{ text: "1 Week — Ksh 220", callback_data: "premium_1week" }],
            [{ text: "1 Month — Ksh 680", callback_data: "premium_1month" }],
            [{ text: "🧪 TEST: 20 Min (1 KSH)", callback_data: "premium_test" }]
          ]
        }
      });
      return;
    }
    
    if (PLANS[data]) {
      const plan = PLANS[data];
      const sel = userSelections[chatId] || {};
      sel.plan = plan.label;
      sel.price = plan.price;
      userSelections[chatId] = sel;
      saveUserSelection(chatId, sel);
      
      await safeSendMessage(chatId,
        `✅ *${sel.package}* — *${plan.label}*\n💰 Ksh *${plan.price}*\n\nHow to pay?`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "📲 Pay via STK Push", callback_data: "pay_stk" }],
              [{ text: "💳 Manual via Till", callback_data: "show_till" }]
            ]
          }
        }
      );
      return;
    }
    
    if (data === "pay_stk") {
      const sel = userSelections[chatId];
      if (!sel || !sel.price) return;
      userSelections[chatId].awaitingPhone = true;
      saveUserSelection(chatId, userSelections[chatId]);
      await safeSendMessage(chatId, `📱 *Enter your M-Pesa phone number* (e.g., 0712345678):`);
      return;
    }
    
    if (data === "show_till") {
      const sel = userSelections[chatId];
      if (!sel) return;
      await safeSendMessage(chatId,
        `💳 *M-Pesa Till Number:* \`${TILL_NUMBER}\`\n📛 *Business:* ${TILL_NAME}\n💰 *Amount:* Ksh ${sel.price}\n\nSend the exact amount then text \`/verify YOUR_CODE\``
      );
      return;
    }
    
    if (data === "change_package") {
      await safeSendMessage(chatId, `🔄 Choose package:`, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔥 Naughty Premium Leaks", callback_data: "package_naughty_premium_leaks" }],
            [{ text: "💥 Naughty Explicit", callback_data: "package_naughty_explicit" }]
          ]
        }
      });
      return;
    }
    
  } catch (err) {
    console.error("Callback error:", err);
    await safeSendMessage(chatId, `❌ Error: ${err.message}`);
  }
});

// ─── TEXT MESSAGE HANDLER ─────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  if (!botIsReady) return;
  
  const chatId = cid(msg.chat.id);
  const text = msg.text.trim();
  const sel = userSelections[chatId];
  
  try {
    // Handle phone number input
    if (sel && sel.awaitingPhone) {
      sel.awaitingPhone = false;
      saveUserSelection(chatId, sel);
      
      try {
        const cleaned = validatePhone(text);
        await safeSendMessage(chatId, `⏳ Sending STK push to ${text}...`);
        const result = await stkPush(text, sel.price, chatId);
        
        if (result.ResponseCode === "0") {
          await safeSendMessage(chatId,
            `✅ *Payment prompt sent!*\n\nEnter your M-Pesa PIN to complete.\n\n` +
            `Already paid? Send your 10-character M-Pesa code to get access immediately.`
          );
        } else {
          await safeSendMessage(chatId, `⚠️ Could not send prompt. Try manual payment.`);
        }
      } catch (err) {
        await safeSendMessage(chatId, `❌ Invalid number. Try again with /start`);
      }
      return;
    }
    
    // AUTO-APPROVAL: 10-character code
    if (/^[A-Z0-9]{10}$/i.test(text)) {
      const code = text.toUpperCase();
      
      if (sel && sel.paidAt) {
        await safeSendMessage(chatId, `✅ You already have active access!`);
        return;
      }
      
      if (!sel || !sel.price) {
        await safeSendMessage(chatId, `⚠️ Please select a package first using /start`);
        return;
      }
      
      sel.paidAt = new Date().toISOString();
      sel.stkRef = code;
      sel.autoApproved = true;
      userSelections[chatId] = sel;
      saveUserSelection(chatId, sel);
      
      await grantAccess(chatId, sel.plan || "1 Month", `✅ Code \`${code}\` verified\n💰 Amount: Ksh ${sel.price}`);
      return;
    }
    
    // Default response
    if (sel && !sel.paidAt) {
      await safeSendMessage(chatId,
        `Send your *10-character M-Pesa code* (e.g., \`RCX4B2K9QP\`) to get access immediately.\n\n` +
        `Or use /start to select a package.`
      );
    }
  } catch (err) {
    console.error("Message handler error:", err);
  }
});

// ─── API ENDPOINTS ───────────────────────────────────────────────────────────
app.get("/api/status", (req, res) => {
  res.json({
    status: "online",
    botReady: botIsReady,
    autoApprove: true,
    pendingSTKCount: Object.keys(pendingSTK).length,
    activeSubscriptions: Object.keys(subTimers).length,
    activeSessions: Object.keys(userSelections).length,
    timestamp: new Date().toISOString()
  });
});

app.post("/api/approve-by-code", async (req, res) => {
  try {
    const { receiptCode, chatId, plan } = req.body;
    
    if (!receiptCode || !chatId) {
      return res.status(400).json({ success: false, error: "receiptCode and chatId are required" });
    }
    
    const id = cid(chatId);
    const sel = userSelections[id] || {};
    
    if (!/^[A-Z0-9]{10}$/.test(receiptCode.toUpperCase())) {
      return res.status(400).json({ success: false, error: "Invalid receipt code format" });
    }
    
    const finalPlan = plan || sel.plan || "1 Month";
    
    sel.paidAt = new Date().toISOString();
    sel.stkRef = receiptCode.toUpperCase();
    sel.apiApproved = true;
    userSelections[id] = sel;
    saveUserSelection(id, sel);
    
    await grantAccess(id, finalPlan, `✅ API approved with code: ${receiptCode.toUpperCase()}`);
    
    return res.json({ success: true, message: "Access granted successfully" });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── START BOT AND SERVER ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📺 Channel ID: ${CHANNEL_ID}`);
});

// Start the bot after server is up
startBot();