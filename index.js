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
const TILL_NUMBER     = process.env.TILL_NUMBER || "4902476";
const TILL_NAME       = process.env.TILL_NAME || "ALJAKI Enterprise";
const SHORTCODE       = process.env.SHORTCODE;
const PASSKEY         = process.env.PASSKEY;
const CONSUMER_KEY    = process.env.CONSUMER_KEY;
const CONSUMER_SECRET = process.env.CONSUMER_SECRET;
const CALLBACK_URL    = process.env.CALLBACK_URL || "";
const BOT_TOKEN       = process.env.BOT_TOKEN;
const RENDER_URL      = process.env.RENDER_EXTERNAL_URL || null;

// Admin IDs — comma-separated in env
const ADMIN_IDS = (process.env.ADMIN_IDS || "8132815796")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// STK Push type
const MPESA_TYPE = (process.env.MPESA_TYPE || "till").toLowerCase();

// Daraja base URL
const MPESA_ENV       = (process.env.MPESA_ENV || "production").toLowerCase();
const DARAJA_BASE_URL = MPESA_ENV === "sandbox"
  ? "https://sandbox.safaricom.co.ke"
  : "https://api.safaricom.co.ke";

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
const warnMs = 24 * 60 * 60 * 1000;

const userSelections = {};
let pendingSTK = {};
const awaitingReceipt = {};
const reminderTimers = {};
const subTimers = {};
const verifyingCodes = new Set();

let autoExpireSubscriptions = process.env.AUTO_EXPIRE !== "false";
let autoSendInvite = process.env.AUTO_SEND_INVITE !== "false";

// ─── CHANNEL_ID ──────────────────────────────────────────────────────────────
const CHANNEL_ID = Number(process.env.CHANNEL_ID || "-1001567081082");

// ─── PERSISTENCE FILES ──────────────────────────────────────────────────────
const SUBS_FILE = path.join(__dirname, "subscriptions.json");
const PENDING_STK_FILE = path.join(__dirname, "pending_stk.json");
const USER_SEL_FILE = path.join(__dirname, "user_selections.json");

// ─── BOT SETUP ────────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: false });
let pollingActive = false;

async function startPollingWithRetry(attempt = 1) {
  try {
    await bot.deleteWebHook({ drop_pending_updates: true });
    console.log("✅ Webhook deleted.");
  } catch (err) {
    console.warn("⚠️ Could not delete webhook:", err.message);
  }

  const delay = Math.min(attempt * 3000, 15000);
  console.log(`⏳ Waiting ${delay / 1000}s before polling (attempt ${attempt})...`);
  await new Promise((r) => setTimeout(r, delay));

  try {
    await bot.startPolling({ interval: 1000, params: { timeout: 30 } });
    pollingActive = true;
    console.log("✅ Bot polling started.");
  } catch (err) {
    console.error("❌ Failed to start polling:", err.message);
  }
}

startPollingWithRetry();

bot.on("polling_error", async (err) => {
  if (err.code === "ETELEGRAM" && err.message.includes("409")) {
    if (pollingActive) {
      console.warn("⚠️ Polling 409 conflict — retrying in 10s...");
      pollingActive = false;
      try { await bot.stopPolling(); } catch (_) {}
      setTimeout(() => startPollingWithRetry(2), 10000);
    }
  } else {
    console.error("❌ Polling error:", err.message);
  }
});

// ─── LOAD PERSISTED DATA ─────────────────────────────────────────────────────
function loadSubs() {
  try {
    if (fs.existsSync(SUBS_FILE)) return JSON.parse(fs.readFileSync(SUBS_FILE, "utf8"));
  } catch (e) { console.error("⚠️ loadSubs:", e.message); }
  return {};
}

function saveSubs(data) {
  try { fs.writeFileSync(SUBS_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error("⚠️ saveSubs:", e.message); }
}

function loadPendingSTK() {
  try {
    if (fs.existsSync(PENDING_STK_FILE)) return JSON.parse(fs.readFileSync(PENDING_STK_FILE, "utf8"));
  } catch (e) { console.error("⚠️ loadPendingSTK:", e.message); }
  return {};
}

function savePendingSTK(data) {
  try { fs.writeFileSync(PENDING_STK_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error("⚠️ savePendingSTK:", e.message); }
}

function loadUserSelections() {
  try {
    if (fs.existsSync(USER_SEL_FILE)) return JSON.parse(fs.readFileSync(USER_SEL_FILE, "utf8"));
  } catch (e) { console.error("⚠️ loadUserSelections:", e.message); }
  return {};
}

function saveUserSelection(chatId, data) {
  try {
    const all = loadUserSelections();
    all[cid(chatId)] = data;
    fs.writeFileSync(USER_SEL_FILE, JSON.stringify(all, null, 2));
  } catch (e) { console.error("⚠️ saveUserSelection:", e.message); }
}

function deleteUserSelection(chatId) {
  try {
    const all = loadUserSelections();
    delete all[cid(chatId)];
    fs.writeFileSync(USER_SEL_FILE, JSON.stringify(all, null, 2));
  } catch (e) { console.error("⚠️ deleteUserSelection:", e.message); }
}

pendingSTK = loadPendingSTK();
Object.assign(userSelections, loadUserSelections());

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

async function sendTyping(chatId, durationMs = 1500) {
  try {
    await bot.sendChatAction(cid(chatId), "typing");
    await new Promise((r) => setTimeout(r, durationMs));
  } catch (_) {}
}

function validatePhone(phone) {
  let cleaned = String(phone).replace(/\D/g, "");
  if (cleaned.startsWith("254")) {
    // already international
  } else if (cleaned.startsWith("0")) {
    cleaned = "254" + cleaned.substring(1);
  } else if (cleaned.length === 9) {
    cleaned = "254" + cleaned;
  }
  if (!/^254[17]\d{8}$/.test(cleaned)) {
    throw new Error("Invalid Safaricom number. Use 07XXXXXXXX or 01XXXXXXXX");
  }
  return cleaned;
}

// ─── M-PESA: GET ACCESS TOKEN ─────────────────────────────────────────────────
async function getMpesaToken() {
  try {
    if (!CONSUMER_KEY || !CONSUMER_SECRET) {
      throw new Error("CONSUMER_KEY or CONSUMER_SECRET not set");
    }

    const credentials = `${CONSUMER_KEY}:${CONSUMER_SECRET}`;
    const auth = Buffer.from(credentials).toString("base64");

    const res = await axios.get(
      `${DARAJA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
      {
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );

    if (!res.data || !res.data.access_token) {
      throw new Error(`Unexpected token response`);
    }

    return res.data.access_token;
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    const detail = body?.errorMessage || body?.error_description || body?.error || err.message;
    console.error(`❌ getMpesaToken failed:`, detail);
    notifyAdmins(`🚨 *Daraja Token Error*\n${detail}`);
    throw new Error(`Daraja token error: ${detail}`);
  }
}

// ─── M-PESA: STK PUSH ────────────────────────────────────────────────────────
async function stkPush(phone, amount, chatId) {
  const id = cid(chatId);
  try {
    const token = await getMpesaToken();
    const timestamp = moment().format("YYYYMMDDHHmmss");

    const businessShortCode = MPESA_TYPE === "paybill" ? SHORTCODE : TILL_NUMBER;
    const partyB = TILL_NUMBER;
    const transactionType = MPESA_TYPE === "paybill"
      ? "CustomerPayBillOnline"
      : "CustomerBuyGoodsOnline";

    const rawPassword = `${businessShortCode}${PASSKEY}${timestamp}`;
    const password = Buffer.from(rawPassword).toString("base64");

    let normalized;
    try {
      normalized = validatePhone(phone);
    } catch (e) {
      throw new Error(e.message);
    }

    const amountInt = Math.ceil(Number(amount));

    const payload = {
      BusinessShortCode: businessShortCode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: transactionType,
      Amount: amountInt,
      PartyA: normalized,
      PartyB: partyB,
      PhoneNumber: normalized,
      CallBackURL: CALLBACK_URL,
      AccountReference: "ALJAKI",
      TransactionDesc: "Access",
    };

    const res = await axios.post(
      `${DARAJA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );

    if (res.data.ResponseCode === "0") {
      const sel = userSelections[id] || {};
      const entry = {
        chatId: id,
        plan: sel.plan || null,
        pkg: sel.package || sel.pkg || null,
        price: sel.price || amount,
        username: sel.username || id,
        expiresAt: Date.now() + 10 * 60 * 1000,
      };
      pendingSTK[res.data.CheckoutRequestID] = entry;
      savePendingSTK(pendingSTK);
    }

    return res.data;
  } catch (err) {
    if (err.response) {
      const detail = err.response.data?.errorMessage || err.message;
      throw new Error(`STK push failed: ${detail}`);
    }
    throw err;
  }
}

// ─── AUTO VERIFY RECEIPT ─────────────────────────────────────────────────────
async function autoVerifyReceipt(chatId, receiptCode, receiptInfo) {
  const id = cid(chatId);

  if (verifyingCodes.has(receiptCode)) {
    return;
  }
  verifyingCodes.add(receiptCode);

  try {
    await sendTyping(id, 1500);
    await safeSendMessage(id, `🔍 *Verifying your payment...*\n\nChecking with M-Pesa now. This takes a few seconds ⏳`);

    const initiatorName = process.env.MPESA_INITIATOR_NAME;
    const initiatorPass = process.env.MPESA_INITIATOR_PASS;

    if (!initiatorName || !initiatorPass) {
      await fallbackToAdminVerification(id, receiptCode, receiptInfo);
      return;
    }

    const token = await getMpesaToken();

    const securityCredential = Buffer.from(initiatorPass).toString("base64");
    const businessShortCode = MPESA_TYPE === "paybill" ? SHORTCODE : TILL_NUMBER;

    const res = await axios.post(
      `${DARAJA_BASE_URL}/mpesa/transactionstatus/v1/query`,
      {
        Initiator: initiatorName,
        SecurityCredential: securityCredential,
        CommandID: "TransactionStatusQuery",
        TransactionID: receiptCode,
        PartyA: businessShortCode,
        IdentifierType: "4",
        ResultURL: CALLBACK_URL.replace("/mpesa/callback", "/mpesa/transresult"),
        QueueTimeOutURL: CALLBACK_URL.replace("/mpesa/callback", "/mpesa/transtimeout"),
        Remarks: "VerifyPayment",
        Occasion: "Access",
      },
      {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        timeout: 15000,
      }
    );

    if (res.data.ResponseCode === "0") {
      await safeSendMessage(id,
        `⏳ *Almost there!*\n\nYour payment code has been sent to M-Pesa for verification.\nYou'll receive your access link automatically once confirmed — usually within 30 seconds. 🔐`
      );
    } else {
      await fallbackToAdminVerification(id, receiptCode, receiptInfo);
    }
  } catch (err) {
    console.error("❌ autoVerifyReceipt error:", err.message);
    await fallbackToAdminVerification(id, receiptCode, receiptInfo);
  } finally {
    verifyingCodes.delete(receiptCode);
  }
}

// ─── FALLBACK: ADMIN MANUAL APPROVAL ─────────────────────────────────────────
async function fallbackToAdminVerification(chatId, receiptCode, receiptInfo) {
  const id = cid(chatId);
  notifyAdmins(
    `🔔 *Manual Receipt Verification Needed*\n\n` +
    `👤 ChatID: \`${id}\`\n📦 ${receiptInfo.pkg || "N/A"} — ${receiptInfo.plan || "N/A"}\n` +
    `💰 Ksh ${receiptInfo.price || "N/A"}\n🧾 M-Pesa Code: \`${receiptCode}\`\n\n` +
    `Tap below to approve 👇`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: `✅ Approve & Grant Access to ${id}`, callback_data: `admin_grant_${id}_${receiptInfo.plan || "1 Month"}` },
        ]],
      },
    }
  );

  await safeSendMessage(id,
    `✅ *Got it!*\n\nYour M-Pesa code \`${receiptCode}\` has been sent to our team for manual verification. 🔍\n\nYou'll receive your access link within a few minutes. Thank you for your patience! 🙏`
  );
}

// ─── M-PESA CALLBACK ─────────────────────────────────────────────────────────
app.post("/mpesa/callback", (req, res) => {
  res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });

  try {
    const body = req.body?.Body?.stkCallback;
    const checkId = body?.CheckoutRequestID;
    const code = body?.ResultCode;

    const pending = pendingSTK[checkId];
    if (!pending) {
      console.warn(`⚠️ Unknown CheckoutRequestID: ${checkId}`);
      return;
    }

    delete pendingSTK[checkId];
    savePendingSTK(pendingSTK);

    const { chatId, plan, pkg, price, username } = pending;
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
      sel.phone = phone;
      if (!sel.plan && plan) sel.plan = plan;
      if (!sel.package && pkg) sel.package = pkg;
      userSelections[id] = sel;
      saveUserSelection(id, sel);
      clearReminders(id);

      const finalPlan = sel.plan || plan || "1 Month";

      grantAccess(id, finalPlan, `✅ Ksh *${amount}* received via M-Pesa\n🧾 Ref: \`${mpesaCode}\``);

      notifyAdmins(
        `💰 *PAYMENT CONFIRMED (STK)*\n\n` +
        `👤 \`${id}\`\n📦 ${sel.package || pkg || "N/A"} — ${finalPlan}\n` +
        `💰 Ksh ${amount} | 🧾 \`${mpesaCode}\`\n📱 ${phone}\n\n➡️ Access being sent.`
      );
    } else {
      awaitingReceipt[id] = {
        plan: plan || (userSelections[id] || {}).plan || "1 Month",
        pkg: pkg || (userSelections[id] || {}).package || "N/A",
        price: price || (userSelections[id] || {}).price || 0,
      };

      safeSendMessage(id,
        `⚠️ *Payment not completed.*\n\n` +
        `Your STK push was not completed.\n\n` +
        `📋 *If your M-Pesa was actually deducted*, please type your *M-Pesa confirmation code* (e.g. \`RCX4B2K9QP\`) and we'll verify it automatically. 🔍\n\n` +
        `Otherwise, choose an option below 👇`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "💳 Pay Manually via Till", callback_data: "show_till" }],
              [{ text: "🔄 Try STK Push Again", callback_data: "pay_stk" }],
              [{ text: "❓ I Need Help", callback_data: "need_help" }],
            ],
          },
        }
      ).catch(() => {});
    }
  } catch (err) {
    console.error("❌ STK Callback error:", err.message);
  }
});

// ─── TRANSACTION STATUS RESULT ────────────────────────────────────────────────
const pendingReceiptVerifications = {};

app.post("/mpesa/transresult", async (req, res) => {
  res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });

  try {
    const result = req.body?.Result;
    if (!result) return;
    const receiptCode = result.TransactionID;
    const resultCode = result.ResultCode;

    const pending = pendingReceiptVerifications[receiptCode];
    if (!pending) return;

    const { chatId, plan, pkg, price } = pending;

    if (resultCode === 0) {
      delete pendingReceiptVerifications[receiptCode];
      delete awaitingReceipt[chatId];

      const params = result.ResultParameters?.ResultParameter || [];
      const getParam = (name) => params.find((p) => p.Key === name)?.Value ?? "—";
      const amount = getParam("Amount");

      const sel = userSelections[chatId] || {};
      sel.paidAt = new Date().toISOString();
      sel.stkRef = receiptCode;
      if (!sel.plan && plan) sel.plan = plan;
      if (!sel.package && pkg) sel.package = pkg;
      userSelections[chatId] = sel;
      saveUserSelection(chatId, sel);
      clearReminders(chatId);

      const finalPlan = sel.plan || plan || "1 Month";

      await grantAccess(chatId, finalPlan,
        `✅ Ksh *${amount !== "—" ? amount : price}* received via M-Pesa\n🧾 Ref: \`${receiptCode}\``
      );

      notifyAdmins(
        `💰 *PAYMENT VERIFIED (Receipt)*\n\n` +
        `👤 \`${chatId}\`\n📦 ${sel.package || pkg || "N/A"} — ${finalPlan}\n` +
        `💰 Ksh ${amount} | 🧾 \`${receiptCode}\`\n\n➡️ Access sent.`
      );
    } else {
      delete pendingReceiptVerifications[receiptCode];
      await fallbackToAdminVerification(chatId, receiptCode, { plan, pkg, price });
    }
  } catch (err) {
    console.error("❌ transresult error:", err.message);
  }
});

app.post("/mpesa/transtimeout", async (req, res) => {
  res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  try {
    const result = req.body?.Result;
    const receiptCode = result?.TransactionID;
    const pending = receiptCode ? pendingReceiptVerifications[receiptCode] : null;
    if (pending) {
      delete pendingReceiptVerifications[receiptCode];
      const { chatId, plan, pkg, price } = pending;
      await fallbackToAdminVerification(chatId, receiptCode, { plan, pkg, price });
    }
  } catch (err) {
    console.error("❌ transtimeout error:", err.message);
  }
});

// ─── GRANT ACCESS ─────────────────────────────────────────────────────────────
async function grantAccess(rawChatId, planLabel, paymentSummary) {
  const chatId = cid(rawChatId);
  const resolvedLabel = PLAN_DAYS[planLabel] !== undefined ? planLabel : "1 Month";

  const days = PLAN_DAYS[resolvedLabel];
  if (!days || isNaN(days)) {
    console.error(`❌ grantAccess: bad planLabel "${planLabel}"`);
    notifyAdmins(`⚠️ *grantAccess FAILED*\nChatID: \`${chatId}\`\nBad planLabel: \`${planLabel}\``);
    return;
  }

  try {
    // Pre-kick for clean invite
    try {
      const member = await bot.getChatMember(CHANNEL_ID, Number(chatId));
      const isAdmin = ["administrator", "creator"].includes(member.status);
      if (!isAdmin && !["left", "kicked"].includes(member.status)) {
        await bot.banChatMember(CHANNEL_ID, Number(chatId));
        await bot.unbanChatMember(CHANNEL_ID, Number(chatId));
      }
    } catch (preKickErr) {
      console.log(`ℹ️ Pre-kick skipped: ${preKickErr.message}`);
    }

    const nowMs = Date.now();
    const durationMs = days * 24 * 60 * 60 * 1000;
    const expiresAtMs = nowMs + durationMs;
    const inviteExpiry = Math.floor(expiresAtMs / 1000);

    const inviteRes = await bot.createChatInviteLink(CHANNEL_ID, {
      member_limit: 1,
      expire_date: inviteExpiry,
      name: `Access-${chatId}-${Date.now()}`,
    });

    const inviteLink = inviteRes.invite_link;

    if (autoSendInvite) {
      await safeSendMessage(chatId,
        `🎉 *Access Granted!*\n\n` +
        `${paymentSummary}\n\n` +
        `👇 *Tap the link below to join:*\n${inviteLink}\n\n` +
        `⚠️ *Important:*\n• This link is *single-use* — for you only\n` +
        `• Your access expires in *${days} day(s)*\n\n` +
        `_Welcome to the family!_ 🔐`,
        { disable_web_page_preview: false }
      );
    } else {
      await safeSendMessage(chatId,
        `🎉 *Payment confirmed!*\n\n${paymentSummary}\n\n✅ An admin will send your invite link shortly.`
      );
      notifyAdmins(
        `🔗 *Manual invite for* \`${chatId}\`\n\nPlan: *${resolvedLabel}* (${days}d)\nLink: ${inviteLink}`
      );
    }

    if (autoExpireSubscriptions) {
      clearSubTimers(chatId);
      const timers = { expiresAt: expiresAtMs };

      if (days > 1) {
        timers.warnTimer = setTimeout(() => {
          safeSendMessage(chatId,
            `⏰ *Heads up!*\n\nYour *${resolvedLabel}* access expires in *24 hours*.\n\nRenew now to stay connected! 😊`,
            { reply_markup: { inline_keyboard: [[{ text: "🔄 Renew My Access", callback_data: "change_package" }]] } }
          ).catch(() => {});
        }, durationMs - warnMs);
      }

      timers.kickTimer = setTimeout(async () => {
        try {
          await removeUserFromChannel(chatId, "plan expiry");
        } catch (e) {
          console.error("Kick error:", e.message);
        }
        safeSendMessage(chatId,
          `👋 *Your subscription has ended.*\n\nYour *${resolvedLabel}* plan has expired.\n\nReady to come back anytime 😊`,
          { reply_markup: { inline_keyboard: [[{ text: "🔄 Re-subscribe Now", callback_data: "change_package" }]] } }
        ).catch(() => {});
        delete subTimers[chatId];
        removeSubEntry(chatId);
      }, durationMs);

      subTimers[chatId] = timers;
      saveSubEntry(chatId, resolvedLabel, expiresAtMs);
    }
  } catch (err) {
    console.error("❌ grantAccess error:", err.message);
    notifyAdmins(
      `⚠️ *Auto-invite FAILED for* \`${chatId}\`\n\nError: \`${err.message}\``,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: `✅ Grant Access to ${chatId}`, callback_data: `admin_grant_${chatId}_${resolvedLabel}` },
          ]],
        },
      }
    );
    await safeSendMessage(chatId,
      `😔 *We're so sorry for the delay!*\n\nYour payment was received ✅ but we hit a small technical issue.\n\n*You will not lose your access.* Our team has been notified and will send your link manually within a few minutes. 🙏\n\nThank you for your patience! 💛`
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

async function removeUserFromChannel(chatId, reason = "") {
  console.log(`🚪 Removing ${chatId} from channel. Reason: ${reason}`);
  try {
    await bot.banChatMember(CHANNEL_ID, Number(chatId));
    await bot.unbanChatMember(CHANNEL_ID, Number(chatId));
  } catch (err) {
    logError(`removeUserFromChannel [${chatId}]`, err);
  }
}

function clearReminders(chatId) {
  const id = cid(chatId);
  if (reminderTimers[id]) {
    reminderTimers[id].timers.forEach(clearTimeout);
    delete reminderTimers[id];
  }
}

// ─── PAYMENT LEDGER ───────────────────────────────────────────────────────────
const paymentLedger = [];

function recordPayment({ chatId, username, pkg, plan, amount, ref, phone, currency = "KES" }) {
  paymentLedger.push({
    chatId: cid(chatId),
    username: username || cid(chatId),
    package: pkg,
    plan,
    amount: Number(amount),
    currency,
    ref,
    phone,
    paidAt: moment().format("DD MMM YYYY, HH:mm"),
  });
}

// ─── NOTIFY ADMINS ────────────────────────────────────────────────────────────
function notifyAdmins(message, opts = {}) {
  ADMIN_IDS.forEach((id) => {
    safeSendMessage(id, message, { parse_mode: "Markdown", ...opts }).catch(() => {});
  });
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
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

// ─── MESSAGE HANDLERS ─────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId = cid(msg.chat.id);
  const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;

  if (!userSelections[chatId]) userSelections[chatId] = {};
  userSelections[chatId].username = username;
  saveUserSelection(chatId, userSelections[chatId]);

  await sendTyping(chatId, 1200);
  safeSendMessage(chatId,
    `Welcome ${username} 🚀\n\nSelect your preferred package below:`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔥 Naughty Premium Leaks", callback_data: "package_naughty_premium_leaks" }],
          [{ text: "💥 Naughty Explicit (Free Hookups)", callback_data: "package_naughty_explicit" }],
        ],
      },
    }
  );
});

bot.onText(/\/myid/, (msg) => {
  safeSendMessage(cid(msg.chat.id), `🆔 Your Chat ID: \`${msg.chat.id}\``);
});

bot.onText(/\/testadmin/, (msg) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return;
  notifyAdmins(`🧪 *Test Notification*\nFrom: \`${msg.chat.id}\``);
  safeSendMessage(cid(msg.chat.id), "✅ Test sent to all admins.");
});

bot.onText(/\/testlink/, async (msg) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return;
  try {
    const res = await bot.createChatInviteLink(CHANNEL_ID, {
      member_limit: 1,
      expire_date: Math.floor(Date.now() / 1000) + 300,
      name: "TestLink",
    });
    safeSendMessage(cid(msg.chat.id), `✅ *Bot can create invite links!*\n\nTest link: ${res.invite_link}`);
  } catch (err) {
    safeSendMessage(cid(msg.chat.id), `❌ *Cannot create invite links*\n\nError: \`${err.message}\``);
  }
});

// ─── CALLBACK QUERIES ─────────────────────────────────────────────────────────
bot.on("callback_query", async (query) => {
  const chatId = cid(query.message.chat.id);
  const data = query.data;

  bot.answerCallbackQuery(query.id).catch(() => {});
  await sendTyping(chatId, 600);

  // Admin grant
  if (data.startsWith("admin_grant_")) {
    if (!ADMIN_IDS.includes(chatId)) return;
    const withoutPrefix = data.replace("admin_grant_", "");
    const firstUndIdx = withoutPrefix.indexOf("_");
    const targetId = cid(withoutPrefix.substring(0, firstUndIdx));
    const planLabel = withoutPrefix.substring(firstUndIdx + 1);

    try {
      delete awaitingReceipt[targetId];
      await grantAccess(targetId, planLabel || "1 Month", `✅ Access verified and granted by admin\n📦 Plan: *${planLabel || "1 Month"}*`);
      safeSendMessage(chatId, `✅ *Access Granted*\n\nUser: \`${targetId}\`\nPlan: *${planLabel}*`);
    } catch (err) {
      safeSendMessage(chatId, `❌ Failed: ${err.message}`);
    }
    return;
  }

  // Package selection
  if (data === "package_naughty_premium_leaks") {
    const existingUsername = (userSelections[chatId] || {}).username;
    userSelections[chatId] = { package: "Naughty Premium Leaks", username: existingUsername };
    saveUserSelection(chatId, userSelections[chatId]);
    return safeSendMessage(chatId,
      `🔥 *Great choice!* Naughty Premium Leaks is our most popular package.\n\nPick your plan:`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "1 Day — Ksh 40", callback_data: "naughty_1day" }],
            [{ text: "1 Week — Ksh 170", callback_data: "naughty_1week" }],
            [{ text: "2 Weeks — Ksh 270", callback_data: "naughty_2weeks" }],
            [{ text: "1 Month — Ksh 450", callback_data: "naughty_1month" }],
            [{ text: "6 Months — Ksh 2,500 🔥 Best Value", callback_data: "naughty_6months" }],
            [{ text: "1 Year — Ksh 6,200 👑 VIP", callback_data: "naughty_1year" }],
          ],
        },
      }
    );
  }

  if (data === "package_naughty_explicit") {
    const existingUsername = (userSelections[chatId] || {}).username;
    userSelections[chatId] = { package: "Naughty Explicit", username: existingUsername };
    saveUserSelection(chatId, userSelections[chatId]);
    return safeSendMessage(chatId,
      `💥 *You picked Naughty Explicit!* Free Hookups included.\n\nChoose your plan:`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "1 Day — Ksh 50", callback_data: "premium_1day" }],
            [{ text: "1 Week — Ksh 220", callback_data: "premium_1week" }],
            [{ text: "2 Weeks — Ksh 400", callback_data: "premium_2weeks" }],
            [{ text: "1 Month — Ksh 680", callback_data: "premium_1month" }],
            [{ text: "6 Months — Ksh 3,500 🔥 Best Value", callback_data: "premium_6months" }],
            [{ text: "1 Year — Ksh 7,000 👑 VIP", callback_data: "premium_1year" }],
          ],
        },
      }
    );
  }

  if (data === "change_package") {
    return safeSendMessage(chatId, `🔄 *Choose a package:*`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔥 Naughty Premium Leaks", callback_data: "package_naughty_premium_leaks" }],
          [{ text: "💥 Naughty Explicit (Free Hookups)", callback_data: "package_naughty_explicit" }],
        ],
      },
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

    const backTarget = data.startsWith("naughty_") ? "package_naughty_premium_leaks" : "package_naughty_explicit";

    return safeSendMessage(chatId,
      `✅ *${sel.package}* — *${plan.label}*\n💰 Ksh *${plan.price}*\n\nHow would you like to pay?`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: `📲 Pay via STK Push (Recommended)`, callback_data: "pay_stk" }],
            [{ text: `💳 Pay Manually via Till`, callback_data: "show_till" }],
            [{ text: `⬅️ Change Plan`, callback_data: `back_to_${backTarget}` }],
          ],
        },
      }
    );
  }

  // STK Push payment flow
  if (data === "pay_stk") {
    const sel = userSelections[chatId];
    if (!sel?.price) {
      return safeSendMessage(chatId, "⚠️ Please select a package and plan first using /start.");
    }
    userSelections[chatId].awaitingPhone = true;
    saveUserSelection(chatId, userSelections[chatId]);
    return safeSendMessage(chatId,
      `📱 *M-Pesa STK Push Payment*\n\nPlease enter your *M-Pesa phone number* to receive a payment prompt.\n\nFormat: *07XXXXXXXX* or *01XXXXXXXX*\n\nExample: \`0712345678\``,
      { parse_mode: "Markdown" }
    );
  }

  // Manual payment via Till
  if (data === "show_till") {
    const sel = userSelections[chatId];
    if (!sel?.price) {
      return safeSendMessage(chatId, "⚠️ Please select a package and plan first using /start.");
    }
    return safeSendMessage(chatId,
      tillCard(sel.package, sel.plan, sel.price) +
      `\n\n✅ *Once you have paid:*\nTap the button below to submit your M-Pesa confirmation code.`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: "✅ I've Paid — Submit Code", callback_data: "confirm_payment" }]],
        },
      }
    );
  }

  // Confirm payment - PROMPT USER FOR CODE
  if (data === "confirm_payment") {
    const sel = userSelections[chatId];
    if (!sel?.price) {
      return safeSendMessage(chatId, "⚠️ Please select a package and plan first using /start.");
    }

    // Store that we're waiting for receipt code
    awaitingReceipt[chatId] = {
      plan: sel.plan || "1 Month",
      pkg: sel.package || "N/A",
      price: sel.price || 0,
    };

    // PROMPT THE USER - THIS IS THE FIXED PART
    return safeSendMessage(chatId,
      `📋 *Enter Your M-Pesa Confirmation Code*\n\n` +
      `Please type your *M-Pesa confirmation code* from your payment SMS.\n\n` +
      `It looks like: \`RCX4B2K9QP\` — 10 characters\n\n` +
      `We'll verify it automatically and send your access right away. 🔍`
    );
  }

  if (data === "need_help") {
    return safeSendMessage(chatId,
      `🛠️ *Need Help?*\n\n` +
      `• *STK push not arriving?* Make sure your number is active on M-Pesa and try again.\n` +
      `• *Payment deducted but no access?* Tap "I've Paid" and enter your M-Pesa code.\n` +
      `• *Wrong amount?* Go back and reselect your plan.\n\n` +
      `Still stuck? Our admin will assist you shortly. 👇`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Try STK Again", callback_data: "pay_stk" }],
            [{ text: "💳 Manual Till", callback_data: "show_till" }],
            [{ text: "🔁 Change Package", callback_data: "change_package" }],
          ],
        },
      }
    );
  }

  if (data === "dismiss_reminder") {
    clearReminders(chatId);
    return safeSendMessage(chatId, `👍 No problem! Use /start whenever you're ready.`);
  }
});

// ─── INCOMING TEXT MESSAGES ───────────────────────────────────────────────────
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;

  const chatId = cid(msg.chat.id);
  const text = msg.text.trim();
  const sel = userSelections[chatId];

  // Handle M-Pesa receipt code submission
  if (awaitingReceipt[chatId]) {
    const receiptInfo = awaitingReceipt[chatId];
    const code = text.toUpperCase().replace(/\s/g, "");

    // Validate code format (M-Pesa codes are 10 characters alphanumeric)
    if (!/^[A-Z0-9]{10}$/.test(code)) {
      return safeSendMessage(chatId,
        `⚠️ That doesn't look like a valid M-Pesa code.\n\nM-Pesa codes are *10 characters* long, e.g. \`RCX4B2K9QP\`.\n\nCheck your SMS and try again.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "❓ I Need Help", callback_data: "need_help" }],
              [{ text: "🔄 Try Again", callback_data: "pay_stk" }],
            ],
          },
        }
      );
    }

    // Save the code and trigger verification
    awaitingReceipt[chatId] = { ...receiptInfo, code };
    await autoVerifyReceipt(chatId, code, receiptInfo);
    return;
  }

  // Handle phone number entry for STK push
  if (sel?.awaitingPhone) {
    sel.awaitingPhone = false;
    userSelections[chatId] = sel;
    saveUserSelection(chatId, sel);

    let cleaned;
    try {
      cleaned = validatePhone(text);
    } catch (err) {
      return safeSendMessage(chatId,
        `⚠️ *Invalid phone number.*\n\nPlease enter a valid Safaricom number:\n• *07XXXXXXXX*\n• *01XXXXXXXX*\n\nExample: \`0712345678\``
      );
    }

    await sendTyping(chatId, 1000);
    await safeSendMessage(chatId,
      `⏳ *Sending payment prompt to ${cleaned}...*\n\nCheck your phone and enter your M-Pesa PIN when prompted. 📲`
    );

    try {
      const result = await stkPush(cleaned, sel.price, chatId);
      if (result.ResponseCode === "0") {
        await safeSendMessage(chatId,
          `✅ *Payment prompt sent!*\n\nEnter your M-Pesa PIN to complete the payment. Your access will be sent automatically once confirmed. 🔐\n\n` +
          `_If you've already paid but don't receive access within 2 minutes, tap below._`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "✅ I've Paid — Confirm Access", callback_data: "confirm_payment" }],
                [{ text: "❓ I Need Help", callback_data: "need_help" }],
              ],
            },
          }
        );
      } else {
        await safeSendMessage(chatId,
          `⚠️ *Could not send payment prompt.*\n\nReason: _${result.ResponseDescription || "Unknown error"}_\n\nPay manually via M-Pesa till 👇`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "💳 Pay Manually via Till", callback_data: "show_till" }],
                [{ text: "🔄 Try STK Again", callback_data: "pay_stk" }],
                [{ text: "❓ I Need Help", callback_data: "need_help" }],
              ],
            },
          }
        );
      }
    } catch (err) {
      await safeSendMessage(chatId,
        `❌ *Payment request failed.*\n\n_${err.message}_\n\nPay manually via M-Pesa till 👇`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "💳 Pay Manually via Till", callback_data: "show_till" }],
              [{ text: "🔄 Try STK Again", callback_data: "pay_stk" }],
              [{ text: "❓ I Need Help", callback_data: "need_help" }],
            ],
          },
        }
      );
    }
    return;
  }

  // Auto-detect M-Pesa code from free text
  if (/^[A-Z0-9]{10}$/.test(text.toUpperCase())) {
    const code = text.toUpperCase();
    const sel2 = userSelections[chatId] || {};

    if (sel2.paidAt) {
      return safeSendMessage(chatId,
        `✅ You already have active access! If you have an issue tap below.`,
        { reply_markup: { inline_keyboard: [[{ text: "❓ I Need Help", callback_data: "need_help" }]] } }
      );
    }

    const receiptInfo = {
      plan: sel2.plan || "1 Month",
      pkg: sel2.package || "N/A",
      price: sel2.price || 0,
      code,
    };
    awaitingReceipt[chatId] = receiptInfo;
    await autoVerifyReceipt(chatId, code, receiptInfo);
    return;
  }

  // Default response for unrecognized input
  if (sel && !sel.paidAt) {
    return safeSendMessage(chatId,
      `Sorry, I didn't understand that.\n\n` +
      `If you've already paid, please send your *M-Pesa confirmation code* (e.g. \`RCX4B2K9QP\`).\n\n` +
      `Otherwise, choose an option below 👇`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "📲 Pay via STK Push", callback_data: "pay_stk" }],
            [{ text: "💳 Pay Manually via Till", callback_data: "show_till" }],
            [{ text: "❓ I Need Help", callback_data: "need_help" }],
          ],
        },
      }
    );
  }
});

// ─── RESTORE SUBSCRIPTIONS ON STARTUP ────────────────────────────────────────
function restoreSubTimers() {
  const data = loadSubs();
  const entries = Object.entries(data);
  if (!entries.length) return;

  entries.forEach(([chatId, { planLabel, expiresAt }]) => {
    const msLeft = expiresAt - Date.now();
    if (msLeft <= 0) {
      removeUserFromChannel(chatId, "offline expiry");
      removeSubEntry(chatId);
      return;
    }

    const timers = { expiresAt };
    if (msLeft > warnMs) {
      timers.warnTimer = setTimeout(() => {
        safeSendMessage(chatId,
          `⏰ *Heads up!*\n\nYour *${planLabel}* access expires in *24 hours*.\n\nRenew now to stay connected! 😊`,
          { reply_markup: { inline_keyboard: [[{ text: "🔄 Renew My Access", callback_data: "change_package" }]] } }
        ).catch(() => {});
      }, msLeft - warnMs);
    }
    timers.kickTimer = setTimeout(async () => {
      await removeUserFromChannel(chatId, "restored expiry");
      safeSendMessage(chatId,
        `👋 *Your subscription has ended.*\n\nYour *${planLabel}* plan has expired.\n\nReady to come back anytime 😊`,
        { reply_markup: { inline_keyboard: [[{ text: "🔄 Re-subscribe Now", callback_data: "change_package" }]] } }
      ).catch(() => {});
      delete subTimers[chatId];
      removeSubEntry(chatId);
    }, msLeft);
    subTimers[chatId] = timers;
  });
}

// ─── EXPRESS SERVER ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);
  console.log(`📡 Callback: ${CALLBACK_URL || "⚠️ NOT SET"}`);
  console.log(`📺 Channel ID: ${CHANNEL_ID}`);
  console.log(`👤 Admins: ${ADMIN_IDS.join(", ")}`);

  setTimeout(restoreSubTimers, 3000);

  if (RENDER_URL) {
    setInterval(() => {
      axios.get(`${RENDER_URL}/`).catch(() => {});
    }, 10 * 60 * 1000);
  }
});