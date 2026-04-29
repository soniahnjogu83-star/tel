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
app.get('/ping', (req, res) => {
  res.send('OK');
});

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

// ─── PLAN CONFIG ─────────────────────────────────────────────────────────────
const PLAN_DAYS = {
  "1 Day":    1,
  "1 Week":   7,
  "2 Weeks":  14,
  "1 Month":  30,
  "6 Months": 180,
  "1 Year":   365,
  "20 Min Test": 0.0139,
  "1 Hour":   0.04167,
  "6 Hours":  0.25,
};

const PLANS = {
  // NAUGHTY PREMIUM LEAKS (Premium Package)
  premium_1hour:    { label: "1 Hour",    price: 20 },
  premium_6hours:   { label: "6 Hours",   price: 30 },
  premium_1day:     { label: "1 Day",     price: 70 },
  premium_1week:    { label: "1 Week",    price: 220 },
  premium_2weeks:   { label: "2 Weeks",   price: 400 },
  premium_1month:   { label: "1 Month",   price: 680 },
  premium_6months:  { label: "6 Months",  price: 3500 },
  premium_1year:    { label: "1 Year",    price: 7000 },
  premium_test:     { label: "20 Min Test", price: 1 },
  
  // NAUGHTY EXPLICIT (Explicit Package)
  explicit_1hour:   { label: "1 Hour",    price: 30 },
  explicit_6hours:  { label: "6 Hours",   price: 50 },
  explicit_1day:    { label: "1 Day",     price: 100 },
  explicit_1week:   { label: "1 Week",    price: 170 },
  explicit_2weeks:  { label: "2 Weeks",   price: 270 },
  explicit_1month:  { label: "1 Month",   price: 450 },
  explicit_6months: { label: "6 Months",  price: 2500 },
  explicit_1year:   { label: "1 Year",    price: 6200 },
  explicit_test:    { label: "20 Min Test", price: 1 },
};

// ─── STATE & UTILS ──────────────────────────────────────────────────────────
const warnMs = 24 * 60 * 60 * 1000;

const userSelections = {};
let pendingSTK = {};
let pendingManualApprovals = {};
const subTimers = {};
const accessAttempts = {};
const userInviteLinks = {};

let autoExpireSubscriptions = true;

// ─── CHANNEL_ID ──────────────────────────────────────────────────────────────
const CHANNEL_ID = -1001567081082;

// ─── BOT: LONG POLLING ────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

(async () => {
  try {
    await bot.deleteWebHook({ drop_pending_updates: true });
    console.log("✅ Webhook cleared");
  } catch (err) {
    console.warn("⚠️ Could not delete webhook:", err.message);
  }

  await new Promise((r) => setTimeout(r, 1500));
  bot.startPolling({ interval: 1000, params: { timeout: 10 } });
  console.log("✅ Bot started in long-polling mode.");
})();

bot.on("polling_error", (err) => {
  if (err.code === "ETELEGRAM" && err.message.includes("409")) {
    console.warn("⚠️ Polling 409 — waiting for Telegram to settle...");
  } else {
    console.error("❌ Polling error:", err.message);
  }
});

// ─── LOAD PERSISTED DATA ────────────────────────────────────────────────────
function loadPendingSTK() {
  try {
    const file = path.join(__dirname, "pending_stk.json");
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) { console.error("⚠️ Could not load pending_stk.json:", e.message); }
  return {};
}

function savePendingSTK(data) {
  try {
    fs.writeFileSync(path.join(__dirname, "pending_stk.json"), JSON.stringify(data, null, 2));
  } catch (e) { console.error("⚠️ Could not save pending_stk.json:", e.message); }
}

function loadUserSelections() {
  try {
    const file = path.join(__dirname, "user_selections.json");
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) { console.error("⚠️ Could not load user_selections.json:", e.message); }
  return {};
}

function saveUserSelection(chatId, data) {
  try {
    const all = loadUserSelections();
    all[cid(chatId)] = data;
    fs.writeFileSync(path.join(__dirname, "user_selections.json"), JSON.stringify(all, null, 2));
  } catch (e) { console.error("⚠️ Could not save user_selections.json:", e.message); }
}

function deleteUserSelection(chatId) {
  try {
    const all = loadUserSelections();
    delete all[cid(chatId)];
    fs.writeFileSync(path.join(__dirname, "user_selections.json"), JSON.stringify(all, null, 2));
  } catch (e) { console.error("⚠️ Could not delete user_selections.json entry:", e.message); }
}

function loadSubs() {
  try {
    const file = path.join(__dirname, "subscriptions.json");
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) { console.error("⚠️ Could not load subscriptions.json:", e.message); }
  return {};
}

function saveSubs(data) {
  try {
    fs.writeFileSync(path.join(__dirname, "subscriptions.json"), JSON.stringify(data, null, 2));
  } catch (e) { console.error("⚠️ Could not save subscriptions.json:", e.message); }
}

pendingSTK = loadPendingSTK();
Object.assign(userSelections, loadUserSelections());

function saveSubEntry(chatId, planLabel, expiresAt, username, inviteLink = null, inviteLinkId = null) {
  const data = loadSubs();
  data[cid(chatId)] = { planLabel, expiresAt, username, inviteLink, inviteLinkId };
  saveSubs(data);
}

function removeSubEntry(chatId) {
  const data = loadSubs();
  delete data[cid(chatId)];
  saveSubs(data);
}

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

// ─── CRITICAL: AUTO REMOVE USER FROM CHANNEL ON EXPIRY ────────────────────────
async function removeUserFromChannel(chatId, reason = "") {
  console.log(`🔴 ATTEMPTING TO REMOVE USER ${chatId} from channel. Reason: ${reason}`);
  
  try {
    // Method 1: Ban the user (this removes them from the channel/group)
    const banResult = await bot.banChatMember(CHANNEL_ID, Number(chatId));
    console.log(`   Ban result: ${banResult ? "Success" : "Failed"}`);
    
    // Wait a moment for the ban to take effect
    await new Promise(r => setTimeout(r, 1000));
    
    // Method 2: Unban to allow them to rejoin later with a new purchase
    const unbanResult = await bot.unbanChatMember(CHANNEL_ID, Number(chatId));
    console.log(`   Unban result: ${unbanResult ? "Success" : "Failed"}`);
    
    // Method 3: Also try to restrict permissions as backup
    try {
      await bot.restrictChatMember(CHANNEL_ID, Number(chatId), {
        can_send_messages: false,
        can_send_media_messages: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false
      });
      console.log(`   Restricted permissions for ${chatId}`);
    } catch (restrictErr) {
      console.log(`   Restriction not needed (already banned): ${restrictErr.message}`);
    }
    
    // Method 4: Revoke any invite links for this user
    if (userInviteLinks[chatId]) {
      try {
        await bot.revokeChatInviteLink(CHANNEL_ID, userInviteLinks[chatId]);
        console.log(`   Revoked invite link for ${chatId}`);
      } catch (linkErr) {
        console.log(`   Could not revoke link: ${linkErr.message}`);
      }
      delete userInviteLinks[chatId];
    }
    
    console.log(`✅ SUCCESS: User ${chatId} has been removed from channel`);
    return true;
    
  } catch (err) {
    console.error(`❌ FAILED to remove user ${chatId}:`, err.message);
    
    // If ban fails, try kicking
    try {
      await bot.kickChatMember(CHANNEL_ID, Number(chatId));
      console.log(`   Kick successful for ${chatId}`);
      await new Promise(r => setTimeout(r, 1000));
      await bot.unbanChatMember(CHANNEL_ID, Number(chatId));
      console.log(`✅ User ${chatId} kicked successfully`);
      return true;
    } catch (kickErr) {
      console.error(`   Kick also failed: ${kickErr.message}`);
      return false;
    }
  }
}

async function revokeUserInviteLink(chatId, inviteLinkId) {
  if (!inviteLinkId) return;
  try {
    await bot.revokeChatInviteLink(CHANNEL_ID, inviteLinkId);
    console.log(`✅ Revoked invite link for user ${chatId}`);
  } catch (err) {
    console.error(`❌ Failed to revoke invite link:`, err.message);
  }
}

// ─── GRANT ACCESS WITH AUTO-REMOVAL ON EXPIRY ─────────────────────────────────
async function grantAccess(rawChatId, planLabel, paymentSummary, isManualApproval = false) {
  const chatId = cid(rawChatId);
  console.log(`🔍 grantAccess called: chatId=${chatId}, planLabel="${planLabel}"`);

  if (accessAttempts[chatId]) {
    console.log(`⚠️ Grant access already in progress for ${chatId}`);
    return;
  }
  accessAttempts[chatId] = true;
  setTimeout(() => { delete accessAttempts[chatId]; }, 10000);

  const resolvedLabel = PLAN_DAYS[planLabel] !== undefined ? planLabel : "1 Month";
  const days = PLAN_DAYS[resolvedLabel];
  
  if (!days && days !== 0) {
    console.error(`❌ Could not resolve days for plan "${planLabel}"`);
    delete accessAttempts[chatId];
    return;
  }

  const username = userSelections[chatId]?.username || `User ${chatId}`;

  try {
    // Clear any existing subscription timers first
    clearSubTimers(chatId);
    
    // Remove user from channel if they're already there (clean state)
    try {
      const member = await bot.getChatMember(CHANNEL_ID, Number(chatId));
      if (member.status !== "left" && member.status !== "kicked") {
        console.log(`🔄 Removing existing user ${chatId} before granting new access`);
        await removeUserFromChannel(chatId, "pre-clean before new subscription");
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (err) {
      console.log(`ℹ️ Could not check member status: ${err.message}`);
    }

    const nowMs = Date.now();
    let durationMs, expiresAtMs;
    
    if (resolvedLabel === "20 Min Test") {
      durationMs = 20 * 60 * 1000;
    } else if (resolvedLabel === "1 Hour") {
      durationMs = 60 * 60 * 1000;
    } else if (resolvedLabel === "6 Hours") {
      durationMs = 6 * 60 * 60 * 1000;
    } else {
      durationMs = days * 24 * 60 * 60 * 1000;
    }
    expiresAtMs = nowMs + durationMs;

    console.log(`⏱ Plan: ${resolvedLabel} | Duration: ${durationMs}ms`);
    console.log(`📅 Expires at: ${new Date(expiresAtMs).toISOString()}`);

    // Create invite link that expires with subscription
    const inviteRes = await bot.createChatInviteLink(CHANNEL_ID, {
      member_limit: 1,
      expire_date: Math.floor(expiresAtMs / 1000),
      name: `Sub-${chatId}-${Date.now()}`
    });

    const inviteLink = inviteRes.invite_link;
    const inviteLinkId = inviteRes.invite_link_id;
    userInviteLinks[chatId] = inviteLinkId;

    let timeText = resolvedLabel;
    if (resolvedLabel === "20 Min Test") timeText = "20 minutes";
    else if (resolvedLabel === "1 Hour") timeText = "1 hour";
    else if (resolvedLabel === "6 Hours") timeText = "6 hours";
    else if (resolvedLabel === "1 Day") timeText = "1 day";
    else timeText = `${days} day(s)`;
    
    await safeSendMessage(chatId,
      `🎉 *Access Granted!*\n\n${paymentSummary}\n\n` +
      `👇 *Tap to join:*\n${inviteLink}\n\n` +
      `⚠️ *You will be automatically removed from the channel after ${timeText}*`,
      { disable_web_page_preview: false }
    );

    // ─── CRITICAL: SET UP AUTO-REMOVAL TIMER ─────────────────────────────────
    console.log(`⏰ Setting expiry timer for ${chatId} in ${durationMs}ms (${new Date(expiresAtMs).toLocaleString()})`);
    
    const kickTimer = setTimeout(async () => {
      console.log(`🔴🚨 EXPIRY TRIGGERED for ${chatId} at ${new Date().toISOString()}`);
      
      // Multiple removal attempts for reliability
      let removed = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        console.log(`   Removal attempt ${attempt} for ${chatId}`);
        const result = await removeUserFromChannel(chatId, `EXPIRED: ${resolvedLabel} plan (attempt ${attempt})`);
        if (result) {
          removed = true;
          break;
        }
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
      
      if (removed) {
        console.log(`✅ User ${chatId} successfully removed after ${resolvedLabel} expiry`);
      } else {
        console.log(`⚠️ Could not remove ${chatId} after 3 attempts`);
      }
      
      // Revoke invite link
      await revokeUserInviteLink(chatId, inviteLinkId);
      
      // Send expiry notification
      await safeSendMessage(chatId,
        `⏰ *Subscription Expired*\n\n` +
        `Your *${resolvedLabel}* access has ended.\n\n` +
        `Tap below to renew 👇`,
        {
          reply_markup: { inline_keyboard: [[{ text: "🔄 Renew Subscription", callback_data: "change_package" }]] }
        }
      );
      
      delete subTimers[chatId];
      removeSubEntry(chatId);
      delete userInviteLinks[chatId];
    }, durationMs);
    
    // Set up 24-hour warning for long plans
    let warnTimer = null;
    const shouldWarn = !["20 Min Test", "1 Hour", "6 Hours", "1 Day"].includes(resolvedLabel) && durationMs > warnMs;
    
    if (shouldWarn) {
      warnTimer = setTimeout(() => {
        safeSendMessage(chatId,
          `⏰ *Reminder!*\n\nYour *${resolvedLabel}* subscription expires in *24 hours*.\n\nRenew to continue enjoying the content!`,
          { reply_markup: { inline_keyboard: [[{ text: "🔄 Renew Now", callback_data: "change_package" }]] } }
        );
      }, durationMs - warnMs);
    }
    
    subTimers[chatId] = { expiresAt: expiresAtMs, kickTimer, warnTimer, inviteLinkId, plan: resolvedLabel };
    saveSubEntry(chatId, resolvedLabel, expiresAtMs, username, inviteLink, inviteLinkId);
    
    console.log(`✅ Access setup complete for ${chatId}`);
    console.log(`   Timer will fire at: ${new Date(expiresAtMs).toLocaleString()}`);
    delete accessAttempts[chatId];

    if (isManualApproval) delete pendingManualApprovals[chatId];

  } catch (err) {
    console.error("❌ grantAccess error:", err.message, err.stack);
    
    await safeSendMessage(chatId,
      `✅ *Payment Received!*\n\n` +
      `Having technical issues. Admin notified and will send your access link within 5 minutes.`
    );
    
    notifyAdmins(
      `⚠️ *Auto-invite FAILED for* \`${chatId}\`\nPlan: ${resolvedLabel}\nError: ${err.message}\n` +
      `Use: /grant ${chatId} "${resolvedLabel}"`
    );
    delete accessAttempts[chatId];
  }
}

function clearSubTimers(chatId) {
  const id = cid(chatId);
  if (subTimers[id]) {
    console.log(`🧹 Clearing timers for ${id}`);
    if (subTimers[id].kickTimer) clearTimeout(subTimers[id].kickTimer);
    if (subTimers[id].warnTimer) clearTimeout(subTimers[id].warnTimer);
    delete subTimers[id];
    removeSubEntry(id);
  }
}

function notifyAdmins(message, opts = {}) {
  ADMIN_IDS.forEach((id) => {
    safeSendMessage(id, message, { parse_mode: "Markdown", ...opts });
  });
}

// ─── RESTORE ACTIVE SUBSCRIPTIONS ON STARTUP ─────────────────────────────────
async function restoreActiveSubscriptions() {
  const subs = loadSubs();
  const now = Date.now();
  console.log(`🔄 Restoring ${Object.keys(subs).length} subscriptions...`);
  
  for (const [chatId, sub] of Object.entries(subs)) {
    if (sub.expiresAt > now) {
      const remainingMs = sub.expiresAt - now;
      console.log(`🔄 Restoring ${chatId}: ${sub.planLabel}, ${Math.floor(remainingMs/1000/60)} min remaining`);
      
      const kickTimer = setTimeout(async () => {
        console.log(`🔴 EXPIRED (restored): ${chatId}`);
        await removeUserFromChannel(chatId, `EXPIRED: ${sub.planLabel}`);
        if (sub.inviteLinkId) await revokeUserInviteLink(chatId, sub.inviteLinkId);
        await safeSendMessage(chatId, `⏰ Your *${sub.planLabel}* subscription has expired. Tap /start to renew.`);
        delete subTimers[chatId];
        removeSubEntry(chatId);
      }, remainingMs);
      
      subTimers[chatId] = { expiresAt: sub.expiresAt, kickTimer, inviteLinkId: sub.inviteLinkId, plan: sub.planLabel };
      if (sub.inviteLinkId) userInviteLinks[chatId] = sub.inviteLinkId;
    } else {
      console.log(`🗑️ Removing expired subscription for ${chatId}`);
      removeSubEntry(chatId);
      await removeUserFromChannel(chatId, "expired on startup");
    }
  }
  console.log(`✅ Restored ${Object.keys(subTimers).length} active subscriptions`);
}

// ─── M-PESA FUNCTIONS ────────────────────────────────────────────────────────
async function getMpesaToken() {
  try {
    const auth = Buffer.from(`${process.env.CONSUMER_KEY}:${process.env.CONSUMER_SECRET}`).toString("base64");
    const res = await axios.get(
      "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
      { headers: { Authorization: `Basic ${auth}` } }
    );
    return res.data.access_token;
  } catch (err) {
    notifyAdmins(`🚨 Daraja Token Error: ${err.message}`);
    throw err;
  }
}

async function stkPush(phone, amount, chatId) {
  const id = cid(chatId);
  try {
    const token = await getMpesaToken();
    const timestamp = moment().format("YYYYMMDDHHmmss");
    const password = Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp}`).toString("base64");
    let normalized = phone.trim().replace(/^\+/, "").replace(/^0/, "254");

    const payload = {
      BusinessShortCode: SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerBuyGoodsOnline",
      Amount: Math.ceil(Number(amount)),
      PartyA: normalized,
      PartyB: TILL_NUMBER,
      PhoneNumber: normalized,
      CallBackURL: CALLBACK_URL,
      AccountReference: "ALJAKI",
      TransactionDesc: "Content Access"
    };

    const res = await axios.post(
      "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      payload,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (res.data.ResponseCode === "0") {
      const sel = userSelections[id] || {};
      pendingSTK[res.data.CheckoutRequestID] = {
        chatId: id, plan: sel.plan, pkg: sel.package, price: sel.price || amount,
        username: sel.username || id, expiresAt: Date.now() + 10 * 60 * 1000
      };
      savePendingSTK(pendingSTK);
    }
    return res.data;
  } catch (err) {
    notifyAdmins(`🚨 STK Push Failed for ${id}: ${err.message}`);
    throw err;
  }
}

app.post("/mpesa/callback", (req, res) => {
  res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  try {
    const body = req.body?.Body?.stkCallback;
    const checkId = body?.CheckoutRequestID;
    const pending = pendingSTK[checkId];
    if (!pending) return;
    
    delete pendingSTK[checkId];
    savePendingSTK(pendingSTK);
    
    if (body?.ResultCode === 0) {
      const meta = body.CallbackMetadata?.Item || [];
      const get = (name) => meta.find(i => i.Name === name)?.Value ?? "—";
      const amount = get("Amount");
      const mpesaCode = get("MpesaReceiptNumber");
      
      const sel = userSelections[pending.chatId] || {};
      sel.paidAt = new Date().toISOString();
      sel.stkRef = mpesaCode;
      userSelections[pending.chatId] = sel;
      saveUserSelection(pending.chatId, sel);
      
      grantAccess(pending.chatId, sel.plan || "1 Month", `✅ Ksh ${amount} received\nRef: ${mpesaCode}`);
      notifyAdmins(`💰 Payment: ${pending.chatId} | Ksh ${amount} | ${mpesaCode}`);
    }
  } catch (err) {
    console.error("Callback error:", err.message);
  }
});

// ─── BOT COMMANDS ────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId = cid(msg.chat.id);
  const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  
  userSelections[chatId] = { username, freshStart: true };
  saveUserSelection(chatId, userSelections[chatId]);

  await safeSendMessage(chatId,
    `🎉 *Welcome ${username}!* 🎉\n\nSelect your package:`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔥 Premium", callback_data: "package_premium" }],
          [{ text: "💥 Explicit", callback_data: "package_explicit" }],
          [{ text: "🧪 TEST: 20 Min (1 KSH)", callback_data: "package_test" }]
        ]
      }
    }
  );
});

bot.onText(/\/myid/, (msg) => {
  safeSendMessage(cid(msg.chat.id), `🆔 Your ID: \`${msg.chat.id}\``);
});

bot.onText(/\/grant (\d+)(?: (.+))?/, async (msg, match) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return;
  await grantAccess(match[1], match[2] || "1 Month", "✅ Admin granted");
  safeSendMessage(cid(msg.chat.id), `✅ Granted to ${match[1]}`);
});

bot.onText(/\/remove (\d+)/, async (msg, match) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return;
  await removeUserFromChannel(match[1], "admin command");
  clearSubTimers(match[1]);
  safeSendMessage(cid(msg.chat.id), `✅ Removed ${match[1]}`);
});

bot.onText(/\/listsubs/, async (msg) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return;
  const subs = loadSubs();
  let msgText = "*Active Subscriptions:*\n";
  for (const [id, sub] of Object.entries(subs)) {
    if (sub.expiresAt > Date.now()) {
      msgText += `• \`${id}\` - ${sub.planLabel} - expires ${new Date(sub.expiresAt).toLocaleString()}\n`;
    }
  }
  safeSendMessage(cid(msg.chat.id), msgText || "No active subscriptions");
});

// ─── CALLBACK QUERY HANDLER ──────────────────────────────────────────────────
bot.on("callback_query", async (query) => {
  const chatId = cid(query.message.chat.id);
  const data = query.data;
  bot.answerCallbackQuery(query.id).catch(() => {});
  
  if (data === "package_test") {
    userSelections[chatId] = { ...userSelections[chatId], package: "Test", plan: "20 Min Test", price: 1 };
    saveUserSelection(chatId, userSelections[chatId]);
    return safeSendMessage(chatId, `🧪 Test - Ksh 1\n\nPay via STK Push:`, {
      reply_markup: { inline_keyboard: [[{ text: "📲 Pay via STK Push", callback_data: "pay_stk" }]] }
    });
  }
  
  if (data === "package_premium") {
    userSelections[chatId] = { ...userSelections[chatId], package: "Premium" };
    saveUserSelection(chatId, userSelections[chatId]);
    return safeSendMessage(chatId, `🔥 *Premium Package*\nSelect plan:`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "1 Hour - Ksh 20", callback_data: "premium_1hour" }],
          [{ text: "6 Hours - Ksh 30", callback_data: "premium_6hours" }],
          [{ text: "1 Day - Ksh 70", callback_data: "premium_1day" }],
          [{ text: "1 Week - Ksh 220", callback_data: "premium_1week" }],
          [{ text: "1 Month - Ksh 680", callback_data: "premium_1month" }],
          [{ text: "6 Months - Ksh 3500", callback_data: "premium_6months" }],
          [{ text: "1 Year - Ksh 7000", callback_data: "premium_1year" }]
        ]
      }
    });
  }
  
  if (data === "package_explicit") {
    userSelections[chatId] = { ...userSelections[chatId], package: "Explicit" };
    saveUserSelection(chatId, userSelections[chatId]);
    return safeSendMessage(chatId, `💥 *Explicit Package*\nSelect plan:`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "1 Hour - Ksh 30", callback_data: "explicit_1hour" }],
          [{ text: "6 Hours - Ksh 50", callback_data: "explicit_6hours" }],
          [{ text: "1 Day - Ksh 100", callback_data: "explicit_1day" }],
          [{ text: "1 Week - Ksh 170", callback_data: "explicit_1week" }],
          [{ text: "1 Month - Ksh 450", callback_data: "explicit_1month" }],
          [{ text: "6 Months - Ksh 2500", callback_data: "explicit_6months" }],
          [{ text: "1 Year - Ksh 6200", callback_data: "explicit_1year" }]
        ]
      }
    });
  }
  
  if (PLANS[data]) {
    const plan = PLANS[data];
    userSelections[chatId].plan = plan.label;
    userSelections[chatId].price = plan.price;
    saveUserSelection(chatId, userSelections[chatId]);
    return safeSendMessage(chatId, `✅ ${plan.label} - Ksh ${plan.price}\n\nPay via STK Push:`, {
      reply_markup: { inline_keyboard: [[{ text: "📲 Pay via STK Push", callback_data: "pay_stk" }]] }
    });
  }
  
  if (data === "pay_stk") {
    const sel = userSelections[chatId];
    if (!sel?.price) return safeSendMessage(chatId, `⚠️ Select a package first using /start`);
    userSelections[chatId].awaitingPhone = true;
    saveUserSelection(chatId, userSelections[chatId]);
    return safeSendMessage(chatId, `📱 *Enter M-Pesa phone number* (e.g., 0712345678):`);
  }
  
  if (data === "change_package") {
    const username = userSelections[chatId]?.username;
    userSelections[chatId] = { username };
    saveUserSelection(chatId, userSelections[chatId]);
    return safeSendMessage(chatId, `🔄 Choose package:`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔥 Premium", callback_data: "package_premium" }],
          [{ text: "💥 Explicit", callback_data: "package_explicit" }],
          [{ text: "🧪 TEST: 20 Min (1 KSH)", callback_data: "package_test" }]
        ]
      }
    });
  }
  
  if (data === "show_manual_code_entry") {
    userSelections[chatId].awaitingManualCode = true;
    saveUserSelection(chatId, userSelections[chatId]);
    return safeSendMessage(chatId,
      `📝 *Enter your 10-digit M-Pesa transaction code*\n\nExample: \`RCX4B2K9QP\`\n\nAdmin will approve within minutes.`
    );
  }
  
  if (data === "retry_stk") {
    userSelections[chatId].awaitingPhone = true;
    saveUserSelection(chatId, userSelections[chatId]);
    return safeSendMessage(chatId, `📱 *Enter phone number to retry:*`);
  }
});

// ─── MESSAGE HANDLER ─────────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  
  const chatId = cid(msg.chat.id);
  const text = msg.text.trim();
  const sel = userSelections[chatId];
  
  // Handle phone number for STK
  if (sel?.awaitingPhone) {
    sel.awaitingPhone = false;
    saveUserSelection(chatId, sel);
    
    try {
      const cleaned = validatePhone(text);
      await safeSendMessage(chatId, `⏳ Sending STK push...`);
      const result = await stkPush(text, sel.price, chatId);
      
      if (result.ResponseCode === "0") {
        await safeSendMessage(chatId,
          `✅ *STK Push Sent!*\n\nEnter PIN when prompted.\n\nIf you don't receive it, tap below:`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "📝 Enter Code Manually", callback_data: "show_manual_code_entry" }],
                [{ text: "🔄 Retry STK", callback_data: "retry_stk" }]
              ]
            }
          }
        );
      }
    } catch (err) {
      await safeSendMessage(chatId, `❌ Invalid number. Try /start again.`);
    }
    return;
  }
  
  // Handle manual transaction code (admin approval)
  if (sel?.awaitingManualCode && /^[A-Z0-9]{10}$/i.test(text)) {
    sel.awaitingManualCode = false;
    const code = text.toUpperCase();
    saveUserSelection(chatId, sel);
    
    pendingManualApprovals[chatId] = {
      plan: sel.plan, price: sel.price, code, package: sel.package, username: sel.username, timestamp: Date.now()
    };
    
    await safeSendMessage(chatId,
      `⏳ *Code Received!*\n\nCode: \`${code}\`\nAmount: Ksh ${sel.price}\n\nWaiting for admin approval (2-5 min).`
    );
    
    notifyAdmins(
      `🕐 *MANUAL PAYMENT*\nUser: \`${chatId}\`\nPlan: ${sel.plan}\nAmount: Ksh ${sel.price}\nCode: \`${code}\`\n\n/approve ${chatId} or /deny ${chatId}`
    );
    return;
  }
  
  // Check active subscription
  const subData = loadSubs()[chatId];
  if (subData && subData.expiresAt > Date.now()) {
    const remaining = Math.ceil((subData.expiresAt - Date.now()) / (1000 * 60 * 60));
    await safeSendMessage(chatId,
      `✨ *Active Subscription!*\n\n${subData.planLabel} - ${remaining} hours remaining.\n\nTap to extend:`,
      { reply_markup: { inline_keyboard: [[{ text: "🔄 Extend", callback_data: "change_package" }]] } }
    );
    return;
  }
  
  await safeSendMessage(chatId, `🎬 Tap /start to subscribe!`);
});

// ─── ADMIN APPROVAL ──────────────────────────────────────────────────────────
bot.onText(/\/approve (\d+)/, async (msg, match) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return;
  const targetId = match[1];
  const pending = pendingManualApprovals[targetId];
  if (!pending) return safeSendMessage(cid(msg.chat.id), `No pending for ${targetId}`);
  
  await grantAccess(targetId, pending.plan, `✅ Admin approved: Ksh ${pending.price}\nCode: ${pending.code}`, true);
  safeSendMessage(cid(msg.chat.id), `✅ Granted to ${targetId}`);
});

bot.onText(/\/deny (\d+)/, async (msg, match) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return;
  const targetId = match[1];
  const pending = pendingManualApprovals[targetId];
  if (pending) {
    delete pendingManualApprovals[targetId];
    await safeSendMessage(targetId, `❌ Payment code \`${pending.code}\` could not be verified. Please try again.`);
  }
  safeSendMessage(cid(msg.chat.id), `✅ Denied ${targetId}`);
});

// ─── STATUS & SERVER ─────────────────────────────────────────────────────────
app.get("/api/status", (req, res) => {
  res.json({
    status: "online",
    activeSubscriptions: Object.keys(subTimers).length,
    persistedSubscriptions: Object.keys(loadSubs()).length,
    timestamp: new Date().toISOString()
  });
});

// ─── MONITOR TIMERS (DEBUG) ──────────────────────────────────────────────────
setInterval(() => {
  for (const [chatId, timer] of Object.entries(subTimers)) {
    const remaining = timer.expiresAt - Date.now();
    if (remaining > 0 && remaining < 60000) {
      console.log(`⚠️ Timer for ${chatId} expires in ${Math.floor(remaining/1000)} seconds!`);
    }
  }
}, 10000);

// ─── STARTUP ─────────────────────────────────────────────────────────────────
restoreActiveSubscriptions();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);
  console.log(`📺 Channel ID: ${CHANNEL_ID}`);
  console.log(`🔐 AUTO-REMOVAL ON EXPIRY: ACTIVE`);
  console.log(`⏰ Expiry timers will automatically remove users from channel`);
});