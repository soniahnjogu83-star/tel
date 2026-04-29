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
// For Buy Goods (Till):
//   SHORTCODE    = your Till Number (e.g. 3424231)
//   TILL_NUMBER  = same Till Number
//   MPESA_TYPE   = "till" (default)
//
// For Paybill:
//   SHORTCODE    = Paybill number
//   TILL_NUMBER  = account number (can be same as SHORTCODE)
//   MPESA_TYPE   = "paybill"

const TILL_NUMBER     = process.env.TILL_NUMBER || process.env.SHORTCODE;
const TILL_NAME       = process.env.TILL_NAME   || "ALJAKI Enterprise";
const SHORTCODE       = process.env.SHORTCODE;
const PASSKEY         = process.env.PASSKEY;
const CONSUMER_KEY    = process.env.CONSUMER_KEY;
const CONSUMER_SECRET = process.env.CONSUMER_SECRET;
const CALLBACK_URL    = process.env.CALLBACK_URL || "";
const BOT_TOKEN       = process.env.BOT_TOKEN;
const RENDER_URL      = process.env.RENDER_EXTERNAL_URL || null;

// Admin IDs — comma-separated in env, e.g. ADMIN_IDS=123456789,987654321
// Falls back to the hardcoded value if env not set
const ADMIN_IDS = (process.env.ADMIN_IDS || "8132815796")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// STK Push type: "till" or "paybill"
const MPESA_TYPE = (process.env.MPESA_TYPE || "till").toLowerCase();

// ─── DARAJA BASE URL ─────────────────────────────────────────────────────────
// Use MPESA_ENV=sandbox for testing, production is default
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
const warnMs         = 24 * 60 * 60 * 1000; // 24 hours

const userSelections = {};
let pendingSTK        = {};
const awaitingReceipt = {};
const reminderTimers  = {};
const subTimers       = {};
const verifyingCodes  = new Set();

let autoExpireSubscriptions = process.env.AUTO_EXPIRE   !== "false";
let autoSendInvite          = process.env.AUTO_SEND_INVITE !== "false";

// ─── CHANNEL_ID ──────────────────────────────────────────────────────────────
const CHANNEL_ID = Number(process.env.CHANNEL_ID || "-1001567081082");

// ─── PERSISTENCE FILES ──────────────────────────────────────────────────────
const SUBS_FILE        = path.join(__dirname, "subscriptions.json");
const PENDING_STK_FILE = path.join(__dirname, "pending_stk.json");
const USER_SEL_FILE    = path.join(__dirname, "user_selections.json");

// ─── BOT SETUP ────────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: false });
let pollingActive = false;

async function startPollingWithRetry(attempt = 1) {
  try {
    await bot.deleteWebHook({ drop_pending_updates: true });
    console.log("✅ Webhook deleted.");
  } catch (err) {
    console.warn("⚠️  Could not delete webhook:", err.message);
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

async function shutdown(signal) {
  console.log(`\n🛑 ${signal} — shutting down...`);
  pollingActive = false;
  try { await bot.stopPolling(); } catch (_) {}
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

// ─── LOAD PERSISTED DATA ─────────────────────────────────────────────────────
pendingSTK = loadPendingSTK();
Object.assign(userSelections, loadUserSelections());

// ─── ENV VALIDATION ──────────────────────────────────────────────────────────
(function validateEnv() {
  const required = {
    BOT_TOKEN,
    SHORTCODE:       process.env.SHORTCODE,
    PASSKEY:         process.env.PASSKEY,
    CONSUMER_KEY:    process.env.CONSUMER_KEY,
    CONSUMER_SECRET: process.env.CONSUMER_SECRET,
    CALLBACK_URL:    process.env.CALLBACK_URL,
  };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    const msg = `🚨 *STARTUP WARNING*\n\nMissing env vars:\n` +
      missing.map((k) => `• \`${k}\``).join("\n") +
      `\n\n⚠️ Bot and/or STK Push will NOT work until these are set.`;
    console.error("❌ Missing env vars:", missing.join(", "));
    setTimeout(() => {
      ADMIN_IDS.forEach((id) =>
        bot.sendMessage(id, msg, { parse_mode: "Markdown" }).catch(() => {})
      );
    }, 5000);
  } else {
    console.log("✅ All required env vars present.");
    console.log(`📋 M-Pesa mode: ${MPESA_TYPE.toUpperCase()} | Env: ${MPESA_ENV.toUpperCase()} | SHORTCODE: ${SHORTCODE} | TILL: ${TILL_NUMBER}`);
    console.log(`👤 Admin IDs: ${ADMIN_IDS.join(", ")}`);
  }
})();

// ─── PERSISTENCE FUNCTIONS ───────────────────────────────────────────────────
function loadSubs() {
  try {
    if (fs.existsSync(SUBS_FILE))
      return JSON.parse(fs.readFileSync(SUBS_FILE, "utf8"));
  } catch (e) { console.error("⚠️ loadSubs:", e.message); }
  return {};
}
function saveSubs(data) {
  try { fs.writeFileSync(SUBS_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error("⚠️ saveSubs:", e.message); }
}
function loadPendingSTK() {
  try {
    if (fs.existsSync(PENDING_STK_FILE))
      return JSON.parse(fs.readFileSync(PENDING_STK_FILE, "utf8"));
  } catch (e) { console.error("⚠️ loadPendingSTK:", e.message); }
  return {};
}
function savePendingSTK(data) {
  try { fs.writeFileSync(PENDING_STK_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error("⚠️ savePendingSTK:", e.message); }
}
function loadUserSelections() {
  try {
    if (fs.existsSync(USER_SEL_FILE))
      return JSON.parse(fs.readFileSync(USER_SEL_FILE, "utf8"));
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

async function sendTyping(chatId, durationMs = 1500) {
  try {
    await bot.sendChatAction(cid(chatId), "typing");
    await new Promise((r) => setTimeout(r, durationMs));
  } catch (_) {}
}

// ─── PHONE VALIDATION ─────────────────────────────────────────────────────────
function validatePhone(phone) {
  let cleaned = String(phone).replace(/\D/g, "");
  if (cleaned.startsWith("254")) {
    // already international
  } else if (cleaned.startsWith("0")) {
    cleaned = "254" + cleaned.substring(1);
  } else if (cleaned.length === 9) {
    cleaned = "254" + cleaned;
  }
  // Valid Safaricom: 2547XXXXXXXX or 2541XXXXXXXX (12 digits)
  if (!/^254[17]\d{8}$/.test(cleaned)) {
    throw new Error("Invalid Safaricom number. Use 07XXXXXXXX or 01XXXXXXXX");
  }
  return cleaned;
}

// ─── M-PESA: GET ACCESS TOKEN ─────────────────────────────────────────────────
// FIX: The 400 error is caused by sending credentials incorrectly.
// The correct endpoint is /oauth/v1/generate?grant_type=client_credentials
// with Basic auth header containing base64(consumerKey:consumerSecret)
async function getMpesaToken() {
  try {
    // Validate credentials exist before attempting
    if (!CONSUMER_KEY || !CONSUMER_SECRET) {
      throw new Error("CONSUMER_KEY or CONSUMER_SECRET not set in environment");
    }

    const credentials = `${CONSUMER_KEY}:${CONSUMER_SECRET}`;
    const auth        = Buffer.from(credentials).toString("base64");

    console.log(`🔑 Fetching Daraja token from ${DARAJA_BASE_URL}...`);

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
      throw new Error(`Unexpected token response: ${JSON.stringify(res.data)}`);
    }

    console.log("✅ Daraja token fetched successfully");
    return res.data.access_token;
  } catch (err) {
    const status  = err.response?.status;
    const body    = err.response?.data;
    const detail  = body?.errorMessage || body?.error_description || body?.error || err.message;

    console.error(`❌ getMpesaToken failed [HTTP ${status || "N/A"}]:`, detail);
    console.error("   Full error body:", JSON.stringify(body));

    // Give admin actionable info
    let hint = "";
    if (status === 400) hint = "\n\n💡 *HTTP 400* = bad credentials. Check CONSUMER_KEY & CONSUMER_SECRET in Render env vars.";
    if (status === 401) hint = "\n\n💡 *HTTP 401* = unauthorized. Your app may be inactive on Daraja portal.";
    if (status === 403) hint = "\n\n💡 *HTTP 403* = forbidden. Your API user may not have STK Push permissions.";

    notifyAdmins(`🚨 *Daraja Token Error*\nHTTP ${status || "N/A"}: \`${detail}\`${hint}`);
    throw new Error(`Daraja token error [${status}]: ${detail}`);
  }
}

// ─── M-PESA: STK PUSH ────────────────────────────────────────────────────────
// For Buy Goods (Till):
//   BusinessShortCode = TILL_NUMBER
//   PartyB            = TILL_NUMBER
//   TransactionType   = "CustomerBuyGoodsOnline"
//   Password          = base64(TILL_NUMBER + PASSKEY + timestamp)
//
// For Paybill:
//   BusinessShortCode = SHORTCODE
//   PartyB            = SHORTCODE
//   TransactionType   = "CustomerPayBillOnline"
//   Password          = base64(SHORTCODE + PASSKEY + timestamp)
async function stkPush(phone, amount, chatId) {
  const id = cid(chatId);
  try {
    const token     = await getMpesaToken();
    const timestamp = moment().format("YYYYMMDDHHmmss");

    // For till: BusinessShortCode = TILL_NUMBER, for paybill: BusinessShortCode = SHORTCODE
    const businessShortCode = MPESA_TYPE === "paybill" ? SHORTCODE : TILL_NUMBER;
    const partyB            = TILL_NUMBER; // always the receiving till/paybill
    const transactionType   = MPESA_TYPE === "paybill"
      ? "CustomerPayBillOnline"
      : "CustomerBuyGoodsOnline";

    // Password: base64(businessShortCode + PASSKEY + timestamp)
    const rawPassword = `${businessShortCode}${PASSKEY}${timestamp}`;
    const password    = Buffer.from(rawPassword).toString("base64");

    let normalized;
    try {
      normalized = validatePhone(phone);
    } catch (e) {
      throw new Error(e.message);
    }

    const amountInt = Math.ceil(Number(amount));

    console.log(`📲 STK Push → ${normalized} | Ksh ${amountInt} | ShortCode: ${businessShortCode} | PartyB: ${partyB} | Type: ${transactionType}`);

    // AccountReference ≤12 chars, TransactionDesc ≤13 chars
    const payload = {
      BusinessShortCode: businessShortCode,
      Password:          password,
      Timestamp:         timestamp,
      TransactionType:   transactionType,
      Amount:            amountInt,
      PartyA:            normalized,
      PartyB:            partyB,
      PhoneNumber:       normalized,
      CallBackURL:       CALLBACK_URL,
      AccountReference:  "ALJAKI",
      TransactionDesc:   "Access",
    };

    console.log("📤 STK payload (no password):", JSON.stringify({ ...payload, Password: "[REDACTED]" }));

    const res = await axios.post(
      `${DARAJA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
      payload,
      {
        headers: {
          Authorization:  `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );

    console.log("📥 STK response:", JSON.stringify(res.data));

    if (res.data.ResponseCode === "0") {
      const sel   = userSelections[id] || {};
      const entry = {
        chatId:    id,
        plan:      sel.plan    || null,
        pkg:       sel.package || sel.pkg || null,
        price:     sel.price   || amount,
        username:  sel.username || id,
        expiresAt: Date.now() + 10 * 60 * 1000, // 10 min TTL
      };
      pendingSTK[res.data.CheckoutRequestID] = entry;
      savePendingSTK(pendingSTK);
      console.log(`📌 Pending STK registered: ${res.data.CheckoutRequestID} →`, JSON.stringify(entry));
    } else {
      console.warn(`⚠️ STK non-zero ResponseCode: ${res.data.ResponseCode} — ${res.data.ResponseDescription}`);
    }

    return res.data;
  } catch (err) {
    // If it's already a formatted error from above, just rethrow
    if (err.response) {
      const status  = err.response.status;
      const body    = err.response.data;
      const detail  = body?.errorMessage || body?.ResultDesc || body?.error_description || err.message;
      console.error(`❌ STK HTTP ${status}:`, JSON.stringify(body));
      notifyAdmins(`🚨 *STK Push HTTP ${status}*\nChat: \`${id}\`\nError: \`${detail}\``);
      throw new Error(`STK push failed [HTTP ${status}]: ${detail}`);
    }
    // Network or other error
    console.error("❌ stkPush error:", err.message);
    notifyAdmins(`🚨 *STK Push Failed*\nChat: \`${id}\`\nError: \`${err.message}\``);
    throw err;
  }
}

// ─── PENDING RECEIPT VERIFICATIONS ───────────────────────────────────────────
const pendingReceiptVerifications = {};

// ─── M-PESA CALLBACK ─────────────────────────────────────────────────────────
app.post("/mpesa/callback", (req, res) => {
  res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  console.log("📩 M-PESA CALLBACK:", JSON.stringify(req.body, null, 2));

  try {
    const body    = req.body?.Body?.stkCallback;
    const checkId = body?.CheckoutRequestID;
    const code    = body?.ResultCode;

    console.log(`🔍 Callback: CheckoutRequestID=${checkId}, ResultCode=${code}`);

    const pending = pendingSTK[checkId];
    if (!pending) {
      console.warn(`⚠️ Unknown CheckoutRequestID: ${checkId}`);
      notifyAdmins(
        `⚠️ *Unknown STK Callback*\n\nCheckoutRequestID: \`${checkId}\`\nResultCode: ${code}\n\n` +
        `_Server may have restarted after STK push._\n\nIf user paid:\n\`/grant <chatId>\``
      );
      return;
    }

    delete pendingSTK[checkId];
    savePendingSTK(pendingSTK);

    const { chatId, plan, pkg, price, username } = pending;
    const id = cid(chatId);

    if (code === 0) {
      const meta      = body.CallbackMetadata?.Item || [];
      const get       = (name) => meta.find((i) => i.Name === name)?.Value ?? "—";
      const amount    = get("Amount");
      const mpesaCode = get("MpesaReceiptNumber");
      const phone     = get("PhoneNumber");

      console.log(`💰 Payment confirmed: Ksh ${amount} | ${mpesaCode} | ${phone}`);

      const sel  = userSelections[id] || {};
      sel.paidAt = new Date().toISOString();
      sel.stkRef = mpesaCode;
      sel.phone  = phone;
      if (!sel.plan    && plan) sel.plan    = plan;
      if (!sel.package && pkg)  sel.package = pkg;
      userSelections[id] = sel;
      saveUserSelection(id, sel);
      clearReminders(id);

      const finalPlan = sel.plan || plan || "1 Month";

      recordPayment({
        chatId: id, username: sel.username || username,
        pkg: sel.package || pkg || "N/A", plan: finalPlan,
        amount, ref: mpesaCode, phone,
      });

      grantAccess(id, finalPlan, `✅ Ksh *${amount}* received via M-Pesa\n🧾 Ref: \`${mpesaCode}\``);

      notifyAdmins(
        `💰 *PAYMENT CONFIRMED (STK)*\n\n` +
        `👤 \`${id}\`\n📦 ${sel.package || pkg || "N/A"} — ${finalPlan}\n` +
        `💰 Ksh ${amount} | 🧾 \`${mpesaCode}\`\n📱 ${phone}\n\n➡️ Access being sent.`
      );
    } else {
      // Payment failed/cancelled — prompt for manual receipt
      awaitingReceipt[id] = {
        plan:  plan  || (userSelections[id] || {}).plan    || "1 Month",
        pkg:   pkg   || (userSelections[id] || {}).package || "N/A",
        price: price || (userSelections[id] || {}).price   || 0,
      };

      const resultDesc = body?.ResultDesc || "Payment prompt was not completed";
      safeSendMessage(id,
        `⚠️ *Payment not completed.*\n\n_${resultDesc}_\n\n` +
        `📋 *If your M-Pesa was actually deducted*, type your *M-Pesa confirmation code* from your SMS (e.g. \`RCX4B2K9QP\`) and we'll verify it automatically. 🔍\n\n` +
        `Otherwise, choose an option below 👇`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "💳 Pay Manually via Till", callback_data: "show_till" }],
              [{ text: "🔄 Try STK Push Again",    callback_data: "pay_stk" }],
              [{ text: "❓ I Need Help",            callback_data: "need_help" }],
            ],
          },
        }
      ).catch(() => {});
    }
  } catch (err) {
    console.error("❌ STK Callback error:", err.message, err.stack);
    notifyAdmins(`🚨 *STK Callback crashed*\n\`${err.message}\``);
  }
});

// ─── AUTO VERIFY RECEIPT ─────────────────────────────────────────────────────
async function autoVerifyReceipt(chatId, receiptCode, receiptInfo) {
  const id = cid(chatId);

  if (verifyingCodes.has(receiptCode)) {
    console.log(`⏳ Already verifying ${receiptCode} — skipping duplicate`);
    return;
  }
  verifyingCodes.add(receiptCode);

  try {
    await sendTyping(id, 1500);
    await safeSendMessage(id, `🔍 *Verifying your payment...*\n\nChecking with M-Pesa now. This takes a few seconds ⏳`);

    const initiatorName = process.env.MPESA_INITIATOR_NAME;
    const initiatorPass = process.env.MPESA_INITIATOR_PASS;

    if (!initiatorName || !initiatorPass) {
      console.warn("⚠️ MPESA_INITIATOR_NAME/PASS not set — falling back to admin verification");
      await fallbackToAdminVerification(id, receiptCode, receiptInfo);
      return;
    }

    const token = await getMpesaToken();

    pendingReceiptVerifications[receiptCode] = {
      chatId: id,
      plan:   receiptInfo.plan  || "1 Month",
      pkg:    receiptInfo.pkg   || "N/A",
      price:  receiptInfo.price || 0,
    };

    const securityCredential = Buffer.from(initiatorPass).toString("base64");
    const businessShortCode  = MPESA_TYPE === "paybill" ? SHORTCODE : TILL_NUMBER;

    const res = await axios.post(
      `${DARAJA_BASE_URL}/mpesa/transactionstatus/v1/query`,
      {
        Initiator:          initiatorName,
        SecurityCredential: securityCredential,
        CommandID:          "TransactionStatusQuery",
        TransactionID:      receiptCode,
        PartyA:             businessShortCode,
        IdentifierType:     "4",
        ResultURL:          CALLBACK_URL.replace("/mpesa/callback", "/mpesa/transresult"),
        QueueTimeOutURL:    CALLBACK_URL.replace("/mpesa/callback", "/mpesa/transtimeout"),
        Remarks:            "VerifyPayment",
        Occasion:           "Access",
      },
      {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        timeout: 15000,
      }
    );

    console.log(`📡 Transaction status query for ${receiptCode}:`, JSON.stringify(res.data));

    if (res.data.ResponseCode === "0") {
      await safeSendMessage(id,
        `⏳ *Almost there!*\n\nYour payment code has been sent to M-Pesa for verification.\nYou'll receive your access link automatically once confirmed — usually within 30 seconds. 🔐`
      );
    } else {
      delete pendingReceiptVerifications[receiptCode];
      await fallbackToAdminVerification(id, receiptCode, receiptInfo);
    }
  } catch (err) {
    console.error("❌ autoVerifyReceipt error:", err.message);
    delete pendingReceiptVerifications[receiptCode];
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

// ─── TRANSACTION STATUS RESULT ────────────────────────────────────────────────
app.post("/mpesa/transresult", async (req, res) => {
  res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  console.log("📩 TRANSACTION STATUS RESULT:", JSON.stringify(req.body, null, 2));

  try {
    const result      = req.body?.Result;
    if (!result) return;
    const receiptCode = result.TransactionID;
    const resultCode  = result.ResultCode;

    const pending = pendingReceiptVerifications[receiptCode];
    if (!pending) {
      console.warn(`⚠️ No pending verification for ${receiptCode}`);
      return;
    }

    const { chatId, plan, pkg, price } = pending;

    if (resultCode === 0) {
      delete pendingReceiptVerifications[receiptCode];
      delete awaitingReceipt[chatId];

      const params   = result.ResultParameters?.ResultParameter || [];
      const getParam = (name) => params.find((p) => p.Key === name)?.Value ?? "—";
      const amount   = getParam("Amount");
      const receiver = getParam("DebitPartyName");

      // Verify payment went to our till
      const receiverStr = String(receiver || "");
      if (receiverStr && !receiverStr.includes(TILL_NUMBER) && !receiverStr.toLowerCase().includes("aljaki")) {
        console.warn(`⚠️ Payment went to wrong recipient: ${receiver}`);
        notifyAdmins(`⚠️ *Wrong recipient!*\nCode: \`${receiptCode}\`\nChatID: \`${chatId}\`\nReceiver: ${receiver}\n\nDO NOT grant access.`);
        await safeSendMessage(chatId,
          `❌ *Verification Failed*\n\nThe payment code \`${receiptCode}\` was not sent to our till.\n\nPlease pay to Till *${TILL_NUMBER}* (${TILL_NAME}) and try again.`,
          { reply_markup: { inline_keyboard: [[{ text: "❓ Contact Support", callback_data: "need_help" }]] } }
        );
        return;
      }

      const sel  = userSelections[chatId] || {};
      sel.paidAt = new Date().toISOString();
      sel.stkRef = receiptCode;
      if (!sel.plan    && plan) sel.plan    = plan;
      if (!sel.package && pkg)  sel.package = pkg;
      userSelections[chatId] = sel;
      saveUserSelection(chatId, sel);
      clearReminders(chatId);

      const finalPlan = sel.plan || plan || "1 Month";

      recordPayment({
        chatId, username: sel.username || chatId,
        pkg: sel.package || pkg || "N/A", plan: finalPlan,
        amount: amount !== "—" ? Number(amount) : price,
        ref: receiptCode, phone: sel.phone || "Manual",
      });

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
      const errDesc    = result.ResultDesc || "Unknown error";
      const isNotFound = /not found|no records/i.test(errDesc);
      const isDupe     = /duplicate/i.test(errDesc);

      if (isDupe) {
        notifyAdmins(
          `⚠️ *Duplicate receipt* \`${receiptCode}\`\nChatID: \`${chatId}\`\nReview manually.`,
          {
            reply_markup: {
              inline_keyboard: [[
                { text: `✅ Grant Anyway — ${chatId}`, callback_data: `admin_grant_${chatId}_${plan || "1 Month"}` },
                { text: `❌ Reject`, callback_data: "noop" },
              ]],
            },
          }
        );
        await safeSendMessage(chatId,
          `⚠️ *Payment already processed.*\n\nThis M-Pesa code was already verified. If you believe this is an error, our team has been notified. 🙏`
        );
      } else if (isNotFound) {
        await safeSendMessage(chatId,
          `❌ *Payment Not Found*\n\nWe couldn't verify M-Pesa code \`${receiptCode}\`.\n\n` +
          `*Please check:*\n• Is the code exactly as it appears in your SMS?\n• Did you pay to Till *${TILL_NUMBER}*?\n\nTry again or use STK Push 👇`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: "🔄 Try STK Push Instead", callback_data: "pay_stk" }],
                [{ text: "❓ Contact Support",       callback_data: "need_help" }],
              ],
            },
          }
        );
      } else {
        await fallbackToAdminVerification(chatId, receiptCode, { plan, pkg, price });
      }
    }
  } catch (err) {
    console.error("❌ transresult error:", err.message, err.stack);
    notifyAdmins(`🚨 *Transaction result callback crashed*\n\`${err.message}\``);
  }
});

// ─── TRANSACTION STATUS TIMEOUT ───────────────────────────────────────────────
app.post("/mpesa/transtimeout", async (req, res) => {
  res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  console.log("⏰ TRANSACTION TIMEOUT:", JSON.stringify(req.body, null, 2));
  try {
    const result      = req.body?.Result;
    const receiptCode = result?.TransactionID;
    const pending     = receiptCode ? pendingReceiptVerifications[receiptCode] : null;
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
  const chatId        = cid(rawChatId);
  const resolvedLabel = PLAN_DAYS[planLabel] !== undefined ? planLabel : "1 Month";

  if (resolvedLabel !== planLabel) {
    console.warn(`⚠️ Unknown planLabel "${planLabel}" — falling back to "1 Month"`);
  }

  const days = PLAN_DAYS[resolvedLabel];
  if (!days || isNaN(days)) {
    console.error(`❌ grantAccess: bad planLabel "${planLabel}"`);
    notifyAdmins(`⚠️ *grantAccess FAILED*\nChatID: \`${chatId}\`\nBad planLabel: \`${planLabel}\`\n\nManual fix:\n\`/grant ${chatId}\``);
    return;
  }

  console.log(`🔑 grantAccess: chatId=${chatId}, plan=${resolvedLabel}, days=${days}`);

  try {
    // Pre-kick so single-use invite always works
    try {
      const member  = await bot.getChatMember(CHANNEL_ID, Number(chatId));
      const isAdmin = ["administrator", "creator"].includes(member.status);
      if (isAdmin) {
        console.log(`ℹ️ Pre-kick skipped — ${chatId} is channel admin`);
      } else if (!["left", "kicked"].includes(member.status)) {
        await bot.banChatMember(CHANNEL_ID, Number(chatId));
        await bot.unbanChatMember(CHANNEL_ID, Number(chatId));
        console.log(`🔄 Pre-kick done for ${chatId}`);
      }
    } catch (preKickErr) {
      console.log(`ℹ️ Pre-kick skipped: ${preKickErr.message}`);
    }

    const nowMs        = Date.now();
    const durationMs   = days * 24 * 60 * 60 * 1000;
    const expiresAtMs  = nowMs + durationMs;
    const inviteExpiry = Math.floor(expiresAtMs / 1000);

    const inviteRes = await bot.createChatInviteLink(CHANNEL_ID, {
      member_limit: 1,
      expire_date:  inviteExpiry,
      name:         `Access-${chatId}-${Date.now()}`,
    });

    const inviteLink = inviteRes.invite_link;
    console.log(`✅ Invite link created: ${inviteLink}`);

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
      console.log(`📨 Invite sent to ${chatId}`);
    } else {
      await safeSendMessage(chatId,
        `🎉 *Payment confirmed!*\n\n${paymentSummary}\n\n✅ An admin will send your invite link shortly.`
      );
      notifyAdmins(
        `🔗 *Manual invite for* \`${chatId}\`\n\nPlan: *${resolvedLabel}* (${days}d)\nLink: ${inviteLink}\n\n_Auto-send is OFF._`
      );
    }

    // ── AUTO-EXPIRY TIMERS ────────────────────────────────────────────────
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
          `👋 *Your subscription has ended.*\n\nYour *${resolvedLabel}* plan has expired.\n\nWe hope you enjoyed your time! 🙏\n\nReady to come back anytime 😊`,
          { reply_markup: { inline_keyboard: [[{ text: "🔄 Re-subscribe Now", callback_data: "change_package" }]] } }
        ).catch(() => {});
        delete subTimers[chatId];
        removeSubEntry(chatId);
      }, durationMs);

      subTimers[chatId] = timers;
      saveSubEntry(chatId, resolvedLabel, expiresAtMs);
      console.log(`📅 Sub timer set for ${chatId} | ${resolvedLabel} | expires ${new Date(expiresAtMs).toISOString()}`);
    }

    console.log(`✅ grantAccess complete: ${chatId} | ${resolvedLabel} | ${days}d`);
  } catch (err) {
    console.error("❌ grantAccess error:", err.message, err.stack);
    notifyAdmins(
      `⚠️ *Auto-invite FAILED for* \`${chatId}\`\n\nPlan: *${resolvedLabel}* (${days}d)\nError: \`${err.message}\`\n\nGrant manually 👇`,
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

async function removeUserFromChannel(chatId, reason = "") {
  console.log(`🚪 Removing ${chatId} from channel. Reason: ${reason}`);
  try {
    await bot.banChatMember(CHANNEL_ID, Number(chatId));
    await bot.unbanChatMember(CHANNEL_ID, Number(chatId));
  } catch (err) {
    logError(`removeUserFromChannel [${chatId}]`, err);
  }
}

// ─── USDT CONFIG ──────────────────────────────────────────────────────────────
const USDT_WALLET  = process.env.USDT_WALLET  || "";
const TRONGRID_KEY = process.env.TRONGRID_KEY || "";
const pendingUSDT  = {};

// ─── RATE LIMITING ────────────────────────────────────────────────────────────
const messageCounts     = {};
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX    = 10;

function isRateLimited(chatId) {
  const id  = cid(chatId);
  const now = Date.now();
  if (!messageCounts[id]) messageCounts[id] = [];
  messageCounts[id] = messageCounts[id].filter((t) => now - t < RATE_LIMIT_WINDOW);
  if (messageCounts[id].length >= RATE_LIMIT_MAX) return true;
  messageCounts[id].push(now);
  return false;
}

// ─── PAYMENT LEDGER ───────────────────────────────────────────────────────────
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
    paidAt:   moment().format("DD MMM YYYY, HH:mm"),
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

function clearReminders(chatId) {
  const id = cid(chatId);
  if (reminderTimers[id]) {
    reminderTimers[id].timers.forEach(clearTimeout);
    delete reminderTimers[id];
  }
}

function scheduleReminders(chatId) {
  const id = cid(chatId);
  clearReminders(id);
  const sel   = userSelections[id] || {};
  const pkg   = sel.package || "the package";
  const price = sel.price || "";

  const messages = [
    {
      delay: 10 * 60 * 1000,
      text:  `👋 Just checking in — did you run into any trouble at checkout?\n\nYour *${pkg}* spot is still open. 😊`,
      keyboard: [
        [{ text: "✅ Complete My Purchase", callback_data: "pay_stk" }],
        [{ text: "⚠️ I Had an Issue",       callback_data: "need_help" }],
        [{ text: "🚫 Not Interested",        callback_data: "dismiss_reminder" }],
      ],
    },
    {
      delay: 30 * 60 * 1000,
      text:  `🔍 Your selected plan${price ? ` (*Ksh ${price}*)` : ""} is waiting whenever you're ready. ⏳`,
      keyboard: [
        [{ text: "💳 I'm Ready to Pay",  callback_data: "pay_stk" }],
        [{ text: "🔄 See Packages",      callback_data: "change_package" }],
        [{ text: "🚫 Dismiss",           callback_data: "dismiss_reminder" }],
      ],
    },
    {
      delay: 2 * 60 * 60 * 1000,
      text:  `💡 People who hesitated said it was *100% worth it* after joining.\n\nIf anything is holding you back, just say the word. 🤝`,
      keyboard: [
        [{ text: "💬 I Have a Question", callback_data: "need_help" }],
        [{ text: "✅ Let's Do This",      callback_data: "pay_stk" }],
        [{ text: "🚫 No Thanks",          callback_data: "dismiss_reminder" }],
      ],
    },
  ];

  const timers = messages.map(({ delay, text, keyboard }) =>
    setTimeout(() => {
      const current = userSelections[id];
      if (current?.paidAt) return;
      safeSendMessage(id, text, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard },
      }).catch(() => {});
    }, delay)
  );
  reminderTimers[id] = { timers };
}

// ─── USDT POLLER ──────────────────────────────────────────────────────────────
async function startUsdtPoller(chatId, expectedUsdt) {
  const id        = cid(chatId);
  let isPolling   = true;
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
            reply_markup: {
              inline_keyboard: [
                [{ text: "🔄 Try USDT Again",   callback_data: "pay_usdt" }],
                [{ text: "📲 Switch to M-Pesa", callback_data: "pay_stk" }],
              ],
            },
          }
        ).catch(() => {});
        return;
      }

      const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
      const url =
        `https://api.trongrid.io/v1/accounts/${USDT_WALLET}/transactions/trc20` +
        `?contract_address=${USDT_CONTRACT}&limit=20&min_timestamp=${startTime * 1000}`;

      const res  = await axios.get(url, { headers: { "TRON-PRO-API-KEY": TRONGRID_KEY }, timeout: 10000 });
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
          saveUserSelection(id, sel);

          const finalPlan = sel.plan || "1 Month";

          recordPayment({
            chatId: id, username: sel.username || id,
            pkg: sel.package, plan: finalPlan,
            amount: received, ref: tx.transaction_id, phone: "USDT", currency: "USDT",
          });

          grantAccess(id, finalPlan,
            `✅ *$${received} USDT* received\n🧾 TxID: \`${tx.transaction_id.substring(0, 20)}...\``
          );

          notifyAdmins(
            `💵 *USDT PAYMENT CONFIRMED*\n\n👤 \`${id}\`\n📦 ${sel.package || "N/A"} — ${finalPlan}\n💰 $${received} USDT\n🧾 \`${tx.transaction_id}\``
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
    expiresAt,
  };
  poll();
}

function stopUsdtPoller(chatId) {
  const id = cid(chatId);
  if (pendingUSDT[id]?.stop) {
    pendingUSDT[id].stop();
    delete pendingUSDT[id];
  }
}

// ─── /start ───────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId   = cid(msg.chat.id);
  const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  console.log(`👤 /start — ${username} (${chatId})`);

  if (!userSelections[chatId]) userSelections[chatId] = {};
  userSelections[chatId].username = username;
  saveUserSelection(chatId, userSelections[chatId]);

  await sendTyping(chatId, 1200);
  safeSendMessage(chatId,
    `Welcome ${username} 🚀\n\nSorry for any delay — I'm here now! Select your preferred package below:`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔥 Naughty Premium Leaks",          callback_data: "package_naughty_premium_leaks" }],
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
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return safeSendMessage(cid(msg.chat.id), "⛔ Not authorized.");
  notifyAdmins(`🧪 *Test Notification*\nFrom: \`${msg.chat.id}\``);
  safeSendMessage(cid(msg.chat.id), "✅ Test sent to all admins.");
});

bot.onText(/\/testlink/, async (msg) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return safeSendMessage(cid(msg.chat.id), "⛔ Not authorized.");
  try {
    const res = await bot.createChatInviteLink(CHANNEL_ID, {
      member_limit: 1,
      expire_date:  Math.floor(Date.now() / 1000) + 300,
      name:         "TestLink",
    });
    safeSendMessage(cid(msg.chat.id),
      `✅ *Bot can create invite links!*\n\nTest link: ${res.invite_link}\n\n_Access sending is working._`
    );
  } catch (err) {
    safeSendMessage(cid(msg.chat.id),
      `❌ *Cannot create invite links*\n\nError: \`${err.message}\`\n\nFix:\n1. Add bot as channel admin\n2. Enable *"Invite Users via Link"* permission\n3. Run /testlink again`
    );
  }
});

bot.onText(/\/testmpesa/, async (msg) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return safeSendMessage(cid(msg.chat.id), "⛔ Not authorized.");
  const chatId = cid(msg.chat.id);
  await safeSendMessage(chatId,
    `🔧 *M-Pesa Diagnostics*\n\n` +
    `• SHORTCODE: \`${SHORTCODE || "NOT SET"}\`\n` +
    `• TILL_NUMBER: \`${TILL_NUMBER || "NOT SET"}\`\n` +
    `• MPESA_TYPE: \`${MPESA_TYPE}\`\n` +
    `• MPESA_ENV: \`${MPESA_ENV}\`\n` +
    `• Daraja URL: \`${DARAJA_BASE_URL}\`\n` +
    `• PASSKEY: \`${PASSKEY ? "✅ set (" + PASSKEY.length + " chars)" : "❌ NOT SET"}\`\n` +
    `• CONSUMER_KEY: \`${CONSUMER_KEY ? "✅ set" : "❌ NOT SET"}\`\n` +
    `• CONSUMER_SECRET: \`${CONSUMER_SECRET ? "✅ set" : "❌ NOT SET"}\`\n` +
    `• CALLBACK_URL: \`${CALLBACK_URL || "NOT SET"}\`\n` +
    `• MPESA_INITIATOR_NAME: \`${process.env.MPESA_INITIATOR_NAME || "NOT SET"}\`\n` +
    `• MPESA_INITIATOR_PASS: \`${process.env.MPESA_INITIATOR_PASS ? "✅ set" : "NOT SET (receipt verify → admin fallback)"}\`\n\n` +
    `_Testing token fetch..._`
  );
  try {
    const token = await getMpesaToken();
    await safeSendMessage(chatId,
      `✅ *Daraja token OK!*\n\nToken starts: \`${token.substring(0, 10)}...\`\n\n_API credentials are working correctly._`
    );
  } catch (err) {
    await safeSendMessage(chatId,
      `❌ *Token fetch failed*\n\nError: \`${err.message}\`\n\nActions:\n• Verify CONSUMER_KEY and CONSUMER_SECRET on Daraja portal\n• Confirm your app is *Live* (not sandbox) if using production\n• Set MPESA_ENV=sandbox if testing on sandbox`
    );
  }
});

bot.onText(/\/config$/, (msg) => {
  const chatId = cid(msg.chat.id);
  if (!ADMIN_IDS.includes(chatId)) return safeSendMessage(chatId, "⛔ Not authorized.");
  safeSendMessage(chatId,
    `🔧 *Bot Configuration*\n\n` +
    `• Auto-expire subscriptions: *${autoExpireSubscriptions ? "ON" : "OFF"}*\n` +
    `• Auto-send invite links: *${autoSendInvite ? "ON" : "OFF"}*\n` +
    `• M-Pesa env: *${MPESA_ENV.toUpperCase()}*\n` +
    `• Admin IDs: \`${ADMIN_IDS.join(", ")}\`\n\n` +
    `Commands:\n/autoexpire on|off\n/autoinvite on|off\n/testmpesa\n/testlink`
  );
});

bot.onText(/\/autoexpire (on|off)/, (msg, match) => {
  const chatId = cid(msg.chat.id);
  if (!ADMIN_IDS.includes(chatId)) return safeSendMessage(chatId, "⛔ Not authorized.");
  autoExpireSubscriptions = match[1] === "on";
  safeSendMessage(chatId, `✅ Auto-expire is now *${autoExpireSubscriptions ? "ON" : "OFF"}*`);
});

bot.onText(/\/autoinvite (on|off)/, (msg, match) => {
  const chatId = cid(msg.chat.id);
  if (!ADMIN_IDS.includes(chatId)) return safeSendMessage(chatId, "⛔ Not authorized.");
  autoSendInvite = match[1] === "on";
  safeSendMessage(chatId, `✅ Auto-send invite is now *${autoSendInvite ? "ON" : "OFF"}*`);
});

bot.onText(/\/buy/, (msg) => {
  const chatId = cid(msg.chat.id);
  const sel    = userSelections[chatId];
  if (!sel?.price) return safeSendMessage(chatId, "⚠️ Please select a package and plan first using /start.");
  userSelections[chatId].awaitingPhone = true;
  saveUserSelection(chatId, userSelections[chatId]);
  safeSendMessage(chatId, getPhoneEntryMessage().text, { parse_mode: "Markdown" });
});

// /grant <chatId> [plan]
bot.onText(/\/grant (\d+)(?: (.+))?/, async (msg, match) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return safeSendMessage(cid(msg.chat.id), "⛔ Not authorized.");
  const targetId = cid(match[1]);
  const planArg  = (match[2] || "").trim();
  const sel      = userSelections[targetId] || {};
  const plan     = PLAN_DAYS[planArg] !== undefined ? planArg
                 : PLAN_DAYS[sel.plan] !== undefined ? sel.plan
                 : null;

  if (!plan) {
    return safeSendMessage(cid(msg.chat.id),
      `📋 *Grant access to* \`${targetId}\`\n\nChoose a plan:`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "1 Day",    callback_data: `admin_grant_${targetId}_1 Day` }],
            [{ text: "1 Week",   callback_data: `admin_grant_${targetId}_1 Week` }],
            [{ text: "2 Weeks",  callback_data: `admin_grant_${targetId}_2 Weeks` }],
            [{ text: "1 Month",  callback_data: `admin_grant_${targetId}_1 Month` }],
            [{ text: "6 Months", callback_data: `admin_grant_${targetId}_6 Months` }],
            [{ text: "1 Year",   callback_data: `admin_grant_${targetId}_1 Year` }],
          ],
        },
      }
    );
  }

  try {
    await grantAccess(targetId, plan, `✅ Access manually granted by admin\n📦 Plan: *${plan}*`);
    safeSendMessage(cid(msg.chat.id), getAdminGrantConfirmation(targetId, plan));
  } catch (err) {
    safeSendMessage(cid(msg.chat.id), `❌ Failed: ${err.message}`);
  }
});

bot.onText(/\/send (\d+) ([\S]+)/, (msg, match) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return safeSendMessage(cid(msg.chat.id), "⛔ Not authorized.");
  const targetId   = cid(match[1]);
  const accessLink = match[2];
  const sel        = userSelections[targetId] || {};
  safeSendMessage(targetId,
    `🎉 *Access Granted!*\n\nYour payment has been verified ✅\n\nHere's your exclusive link 👇\n${accessLink}\n\n_Welcome to the family. Do not share this link._ 🔐`
  ).then(() => {
    safeSendMessage(cid(msg.chat.id), `✅ Access link sent to \`${targetId}\``);
    if (sel.plan && autoExpireSubscriptions) {
      const days        = PLAN_DAYS[sel.plan] || 30;
      const durationMs  = days * 86400000;
      const expiresAtMs = Date.now() + durationMs;
      clearSubTimers(targetId);
      const timers = { expiresAt: expiresAtMs };
      if (days > 1) {
        timers.warnTimer = setTimeout(() => {
          safeSendMessage(targetId,
            `⏰ *Heads up!*\n\nYour *${sel.plan}* access expires in *24 hours*. Renew now 😊`,
            { reply_markup: { inline_keyboard: [[{ text: "🔄 Renew", callback_data: "change_package" }]] } }
          ).catch(() => {});
        }, durationMs - warnMs);
      }
      timers.kickTimer = setTimeout(async () => {
        await removeUserFromChannel(targetId, "manual send expiry");
        safeSendMessage(targetId,
          `👋 *Your subscription has ended.*\n\nHope you enjoyed it! 🙏\n\nCome back anytime 😊`,
          { reply_markup: { inline_keyboard: [[{ text: "🔄 Re-subscribe", callback_data: "change_package" }]] } }
        ).catch(() => {});
        delete subTimers[targetId];
        removeSubEntry(targetId);
      }, durationMs);
      subTimers[targetId] = timers;
      saveSubEntry(targetId, sel.plan, expiresAtMs);
    }
  }).catch((err) => safeSendMessage(cid(msg.chat.id), `❌ Failed: ${err.message}`));
});

bot.onText(/\/pending/, (msg) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return safeSendMessage(cid(msg.chat.id), "⛔ Not authorized.");
  const stkEntries     = Object.entries(pendingSTK);
  const receiptEntries = Object.entries(awaitingReceipt).filter(([, r]) => r.code);
  const verifyEntries  = Object.entries(pendingReceiptVerifications);

  if (!stkEntries.length && !receiptEntries.length && !verifyEntries.length) {
    return safeSendMessage(cid(msg.chat.id), "📭 No pending transactions.");
  }

  let message = "";
  if (stkEntries.length) {
    const lines = stkEntries.map(([id, p]) =>
      `• 🔑 \`${id}\`\n  👤 \`${p.chatId}\` | ${p.pkg || "—"} / ${p.plan || "—"} | Ksh ${p.price || "—"}`
    );
    message += `⏳ *Pending STK (${stkEntries.length})*\n\n${lines.join("\n\n")}\n\n_/grant <chatId> if callback missed._\n\n`;
  }
  if (verifyEntries.length) {
    const lines = verifyEntries.map(([code, v]) =>
      `• 🔍 \`${code}\`\n  👤 \`${v.chatId}\` | ${v.pkg || "—"} / ${v.plan || "—"}`
    );
    message += `🔍 *Auto-Verifying Receipts (${verifyEntries.length})*\n\n${lines.join("\n\n")}\n\n`;
  }
  if (receiptEntries.length) {
    const lines = receiptEntries.map(([id, r]) =>
      `• 👤 \`${id}\` | ${r.pkg || "—"} / ${r.plan || "—"} | Ksh ${r.price || "—"}\n  🧾 \`${r.code}\``
    );
    message += `🔔 *Awaiting Manual Verification (${receiptEntries.length})*\n\n${lines.join("\n\n")}`;
  }
  safeSendMessage(cid(msg.chat.id), message.trim());
  receiptEntries.forEach(([id, r]) => {
    safeSendMessage(cid(msg.chat.id), `👤 \`${id}\` — \`${r.code}\` — ${r.plan || "1 Month"}`, {
      reply_markup: {
        inline_keyboard: [[
          { text: `✅ Approve & Grant to ${id}`, callback_data: `admin_grant_${id}_${r.plan || "1 Month"}` },
        ]],
      },
    });
  });
});

bot.onText(/\/users/, (msg) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return safeSendMessage(cid(msg.chat.id), "⛔ Not authorized.");
  const entries = Object.entries(userSelections);
  if (!entries.length) return safeSendMessage(cid(msg.chat.id), "📭 No active sessions.");
  const lines = entries.map(([id, s]) =>
    `• \`${id}\` — ${s.package || "—"} / ${s.plan || "—"} / Ksh ${s.price || "—"}${s.paidAt ? " ✅ PAID" : ""}`
  );
  safeSendMessage(cid(msg.chat.id), `👥 *Active Sessions (${entries.length})*\n\n${lines.join("\n")}`);
});

bot.onText(/\/broadcast (.+)/, (msg, match) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return safeSendMessage(cid(msg.chat.id), "⛔ Not authorized.");
  const targets = Object.keys(userSelections);
  if (!targets.length) return safeSendMessage(cid(msg.chat.id), "📭 No users to broadcast to.");
  targets.forEach((id) => safeSendMessage(id, `📢 *Announcement*\n\n${match[1]}`).catch(() => {}));
  safeSendMessage(cid(msg.chat.id), `📣 Broadcast sent to *${targets.length}* user(s).`);
});

bot.onText(/\/stats/, (msg) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return safeSendMessage(cid(msg.chat.id), "⛔ Not authorized.");
  const all  = Object.values(userSelections);
  const paid = all.filter((s) => s.paidAt).length;
  safeSendMessage(cid(msg.chat.id),
    `📊 *Bot Stats*\n\n👥 Total Sessions: *${all.length}*\n✅ Paid: *${paid}*\n⏳ Pending: *${all.length - paid}*\n` +
    `💵 Awaiting USDT: *${Object.keys(pendingUSDT).length}*\n⏳ Pending STK: *${Object.keys(pendingSTK).length}*\n` +
    `🔍 Verifying Receipts: *${Object.keys(pendingReceiptVerifications).length}*`
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
    `🧾 *Last 5 Transactions*\n${recentLines}`
  );
});

bot.onText(/\/ledger/, (msg) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return safeSendMessage(cid(msg.chat.id), "⛔ Not authorized.");
  if (!paymentLedger.length) return safeSendMessage(cid(msg.chat.id), "📭 No payments yet.");
  const lines = paymentLedger.map((p, i) => {
    const amt = p.currency === "USDT" ? `$${p.amount} USDT` : `Ksh ${p.amount}`;
    return `${i + 1}. *${amt}* | ${p.package || "—"} ${p.plan || ""} | 🆔 \`${p.chatId}\` | 🧾 \`${p.ref}\` | ${p.paidAt}`;
  });
  const chunks = [];
  let chunk    = `📋 *Payment Ledger (${paymentLedger.length} total)*\n\n`;
  for (const line of lines) {
    if ((chunk + line).length > 3800) { chunks.push(chunk); chunk = ""; }
    chunk += line + "\n";
  }
  chunks.push(chunk);
  chunks.forEach((c) => safeSendMessage(cid(msg.chat.id), c).catch(() => {}));
});

bot.onText(/\/kick (\d+)/, async (msg, match) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return safeSendMessage(cid(msg.chat.id), "⛔ Not authorized.");
  const targetId = cid(match[1]);
  try {
    await removeUserFromChannel(targetId, "admin /kick");
    clearSubTimers(targetId);
    safeSendMessage(targetId,
      `👋 *Your access has been removed.*\n\nWe hope you enjoyed your time! 🙏\n\nReady to come back? Tap below 😊`,
      { reply_markup: { inline_keyboard: [[{ text: "🔄 Re-subscribe", callback_data: "change_package" }]] } }
    ).catch(() => {});
    safeSendMessage(cid(msg.chat.id), `✅ User \`${targetId}\` removed.`);
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
  safeSendMessage(cid(msg.chat.id), `🔐 *Active Subscriptions (${entries.length})*\n\n${lines.join("\n")}\n\n_/kick <chatId> to remove_`);
});

bot.onText(/\/reply (\d+) (.+)/, (msg, match) => {
  if (!ADMIN_IDS.includes(cid(msg.chat.id))) return safeSendMessage(cid(msg.chat.id), "⛔ Not authorized.");
  safeSendMessage(cid(match[1]), `💬 *Message from Support*\n\n${match[2]}`)
    .then(() => safeSendMessage(cid(msg.chat.id), `✅ Reply sent to \`${match[1]}\``))
    .catch((err) => safeSendMessage(cid(msg.chat.id), `❌ Failed: ${err.message}`));
});

// ─── INCOMING TEXT MESSAGES ───────────────────────────────────────────────────
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;

  const chatId = cid(msg.chat.id);
  if (isRateLimited(chatId)) {
    return safeSendMessage(chatId, "⏳ *Too many messages!* Please wait a minute.").catch(() => {});
  }

  const text = msg.text.trim();
  const sel  = userSelections[chatId];

  // ── Awaiting phone number for STK push ────────────────────────────────────
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
      `⏳ *Sending payment prompt to ${text}...*\n\nCheck your phone and enter your M-Pesa PIN when prompted. 📲`
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
                [{ text: "❓ I Need Help",                 callback_data: "need_help" }],
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
                [{ text: "🔄 Try STK Again",         callback_data: "pay_stk" }],
                [{ text: "❓ I Need Help",            callback_data: "need_help" }],
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
              [{ text: "🔄 Try STK Again",         callback_data: "pay_stk" }],
              [{ text: "❓ I Need Help",            callback_data: "need_help" }],
            ],
          },
        }
      );
    }
    return;
  }

  // ── Awaiting M-Pesa receipt code ──────────────────────────────────────────
  if (awaitingReceipt[chatId]) {
    const receiptInfo = awaitingReceipt[chatId];
    const code        = text.toUpperCase().replace(/\s/g, "");

    if (!/^[A-Z0-9]{10}$/.test(code)) {
      return safeSendMessage(chatId,
        `⚠️ That doesn't look like a valid M-Pesa code.\n\nM-Pesa codes are *10 characters* long, e.g. \`RCX4B2K9QP\`.\n\nCheck your SMS and try again.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "❓ I Need Help", callback_data: "need_help" }],
              [{ text: "🔄 Try Again",   callback_data: "pay_stk" }],
            ],
          },
        }
      );
    }

    awaitingReceipt[chatId] = { ...receiptInfo, code };
    await autoVerifyReceipt(chatId, code, receiptInfo);
    return;
  }

  // ── Looks like an M-Pesa code typed voluntarily ───────────────────────────
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
      plan:  sel2.plan    || "1 Month",
      pkg:   sel2.package || "N/A",
      price: sel2.price   || 0,
      code,
    };
    awaitingReceipt[chatId] = receiptInfo;
    await autoVerifyReceipt(chatId, code, receiptInfo);
    return;
  }

  // ── Random text ───────────────────────────────────────────────────────────
  if (sel && !sel.paidAt) {
    return safeSendMessage(chatId,
      `😔 *Sorry, I didn't understand that.*\n\n` +
      `If you've already paid, please send your *M-Pesa confirmation code* — a *10-character code* from your payment SMS, e.g. \`RCX4B2K9QP\`.\n\n` +
      `Otherwise, choose an option below 👇`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "📲 Pay via STK Push",     callback_data: "pay_stk" }],
            [{ text: "💳 Pay Manually via Till", callback_data: "show_till" }],
            [{ text: "❓ I Need Help",           callback_data: "need_help" }],
          ],
        },
      }
    );
  }

  if (sel?.paidAt) {
    safeSendMessage(chatId,
      `👋 You're all set! If you need help tap below.`,
      { reply_markup: { inline_keyboard: [[{ text: "❓ I Need Help", callback_data: "need_help" }]] } }
    ).catch(() => {});
  } else {
    safeSendMessage(chatId, `👋 Welcome! Use /start to get started.`).catch(() => {});
  }
});

// ─── CALLBACK QUERIES ─────────────────────────────────────────────────────────
bot.on("callback_query", async (query) => {
  const chatId = cid(query.message.chat.id);
  const data   = query.data;

  bot.answerCallbackQuery(query.id).catch(() => {});
  await sendTyping(chatId, 600);

  if (data === "noop") return;

  // ── Admin one-tap grant ───────────────────────────────────────────────────
  if (data.startsWith("admin_grant_")) {
    if (!ADMIN_IDS.includes(chatId)) return;
    // Format: admin_grant_<chatId>_<planLabel>
    // chatId is digits only, planLabel can have spaces
    const withoutPrefix = data.replace("admin_grant_", "");
    const firstUndIdx   = withoutPrefix.indexOf("_");
    const targetId      = cid(withoutPrefix.substring(0, firstUndIdx));
    const planLabel     = withoutPrefix.substring(firstUndIdx + 1);

    try {
      delete awaitingReceipt[targetId];
      const pendingKey = Object.keys(pendingReceiptVerifications).find(
        (k) => pendingReceiptVerifications[k].chatId === targetId
      );
      if (pendingKey) delete pendingReceiptVerifications[pendingKey];

      await grantAccess(
        targetId,
        planLabel || "1 Month",
        `✅ Access verified and granted by admin\n📦 Plan: *${planLabel || "1 Month"}*`
      );
      safeSendMessage(chatId, getAdminGrantConfirmation(targetId, planLabel));
    } catch (err) {
      safeSendMessage(chatId, `❌ Failed: ${err.message}`);
    }
    return;
  }

  // ── Package selection ─────────────────────────────────────────────────────
  if (data === "package_naughty_premium_leaks") {
    const existingUsername = (userSelections[chatId] || {}).username;
    userSelections[chatId] = { package: "Naughty Premium Leaks", username: existingUsername };
    saveUserSelection(chatId, userSelections[chatId]);
    return safeSendMessage(chatId,
      `🔥 *Great choice!* Naughty Premium Leaks is our most popular package.\n\nPick your plan:`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "1 Day — Ksh 40",                     callback_data: "naughty_1day" }],
            [{ text: "1 Week — Ksh 170",                   callback_data: "naughty_1week" }],
            [{ text: "2 Weeks — Ksh 270",                  callback_data: "naughty_2weeks" }],
            [{ text: "1 Month — Ksh 450",                  callback_data: "naughty_1month" }],
            [{ text: "6 Months — Ksh 2,500 🔥 Best Value", callback_data: "naughty_6months" }],
            [{ text: "1 Year — Ksh 6,200 👑 VIP",          callback_data: "naughty_1year" }],
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
            [{ text: "1 Day — Ksh 50",                     callback_data: "premium_1day" }],
            [{ text: "1 Week — Ksh 220",                   callback_data: "premium_1week" }],
            [{ text: "2 Weeks — Ksh 400",                  callback_data: "premium_2weeks" }],
            [{ text: "1 Month — Ksh 680",                  callback_data: "premium_1month" }],
            [{ text: "6 Months — Ksh 3,500 🔥 Best Value", callback_data: "premium_6months" }],
            [{ text: "1 Year — Ksh 7,000 👑 VIP",          callback_data: "premium_1year" }],
          ],
        },
      }
    );
  }

  if (data === "back_to_package_naughty_premium_leaks") {
    const existingUsername = (userSelections[chatId] || {}).username;
    userSelections[chatId] = { package: "Naughty Premium Leaks", username: existingUsername };
    saveUserSelection(chatId, userSelections[chatId]);
    return safeSendMessage(chatId, `🔥 *Naughty Premium Leaks* — pick your plan:`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "1 Day — Ksh 40",                     callback_data: "naughty_1day" }],
          [{ text: "1 Week — Ksh 170",                   callback_data: "naughty_1week" }],
          [{ text: "2 Weeks — Ksh 270",                  callback_data: "naughty_2weeks" }],
          [{ text: "1 Month — Ksh 450",                  callback_data: "naughty_1month" }],
          [{ text: "6 Months — Ksh 2,500 🔥 Best Value", callback_data: "naughty_6months" }],
          [{ text: "1 Year — Ksh 6,200 👑 VIP",          callback_data: "naughty_1year" }],
        ],
      },
    });
  }

  if (data === "back_to_package_naughty_explicit") {
    const existingUsername = (userSelections[chatId] || {}).username;
    userSelections[chatId] = { package: "Naughty Explicit", username: existingUsername };
    saveUserSelection(chatId, userSelections[chatId]);
    return safeSendMessage(chatId, `💥 *Naughty Explicit* — pick your plan:`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "1 Day — Ksh 50",                     callback_data: "premium_1day" }],
          [{ text: "1 Week — Ksh 220",                   callback_data: "premium_1week" }],
          [{ text: "2 Weeks — Ksh 400",                  callback_data: "premium_2weeks" }],
          [{ text: "1 Month — Ksh 680",                  callback_data: "premium_1month" }],
          [{ text: "6 Months — Ksh 3,500 🔥 Best Value", callback_data: "premium_6months" }],
          [{ text: "1 Year — Ksh 7,000 👑 VIP",          callback_data: "premium_1year" }],
        ],
      },
    });
  }

  if (data === "change_package") {
    return safeSendMessage(chatId, `🔄 *Choose a package:*`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔥 Naughty Premium Leaks",          callback_data: "package_naughty_premium_leaks" }],
          [{ text: "💥 Naughty Explicit (Free Hookups)", callback_data: "package_naughty_explicit" }],
        ],
      },
    });
  }

  // ── Plan selection ────────────────────────────────────────────────────────
  if (PLANS[data]) {
    const plan = PLANS[data];
    const sel  = userSelections[chatId] || {};
    sel.plan   = plan.label;
    sel.price  = plan.price;
    userSelections[chatId] = sel;
    saveUserSelection(chatId, sel);

    const backTarget = data.startsWith("naughty_")
      ? "package_naughty_premium_leaks"
      : "package_naughty_explicit";
    scheduleReminders(chatId);

    const usdtPlan = USDT_PLANS.find((p) => p.label === plan.label);
    const keyboard = [
      [{ text: `📲 Pay via STK Push (Recommended)`, callback_data: "pay_stk" }],
      ...(usdtPlan ? [[{ text: `₿ Pay with Crypto ($${usdtPlan.usdt} USDT)`, callback_data: "pay_usdt" }]] : []),
      [{ text: `💳 Pay Manually via Till`, callback_data: "show_till" }],
      [{ text: `⬅️ Change Plan`, callback_data: `back_to_${backTarget}` }],
    ];

    return safeSendMessage(chatId,
      `✅ *${sel.package}* — *${plan.label}*\n💰 Ksh *${plan.price}*\n\nHow would you like to pay?`,
      { reply_markup: { inline_keyboard: keyboard } }
    );
  }

  if (data === "pay_stk") {
    const sel = userSelections[chatId];
    if (!sel?.price) return safeSendMessage(chatId, "⚠️ Please start over with /start.");
    userSelections[chatId].awaitingPhone = true;
    saveUserSelection(chatId, userSelections[chatId]);
    return safeSendMessage(chatId, getPhoneEntryMessage().text, { parse_mode: "Markdown" });
  }

  if (data === "pay_usdt") {
    const sel = userSelections[chatId];
    if (!sel?.package) return safeSendMessage(chatId, "⚠️ Please start over with /start.");
    const isNaughty = sel.package === "Naughty Premium Leaks";
    const backKey   = isNaughty ? "back_to_package_naughty_premium_leaks" : "back_to_package_naughty_explicit";
    return safeSendMessage(chatId,
      `₿ *Pay with Crypto — Choose Your Plan*\n\nPackage: *${sel.package}*\n\nSelect your plan:`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "1 Day — $5 USDT",       callback_data: "usdt_1day" }],
            [{ text: "1 Week — $19 USDT",      callback_data: "usdt_1week" }],
            [{ text: "1 Month — $35 USDT",     callback_data: "usdt_1month" }],
            [{ text: "6 Months — $90 USDT 🔥", callback_data: "usdt_6months" }],
            [{ text: "1 Year — $250 USDT 👑",  callback_data: "usdt_1year" }],
            [{ text: "⬅️ Back",                 callback_data: backKey }],
          ],
        },
      }
    );
  }

  if (data.startsWith("usdt_")) {
    const chosen = USDT_PLANS.find((p) => p.key === data);
    if (!chosen) return;

    const sel = userSelections[chatId] || {};
    sel.plan  = chosen.label;
    const prefix = sel.package === "Naughty Premium Leaks" ? "naughty_" : "premium_";
    const kesKey = prefix + chosen.label.toLowerCase().replace(/ /g, "");
    sel.price      = PLANS[kesKey]?.price || 0;
    sel.usdtAmount = chosen.usdt;
    userSelections[chatId] = sel;
    saveUserSelection(chatId, sel);
    clearReminders(chatId);

    await safeSendMessage(chatId,
      `₿ *Pay with Crypto (USDT)*\n\n📦 *${sel.package}* — *${chosen.label}*\n💰 Amount: *$${chosen.usdt} USDT*\n\n` +
      `🌍 *Why crypto?*\n• 100% Anonymous\n• Auto-detected — access sent immediately\n• Works from anywhere`
    );

    await safeSendMessage(chatId,
      `📤 *Send Payment*\n\nSend *exactly $${chosen.usdt} USDT* to:\n\n\`${USDT_WALLET}\`\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n🚨 *IMPORTANT* 🚨\n━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `✅ *CORRECT network:* Tron (TRC20) *ONLY*\n❌ *WRONG:* ERC20 / BEP20 / Any other\n\n` +
      `⛔ Wrong network = permanent loss of funds.\n\n` +
      `☑️ Sending *USDT* (not TRX)\n☑️ Network is *TRC20 / Tron*\n` +
      `☑️ Address starts with *T*\n☑️ Amount is *exactly $${chosen.usdt} USDT*\n\n` +
      `⏳ Payment window: *30 minutes*\n\n_We're watching for your transaction. Access sent automatically._ 🔍`
    );

    await startUsdtPoller(chatId, chosen.usdt);
    return;
  }

  if (data === "show_till") {
    const sel = userSelections[chatId];
    if (!sel?.price) return safeSendMessage(chatId, "⚠️ Please start over with /start.");
    const msg = getManualPaymentMessage(sel);
    return safeSendMessage(chatId, msg.text, { reply_markup: msg.reply_markup });
  }

  if (data === "confirm_payment") {
    const sel = userSelections[chatId];
    if (!sel?.price) return safeSendMessage(chatId, "⚠️ Please start over with /start.");

    awaitingReceipt[chatId] = {
      plan:  sel.plan    || "1 Month",
      pkg:   sel.package || "N/A",
      price: sel.price   || 0,
    };

    notifyAdmins(
      `🔔 *Payment Claim*\n\n👤 \`${chatId}\`\n📦 ${sel.package || "N/A"} — ${sel.plan || "N/A"}\n💰 Ksh ${sel.price}\n\n_Waiting for M-Pesa code..._`
    );

    return safeSendMessage(chatId,
      `📋 *Almost done!*\n\n` +
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
            [{ text: "🔄 Try STK Again",  callback_data: "pay_stk" }],
            [{ text: "💳 Manual Till",    callback_data: "show_till" }],
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

// ─── UI HELPER FUNCTIONS ──────────────────────────────────────────────────────
function getPhoneEntryMessage() {
  return {
    text: `📱 *M-Pesa STK Push Payment*\n\nPlease enter your *M-Pesa phone number* to receive a payment prompt.\n\nFormat: *07XXXXXXXX* or *01XXXXXXXX*\n\nExample: \`0712345678\``,
    parse_mode: "Markdown",
  };
}

function getAdminGrantConfirmation(targetId, plan) {
  return `✅ *Access Granted*\n\nUser: \`${targetId}\`\nPlan: *${plan}*\n\nAccess link and timers set up.`;
}

function getManualPaymentMessage(sel) {
  return {
    text: tillCard(sel.package, sel.plan, sel.price) +
      `\n\n✅ *Once you have paid:*\n1. Tap the button below\n2. Send your *M-Pesa Confirmation Code* (e.g. \`RCX4B2K9QP\`)\n3. We'll verify it and send your access! 🔍`,
    reply_markup: { inline_keyboard: [[{ text: "✅ I've Paid — Submit Code", callback_data: "confirm_payment" }]] },
  };
}

function getRenewMessage(planLabel) {
  return {
    text: `⏰ *Heads up!*\n\nYour *${planLabel}* access expires in *24 hours*.\n\nRenew now to stay connected 😊`,
    reply_markup: { inline_keyboard: [[{ text: "🔄 Renew My Access", callback_data: "change_package" }]] },
  };
}

function getExpiryMessage(planLabel) {
  return {
    text: `👋 *Your subscription has ended.*\n\nYour *${planLabel}* plan has expired. We hope you enjoyed your time with us! 🙏\n\nReady to come back anytime — tap below 😊`,
    reply_markup: { inline_keyboard: [[{ text: "🔄 Re-subscribe Now", callback_data: "change_package" }]] },
  };
}

// ─── RESTORE SUBSCRIPTIONS ON STARTUP ────────────────────────────────────────
function restoreSubTimers() {
  const data    = loadSubs();
  const entries = Object.entries(data);
  if (!entries.length) return console.log("📂 No saved subscriptions to restore.");

  let restored = 0, expired = 0;
  const now    = Date.now();

  entries.forEach(([chatId, { planLabel, expiresAt }]) => {
    const msLeft = expiresAt - now;

    if (msLeft <= 0) {
      console.log(`⏰ Sub expired offline: ${chatId} — kicking`);
      removeUserFromChannel(chatId, "offline expiry").catch(() => {});
      const msg = getExpiryMessage(planLabel);
      safeSendMessage(chatId,
        msg.text + `\n\n_Note: Your plan expired while we were briefly offline._`,
        { reply_markup: msg.reply_markup }
      ).catch(() => {});
      removeSubEntry(chatId);
      expired++;
      return;
    }

    const timers = { expiresAt };

    if (msLeft > warnMs) {
      timers.warnTimer = setTimeout(() => {
        const msg = getRenewMessage(planLabel);
        safeSendMessage(chatId, msg.text, { reply_markup: msg.reply_markup }).catch(() => {});
      }, msLeft - warnMs);
    }

    timers.kickTimer = setTimeout(async () => {
      try { await removeUserFromChannel(chatId, "restored timer expiry"); } catch (_) {}
      const msg = getExpiryMessage(planLabel);
      safeSendMessage(chatId, msg.text, { reply_markup: msg.reply_markup }).catch(() => {});
      delete subTimers[chatId];
      removeSubEntry(chatId);
    }, msLeft);

    subTimers[chatId] = timers;
    restored++;
    console.log(`🔁 Restored: ${chatId} | ${planLabel} | ${Math.round(msLeft / 3600000)}h left`);
  });

  console.log(`✅ Subscriptions restored: ${restored} active, ${expired} expired`);
}

// ─── HOUSEKEEPING ─────────────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();

  // Clean expired pending STK entries
  let stkChanged = false;
  for (const key of Object.keys(pendingSTK)) {
    if (pendingSTK[key].expiresAt < now) {
      delete pendingSTK[key];
      stkChanged = true;
    }
  }
  if (stkChanged) savePendingSTK(pendingSTK);

  // Clean expired USDT pollers
  for (const key of Object.keys(pendingUSDT)) {
    if (pendingUSDT[key].expiresAt < now) stopUsdtPoller(key);
  }

  // Clean stale unpaid sessions (no package/price selected)
  for (const key of Object.keys(userSelections)) {
    if (!userSelections[key].paidAt && !userSelections[key].price) {
      delete userSelections[key];
      deleteUserSelection(key);
    }
  }

  console.log("🧹 Housekeeping done.");
}, 30 * 60 * 1000);

// ─── EXPRESS SERVER ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);
  console.log(`📡 Callback: ${CALLBACK_URL || "⚠️ NOT SET"}`);
  console.log(`📡 TransResult: ${CALLBACK_URL ? CALLBACK_URL.replace("/mpesa/callback", "/mpesa/transresult") : "⚠️ NOT SET"}`);
  console.log(`📺 Channel ID: ${CHANNEL_ID}`);
  console.log(`💳 ${MPESA_TYPE.toUpperCase()} | ${MPESA_ENV.toUpperCase()} | ShortCode: ${SHORTCODE} | Till: ${TILL_NUMBER}`);
  console.log(`👤 Admins: ${ADMIN_IDS.join(", ")}`);

  setTimeout(restoreSubTimers, 3000);

  // Keep-alive — only ping if RENDER_URL is different from our own URL
  if (RENDER_URL) {
    console.log(`🏓 Keep-alive → ${RENDER_URL} every 10 min`);
    setInterval(() => {
      axios.get(`${RENDER_URL}/`)
        .then(() => console.log("🏓 Keep-alive OK"))
        .catch((err) => console.warn("🏓 Keep-alive failed:", err.message));
    }, 10 * 60 * 1000);
  }
});