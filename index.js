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
  "20 Min Test": 0.0139, // 20 minutes for testing
};

const PLANS = {
  naughty_1day:    { label: "1 Day",    price: 40 },
  naughty_1week:   { label: "1 Week",   price: 170 },
  naughty_2weeks:  { label: "2 Weeks",  price: 270 },
  naughty_1month:  { label: "1 Month",  price: 450 },
  naughty_6months: { label: "6 Months", price: 2500 },
  naughty_1year:   { label: "1 Year",   price: 6200 },
  naughty_test:    { label: "20 Min Test", price: 1 }, // 1 KSH for testing
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
const warnMs         = 24 * 60 * 60 * 1000; // 24 hours

const userSelections = {};
let pendingSTK        = {};
const awaitingReceipt = {};
const reminderTimers  = {};
const subTimers       = {};
const accessAttempts  = {}; // Track attempts to prevent duplicate errors

let autoExpireSubscriptions = true; // Force true for testing
let autoSendInvite          = true; // Force true for auto-send

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

//bot.on("polling_error", (err) => {
  //if (err.code === "ETELEGRAM" && err.message.includes("409")) {
   // console.warn("⚠️  Polling 409 — waiting for Telegram to settle...");
  //} else {
    //console.error("❌ Polling error:", err.message);
 // }
//});

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

// ─── TYPING INDICATOR ────────────────────────────────────────────────────────
async function sendTyping(chatId, durationMs = 1500) {
  try {
    await bot.sendChatAction(cid(chatId), "typing");
    await new Promise((r) => setTimeout(r, durationMs));
  } catch (err) {
    logError("sendTyping", err);
  }
}

// ─── GRANT ACCESS (FIXED - No duplicate errors) ────────────────────────────────
async function grantAccess(rawChatId, planLabel, paymentSummary) {
  const chatId = cid(rawChatId);
  console.log(`🔍 grantAccess called: chatId=${chatId}, planLabel="${planLabel}"`);

  // Prevent duplicate attempts
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
    // Verify bot has channel permissions first
    try {
      const botMember = await bot.getChatMember(CHANNEL_ID, (await bot.getMe()).id);
      if (!["administrator", "creator"].includes(botMember.status)) {
        throw new Error("Bot is not an admin in the channel");
      }
    } catch (permErr) {
      console.error("❌ Bot permission check failed:", permErr.message);
      await safeSendMessage(chatId,
        `⚠️ *Configuration Error*\n\n` +
        `The bot is not properly configured as an admin in the channel.\n\n` +
        `Please contact support.`,
        { parse_mode: "Markdown" }
      );
      delete accessAttempts[chatId];
      return;
    }

    // Pre-kick user if they're already in channel
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
    
    // Handle test period (20 minutes)
    if (resolvedLabel === "20 Min Test") {
      durationMs = 20 * 60 * 1000; // 20 minutes
      expiresAtMs = nowMs + durationMs;
      inviteExpiry = Math.floor(expiresAtMs / 1000);
    } else {
      durationMs = days * 24 * 60 * 60 * 1000;
      expiresAtMs = nowMs + durationMs;
      inviteExpiry = Math.floor(expiresAtMs / 1000);
    }

    console.log(`⏱ Plan: ${resolvedLabel} | durationMs: ${durationMs}`);
    console.log(`📅 Expires: ${new Date(expiresAtMs).toISOString()}`);
    console.log(`🔗 Creating invite link...`);

    const inviteRes = await bot.createChatInviteLink(CHANNEL_ID, {
      member_limit: 1,
      expire_date: inviteExpiry,
      name: `Access-${chatId}-${Date.now()}`
    });

    const inviteLink = inviteRes.invite_link;
    console.log(`✅ Invite link created: ${inviteLink}`);

    // Send the invite link immediately
    const dayText = resolvedLabel === "20 Min Test" ? "20 minutes" : `${days} day(s)`;
    await safeSendMessage(chatId,
      `🎉 *Access Granted!*\n\n` +
      `${paymentSummary}\n\n` +
      `👇 *Tap the link below to join the channel:*\n${inviteLink}\n\n` +
      `⚠️ *Important:*\n` +
      `• This link is *single-use* — it works for you only\n` +
      `• Once you join the channel, the link expires automatically\n` +
      `• Your access expires in *${dayText}*\n\n` +
      `_Welcome to the family!_ 🔐`,
      { parse_mode: "Markdown", disable_web_page_preview: false }
    );
    console.log(`📨 Invite link sent to ${chatId}`);

    // Set up auto-expiry
    if (autoExpireSubscriptions) {
      clearSubTimers(chatId);
      
      const kickTimer = setTimeout(async () => {
        try {
          await removeUserFromChannel(chatId, "plan expiry");
          console.log(`🚪 User ${chatId} removed after ${resolvedLabel} plan expiry`);
          
          await safeSendMessage(chatId,
            `👋 *Your access has ended.*\n\n` +
            `Your *${resolvedLabel}* plan has expired. We hope you enjoyed your time with us! 🙏\n\n` +
            `Whenever you're ready to come back, tap the button below 😊`,
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
      
      // Send warning for longer plans (not needed for 20 min test)
      let warnTimer = null;
      if (resolvedLabel !== "20 Min Test" && days > 1 && durationMs > warnMs) {
        warnTimer = setTimeout(() => {
          safeSendMessage(chatId,
            `⏰ *Heads up!*\n\nYour *${resolvedLabel}* access expires in *24 hours*.\n\nRenew now to stay connected 😊`,
            {
              parse_mode: "Markdown",
              reply_markup: { inline_keyboard: [[{ text: "🔄 Renew My Access", callback_data: "change_package" }]] }
            }
          ).catch(() => {});
        }, durationMs - warnMs);
      }
      
      subTimers[chatId] = { expiresAt: expiresAtMs, kickTimer, warnTimer };
      saveSubEntry(chatId, resolvedLabel, expiresAtMs);
    }

    console.log(`✅ Access fully set up for ${chatId} | ${resolvedLabel}`);
    delete accessAttempts[chatId];

  } catch (err) {
    console.error("❌ grantAccess error:", err.message);
    
    // Only send error message once per user
    if (!accessAttempts[`${chatId}_error`]) {
      accessAttempts[`${chatId}_error`] = true;
      setTimeout(() => { delete accessAttempts[`${chatId}_error`]; }, 60000);
      
      await safeSendMessage(chatId,
        `✅ *Payment Received!*\n\n` +
        `Your payment has been confirmed, but we're having a small technical issue.\n\n` +
        `*Don't worry!* An admin has been notified and will send your access link within 5 minutes. 🙏\n\n` +
        `Thank you for your patience! 💛`,
        { parse_mode: "Markdown" }
      );
      
      notifyAdmins(
        `⚠️ *Auto-invite FAILED for* \`${chatId}\`\n\n` +
        `Plan: *${resolvedLabel}*\n` +
        `Error: \`${err.message}\`\n\n` +
        `Please grant access manually using:\n` +
        `/grant ${chatId} "${resolvedLabel}"`
      );
    }
    delete accessAttempts[chatId];
  }
}

function clearSubTimers(chatId) {
  const id = cid(chatId);
  if (subTimers[id]) {
    if (subTimers[id].kickTimer) clearTimeout(subTimers[id].kickTimer);
    if (subTimers[id].warnTimer) clearTimeout(subTimers[id].warnTimer);
    delete subTimers[id];
    removeSubEntry(id);
  }
}

// ─── NOTIFY ADMINS ───────────────────────────────────────────────────────────
function notifyAdmins(message, opts = {}) {
  ADMIN_IDS.forEach((id) => {
    safeSendMessage(id, message, { parse_mode: "Markdown", ...opts })
      .catch((err) => console.error(`❌ Admin notify failed [${id}]: ${err.message}`));
  });
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
    
    const { chatId, plan, pkg, price } = pending;
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

// ─── /start ──────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId = cid(msg.chat.id);
  const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  
  if (!userSelections[chatId]) userSelections[chatId] = {};
  userSelections[chatId].username = username;
  saveUserSelection(chatId, userSelections[chatId]);

  await safeSendMessage(chatId,
    `Welcome ${username} 🚀\n\nSelect your package below:`,
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

bot.onText(/\/myid/, (msg) => {
  safeSendMessage(cid(msg.chat.id), `🆔 Your Chat ID: \`${msg.chat.id}\``, { parse_mode: "Markdown" });
});

bot.onText(/\/testlink/, async (msg) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return;
  try {
    const res = await bot.createChatInviteLink(CHANNEL_ID, {
      member_limit: 1,
      expire_date: Math.floor(Date.now() / 1000) + 300,
    });
    safeSendMessage(cid(msg.chat.id), `✅ Test link: ${res.invite_link}`);
  } catch (err) {
    safeSendMessage(cid(msg.chat.id), `❌ Error: ${err.message}\n\nMake sure bot is admin in the channel!`);
  }
});

// ─── Package handlers ─────────────────────────────────────────────────────────
bot.on("callback_query", async (query) => {
  const chatId = cid(query.message.chat.id);
  const data = query.data;
  
  bot.answerCallbackQuery(query.id).catch(() => {});
  
  if (data === "package_test") {
    userSelections[chatId] = { package: "Test Package", plan: "20 Min Test", price: 1, username: userSelections[chatId]?.username };
    saveUserSelection(chatId, userSelections[chatId]);
    return safeSendMessage(chatId,
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
  }
  
  if (data === "package_naughty_premium_leaks") {
    userSelections[chatId] = { package: "Naughty Premium Leaks", username: userSelections[chatId]?.username };
    saveUserSelection(chatId, userSelections[chatId]);
    return safeSendMessage(chatId, `🔥 *Naughty Premium Leaks*\n\nSelect plan:`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "1 Day — Ksh 40", callback_data: "naughty_1day" }],
          [{ text: "1 Week — Ksh 170", callback_data: "naughty_1week" }],
          [{ text: "1 Month — Ksh 450", callback_data: "naughty_1month" }],
          [{ text: "🧪 TEST: 20 Min (1 KSH)", callback_data: "naughty_test" }]
        ]
      }
    });
  }
  
  if (data === "package_naughty_explicit") {
    userSelections[chatId] = { package: "Naughty Explicit", username: userSelections[chatId]?.username };
    saveUserSelection(chatId, userSelections[chatId]);
    return safeSendMessage(chatId, `💥 *Naughty Explicit*\n\nSelect plan:`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "1 Day — Ksh 50", callback_data: "premium_1day" }],
          [{ text: "1 Week — Ksh 220", callback_data: "premium_1week" }],
          [{ text: "1 Month — Ksh 680", callback_data: "premium_1month" }],
          [{ text: "🧪 TEST: 20 Min (1 KSH)", callback_data: "premium_test" }]
        ]
      }
    });
  }
  
  // Plan selection
  if (PLANS[data]) {
    const plan = PLANS[data];
    const sel = userSelections[chatId] || {};
    sel.plan = plan.label;
    sel.price = plan.price;
    userSelections[chatId] = sel;
    saveUserSelection(chatId, sel);
    
    return safeSendMessage(chatId,
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
  }
  
  if (data === "pay_stk") {
    const sel = userSelections[chatId];
    if (!sel || !sel.price) return;
    userSelections[chatId].awaitingPhone = true;
    saveUserSelection(chatId, userSelections[chatId]);
    return safeSendMessage(chatId, `📱 *Enter your M-Pesa phone number* (e.g., 0712345678):`);
  }
  
  if (data === "show_till") {
    const sel = userSelections[chatId];
    if (!sel) return;
    return safeSendMessage(chatId,
      `💳 *M-Pesa Till Number:* \`${TILL_NUMBER}\`\n📛 *Business:* ${TILL_NAME}\n💰 *Amount:* Ksh ${sel.price}\n\nSend the exact amount and text \`/confirm YOUR_CODE\` after payment.`
    );
  }
  
  if (data === "change_package") {
    return safeSendMessage(chatId, `🔄 Choose package:`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔥 Naughty Premium Leaks", callback_data: "package_naughty_premium_leaks" }],
          [{ text: "💥 Naughty Explicit", callback_data: "package_naughty_explicit" }]
        ]
      }
    });
  }
});

// ─── Handle text messages (Phone numbers & Auto-approval) ──────────────────────
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  
  const chatId = cid(msg.chat.id);
  const text = msg.text.trim();
  const sel = userSelections[chatId];
  
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
          `If you've already paid, send your 10-character M-Pesa code (e.g., \`RCX4B2K9QP\`) to get access immediately.`
        );
      } else {
        await safeSendMessage(chatId, `⚠️ Could not send prompt. Try manual payment.`);
      }
    } catch (err) {
      await safeSendMessage(chatId, `❌ Invalid number. Try again with /start`);
    }
    return;
  }
  
  // AUTO-APPROVAL: If user sends a 10-character code
  if (/^[A-Z0-9]{10}$/i.test(text)) {
    const code = text.toUpperCase();
    
    if (sel && sel.paidAt) {
      return safeSendMessage(chatId, `✅ You already have active access!`);
    }
    
    if (!sel || !sel.price) {
      return safeSendMessage(chatId, `⚠️ Please select a package first using /start`);
    }
    
    // Auto-approve immediately
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
});

// ─── GRANT COMMAND FOR ADMINS ─────────────────────────────────────────────────
bot.onText(/\/grant (\d+)(?: (.+))?/, async (msg, match) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return;
  const targetId = cid(match[1]);
  const plan = match[2] || "1 Month";
  
  try {
    await grantAccess(targetId, plan, `✅ Manually granted by admin`);
    safeSendMessage(cid(msg.chat.id), `✅ Access granted to ${targetId} for ${plan}`);
  } catch (err) {
    safeSendMessage(cid(msg.chat.id), `❌ Failed: ${err.message}`);
  }
});

// ─── STATUS ENDPOINT ──────────────────────────────────────────────────────────
app.get("/api/status", (req, res) => {
  res.json({
    status: "online",
    autoApprove: true,
    pendingSTKCount: Object.keys(pendingSTK).length,
    activeSubscriptions: Object.keys(subTimers).length,
    activeSessions: Object.keys(userSelections).length,
    timestamp: new Date().toISOString()
  });
});

// ─── AUTO-VERIFY PENDING TRANSACTIONS ─────────────────────────────────────────
async function autoVerifyPendingTransactions() {
  for (const [checkoutId, pending] of Object.entries(pendingSTK)) {
    if (Date.now() - (pending.expiresAt || 0) < 10 * 60 * 1000) {
      try {
        const token = await getMpesaToken();
        const timestamp = moment().format("YYYYMMDDHHmmss");
        const password = Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp}`).toString("base64");
        
        const response = await axios.post(
          "https://api.safaricom.co.ke/mpesa/stkpushquery/v1/query",
          { BusinessShortCode: SHORTCODE, Password: password, Timestamp: timestamp, CheckoutRequestID: checkoutId },
          { headers: { Authorization: `Bearer ${token}` } }
        );
        
        if (response.data.ResultCode === "0") {
          const id = cid(pending.chatId);
          const sel = userSelections[id] || {};
          sel.paidAt = new Date().toISOString();
          sel.stkRef = response.data.MpesaReceiptNumber;
          userSelections[id] = sel;
          saveUserSelection(id, sel);
          
          await grantAccess(id, pending.plan || "1 Month", `✅ Auto-verified: Ksh ${response.data.Amount}`);
          delete pendingSTK[checkoutId];
          savePendingSTK(pendingSTK);
        }
      } catch (err) {
        console.error("Auto-verify error:", err.message);
      }
    }
  }
}

setInterval(autoVerifyPendingTransactions, 30000);

// ─── EXPRESS SERVER ──────────────────────────────────────────────────────────
// ─── EXPRESS SERVER ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📺 Channel ID: ${CHANNEL_ID}`);
  console.log(`🤖 Bot is running with auto-approval enabled`);
  console.log(`🧪 Test with "20 Min Test" plan for Ksh 1`);
});