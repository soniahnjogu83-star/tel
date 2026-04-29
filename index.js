require("dotenv").config();

const express = require("express");
const axios = require("axios");
const moment = require("moment");
const fs = require("fs");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");

// ─── APP SETUP ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── HEALTH CHECK & DEBUG ENDPOINTS ──────────────────────────────────────────
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) => res.status(200).json({ status: "alive", timestamp: Date.now() }));

// Debug endpoint to check server configuration
app.get("/mpesa/debug", (req, res) => {
  res.json({
    status: "Server running",
    callbackUrl: process.env.CALLBACK_URL,
    mpesaEnv: process.env.MPESA_ENV || "production",
    shortcode: process.env.SHORTCODE ? "set" : "missing",
    tillNumber: process.env.TILL_NUMBER || "4902476",
    hasConsumerKey: !!process.env.CONSUMER_KEY,
    hasConsumerSecret: !!process.env.CONSUMER_SECRET,
    hasPasskey: !!process.env.PASSKEY,
    endpoints: ["/", "/health", "/mpesa/debug", "/mpesa/callback", "/mpesa/confirm"]
  });
});

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const TILL_NUMBER = process.env.TILL_NUMBER || "4902476";
const TILL_NAME = process.env.TILL_NAME || "ALJAKI Enterprise";
const SHORTCODE = process.env.SHORTCODE;
const PASSKEY = process.env.PASSKEY;
const CONSUMER_KEY = process.env.CONSUMER_KEY;
const CONSUMER_SECRET = process.env.CONSUMER_SECRET;
const CALLBACK_URL = process.env.CALLBACK_URL || "";
const BOT_TOKEN = process.env.BOT_TOKEN;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || null;

// Admin IDs
const ADMIN_IDS = (process.env.ADMIN_IDS || "8132815796")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// M-Pesa configuration
const MPESA_ENV = (process.env.MPESA_ENV || "production").toLowerCase();
const DARAJA_BASE_URL = MPESA_ENV === "sandbox"
  ? "https://sandbox.safaricom.co.ke"
  : "https://api.safaricom.co.ke";

// ─── PLAN CONFIG ─────────────────────────────────────────────────────────────
const PLAN_DAYS = {
  "1 Day": 1,
  "1 Week": 7,
  "2 Weeks": 14,
  "1 Month": 30,
  "6 Months": 180,
  "1 Year": 365,
};

const PLANS = {
  naughty_1day: { label: "1 Day", price: 40 },
  naughty_1week: { label: "1 Week", price: 170 },
  naughty_2weeks: { label: "2 Weeks", price: 270 },
  naughty_1month: { label: "1 Month", price: 450 },
  naughty_6months: { label: "6 Months", price: 2500 },
  naughty_1year: { label: "1 Year", price: 6200 },
  premium_1day: { label: "1 Day", price: 50 },
  premium_1week: { label: "1 Week", price: 220 },
  premium_2weeks: { label: "2 Weeks", price: 400 },
  premium_1month: { label: "1 Month", price: 680 },
  premium_6months: { label: "6 Months", price: 3500 },
  premium_1year: { label: "1 Year", price: 7000 },
};

// ─── STATE ──────────────────────────────────────────────────────────────────
const userSelections = {};
const pendingSTK = {};
const pendingReceipts = {};
const activeSubscriptions = {};

// ─── CHANNEL_ID ──────────────────────────────────────────────────────────────
const CHANNEL_ID = Number(process.env.CHANNEL_ID || "-1001567081082");

// ─── PERSISTENCE ────────────────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, "bot_data.json");

function saveData() {
  try {
    const data = {
      userSelections,
      pendingReceipts,
      activeSubscriptions,
      lastSaved: Date.now()
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Failed to save data:", err);
  }
}

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      Object.assign(userSelections, data.userSelections || {});
      Object.assign(pendingReceipts, data.pendingReceipts || {});
      Object.assign(activeSubscriptions, data.activeSubscriptions || {});
      console.log("✅ Data loaded from disk");
    }
  } catch (err) {
    console.error("Failed to load data:", err);
  }
}

// Load data on startup
loadData();

// Save data every 5 minutes
setInterval(saveData, 5 * 60 * 1000);

// ─── BOT SETUP ────────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log("✅ Bot started in polling mode");

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const cid = (id) => String(id);

async function safeSendMessage(chatId, text, opts = {}) {
  try {
    return await bot.sendMessage(cid(chatId), text, { 
      parse_mode: "Markdown", 
      disable_web_page_preview: true,
      ...opts 
    });
  } catch (err) {
    console.error(`Error sending to ${chatId}:`, err.message);
  }
}

function validatePhone(phone) {
  let cleaned = String(phone).replace(/\D/g, "");
  
  if (cleaned.startsWith("0")) {
    cleaned = "254" + cleaned.substring(1);
  } else if (cleaned.length === 9) {
    cleaned = "254" + cleaned;
  } else if (cleaned.startsWith("254")) {
    // Already correct format
  } else if (cleaned.startsWith("+254")) {
    cleaned = cleaned.substring(1);
  }
  
  if (!/^254[17]\d{8}$/.test(cleaned)) {
    throw new Error("Invalid Safaricom number. Use 07XXXXXXXX or 01XXXXXXXX");
  }
  
  return cleaned;
}

function notifyAdmins(message, buttons = null) {
  ADMIN_IDS.forEach((id) => {
    if (buttons) {
      safeSendMessage(id, message, { reply_markup: buttons });
    } else {
      safeSendMessage(id, message);
    }
  });
}

// ─── M-PESA: GET ACCESS TOKEN ─────────────────────────────────────────────────
async function getMpesaToken() {
  try {
    const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString("base64");
    
    console.log(`🔑 Fetching token from ${DARAJA_BASE_URL}/oauth/v1/generate...`);
    
    const response = await axios.get(
      `${DARAJA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
      {
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );
    
    if (response.data && response.data.access_token) {
      console.log("✅ Token obtained successfully");
      return response.data.access_token;
    } else {
      throw new Error("No access token in response");
    }
  } catch (error) {
    console.error("❌ Token error:", error.response?.data || error.message);
    throw new Error(`Failed to get M-Pesa token: ${error.response?.data?.errorMessage || error.message}`);
  }
}

// ─── M-PESA: STK PUSH ────────────────────────────────────────────────────────
async function stkPush(phone, amount, chatId, plan, packageName) {
  try {
    const token = await getMpesaToken();
    const timestamp = moment().format("YYYYMMDDHHmmss");
    const businessShortCode = SHORTCODE || TILL_NUMBER;
    const password = Buffer.from(`${businessShortCode}${PASSKEY}${timestamp}`).toString("base64");
    
    let formattedPhone = phone;
    if (formattedPhone.startsWith("0")) {
      formattedPhone = "254" + formattedPhone.substring(1);
    } else if (formattedPhone.startsWith("+")) {
      formattedPhone = formattedPhone.substring(1);
    }
    
    console.log(`📲 STK Push Request:`);
    console.log(`   Phone: ${formattedPhone}`);
    console.log(`   Amount: ${amount}`);
    console.log(`   Shortcode: ${businessShortCode}`);
    console.log(`   Till: ${TILL_NUMBER}`);
    
    const payload = {
      BusinessShortCode: businessShortCode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerBuyGoodsOnline",
      Amount: Math.ceil(Number(amount)),
      PartyA: formattedPhone,
      PartyB: TILL_NUMBER,
      PhoneNumber: formattedPhone,
      CallBackURL: CALLBACK_URL,
      AccountReference: "ALJAKI",
      TransactionDesc: `${packageName} - ${plan}`,
    };
    
    const response = await axios.post(
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
    
    console.log("📥 STK Response:", JSON.stringify(response.data, null, 2));
    
    if (response.data.ResponseCode === "0") {
      const checkoutId = response.data.CheckoutRequestID;
      pendingSTK[checkoutId] = {
        chatId: cid(chatId),
        amount: amount,
        phone: formattedPhone,
        plan: plan,
        package: packageName,
        timestamp: Date.now(),
      };
      saveData();
      return { success: true, checkoutId, message: "STK push sent successfully" };
    } else {
      return { success: false, message: response.data.ResponseDescription || "STK push failed" };
    }
  } catch (error) {
    console.error("❌ STK Push error:", error.response?.data || error.message);
    return { 
      success: false, 
      message: error.response?.data?.errorMessage || error.message || "Failed to send STK push" 
    };
  }
}

// ─── GRANT ACCESS ─────────────────────────────────────────────────────────────
async function grantAccess(chatId, planLabel, paymentMessage, receiptCode = null) {
  const days = PLAN_DAYS[planLabel] || 30;
  const chatIdStr = cid(chatId);
  
  try {
    // Check if user already has active access
    if (activeSubscriptions[chatIdStr] && activeSubscriptions[chatIdStr].expiresAt > Date.now()) {
      await safeSendMessage(chatId,
        `✅ *You already have active access!*\n\n` +
        `Expires: ${new Date(activeSubscriptions[chatIdStr].expiresAt).toLocaleDateString()}\n\n` +
        `Enjoy your content! 🔥`
      );
      return true;
    }
    
    // Create invite link
    const expiresAt = Date.now() + (days * 24 * 60 * 60 * 1000);
    const inviteExpiry = Math.floor(expiresAt / 1000);
    
    const invite = await bot.createChatInviteLink(CHANNEL_ID, {
      member_limit: 1,
      expire_date: inviteExpiry,
      name: `Access-${chatId}-${Date.now()}`,
    });
    
    // Send access to user
    await safeSendMessage(chatId,
      `🎉 *ACCESS GRANTED!* 🎉\n\n` +
      `${paymentMessage}\n\n` +
      `👇 *Join the channel here:*\n${invite.invite_link}\n\n` +
      `⚠️ *Important:*\n` +
      `• Link expires in ${days} days\n` +
      `• Single use only\n` +
      `• Do not share this link\n\n` +
      `Welcome to the family! 🔥`
    );
    
    // Store active subscription
    activeSubscriptions[chatIdStr] = {
      plan: planLabel,
      expiresAt: expiresAt,
      grantedAt: Date.now(),
      receiptCode: receiptCode,
    };
    
    // Update user selection
    if (userSelections[chatIdStr]) {
      userSelections[chatIdStr].paidAt = Date.now();
      userSelections[chatIdStr].expiresAt = expiresAt;
    }
    
    saveData();
    console.log(`✅ Access granted to ${chatId} for ${days} days`);
    
    // Notify admins
    notifyAdmins(
      `✅ *ACCESS GRANTED*\n\n` +
      `👤 User: ${chatId}\n` +
      `📅 Plan: ${planLabel} (${days} days)\n` +
      `🧾 Receipt: ${receiptCode || "STK Auto"}\n` +
      `🔗 Link: ${invite.invite_link}`
    );
    
    return true;
  } catch (error) {
    console.error(`❌ Grant access error for ${chatId}:`, error);
    await safeSendMessage(chatId,
      `✅ *Payment Confirmed!*\n\n` +
      `${paymentMessage}\n\n` +
      `⚠️ We're having technical difficulties sending your link.\n` +
      `An admin will send it to you within 5 minutes.\n\n` +
      `Thank you for your patience! 🙏`
    );
    notifyAdmins(
      `🚨 *AUTO-INVITE FAILED*\n\n` +
      `User: ${chatId}\n` +
      `Plan: ${planLabel}\n` +
      `Error: ${error.message}\n\n` +
      `Please grant manually using: /grant ${chatId} "${planLabel}"`
    );
    return false;
  }
}

// ─── M-PESA CALLBACK ENDPOINT ─────────────────────────────────────────────────
app.post("/mpesa/callback", async (req, res) => {
  console.log("📩 M-PESA CALLBACK RECEIVED");
  console.log("Headers:", req.headers);
  console.log("Body:", JSON.stringify(req.body, null, 2));
  
  // Always respond immediately to M-Pesa
  res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  
  try {
    const { Body } = req.body;
    if (!Body || !Body.stkCallback) {
      console.log("No stkCallback in body");
      return;
    }
    
    const callback = Body.stkCallback;
    const checkoutId = callback.CheckoutRequestID;
    const resultCode = callback.ResultCode;
    const resultDesc = callback.ResultDesc;
    
    console.log(`Callback: ${checkoutId} | Result: ${resultCode} | ${resultDesc}`);
    
    // Find pending payment
    const pending = pendingSTK[checkoutId];
    if (!pending) {
      console.log(`No pending payment found for ${checkoutId}`);
      return;
    }
    
    if (resultCode === 0) {
      // Payment successful
      const metadata = callback.CallbackMetadata?.Item || [];
      const getItem = (name) => {
        const item = metadata.find(i => i.Name === name);
        return item ? item.Value : null;
      };
      
      const amount = getItem("Amount");
      const mpesaReceipt = getItem("MpesaReceiptNumber");
      const transactionDate = getItem("TransactionDate");
      const phoneNumber = getItem("PhoneNumber");
      
      console.log(`✅ Payment confirmed! Receipt: ${mpesaReceipt}, Amount: ${amount}`);
      
      // Delete from pending
      delete pendingSTK[checkoutId];
      saveData();
      
      // Grant access
      await grantAccess(
        pending.chatId,
        pending.plan || "1 Month",
        `✅ *Payment Confirmed via STK Push*\n\n` +
        `💰 Amount: Ksh ${amount}\n` +
        `🧾 Receipt: ${mpesaReceipt}\n` +
        `📱 Phone: ${phoneNumber}\n` +
        `📦 Package: ${pending.package || "N/A"}\n` +
        `📅 Plan: ${pending.plan || "1 Month"}`,
        mpesaReceipt
      );
      
      // Notify admins
      notifyAdmins(
        `💰 *STK PAYMENT RECEIVED - AUTO APPROVED*\n\n` +
        `👤 User: ${pending.chatId}\n` +
        `📦 Package: ${pending.package || "N/A"}\n` +
        `📅 Plan: ${pending.plan || "1 Month"}\n` +
        `💰 Amount: Ksh ${amount}\n` +
        `🧾 Receipt: ${mpesaReceipt}\n` +
        `📱 Phone: ${phoneNumber}`
      );
    } else {
      // Payment failed
      console.log(`❌ Payment failed: ${resultDesc}`);
      delete pendingSTK[checkoutId];
      saveData();
      
      await safeSendMessage(pending.chatId,
        `⚠️ *Payment Failed*\n\n` +
        `Reason: ${resultDesc}\n\n` +
        `Please try again or use manual payment.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔄 Try STK Push Again", callback_data: "pay_stk" }],
              [{ text: "💳 Manual Payment", callback_data: "pay_manual" }],
            ],
          },
        }
      );
    }
  } catch (error) {
    console.error("❌ Callback processing error:", error);
    notifyAdmins(`🚨 Callback error: ${error.message}`);
  }
});

// ─── MANUAL RECEIPT CONFIRMATION ENDPOINT ─────────────────────────────────────
app.post("/mpesa/confirm", async (req, res) => {
  res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  
  const { chatId, receiptCode, amount, plan, package: pkg } = req.body;
  console.log(`Manual confirmation request: ${chatId}, ${receiptCode}`);
  
  if (pendingReceipts[receiptCode]) {
    const pending = pendingReceipts[receiptCode];
    await grantAccess(
      pending.chatId,
      pending.plan,
      `✅ *Payment Confirmed Manually*\n\n` +
      `💰 Amount: Ksh ${pending.amount}\n` +
      `🧾 Receipt: ${receiptCode}\n` +
      `📦 Package: ${pending.package}\n` +
      `📅 Plan: ${pending.plan}`,
      receiptCode
    );
    delete pendingReceipts[receiptCode];
    saveData();
  }
});

// ─── VERIFY RECEIPT WITH SAFARICOM ────────────────────────────────────────────
async function verifyReceiptWithSafaricom(receiptCode, phoneNumber) {
  try {
    const token = await getMpesaToken();
    const timestamp = moment().format("YYYYMMDDHHmmss");
    const businessShortCode = SHORTCODE || TILL_NUMBER;
    const password = Buffer.from(`${businessShortCode}${PASSKEY}${timestamp}`).toString("base64");
    
    // Query transaction status
    const response = await axios.post(
      `${DARAJA_BASE_URL}/mpesa/transactionstatus/v1/query`,
      {
        BusinessShortCode: businessShortCode,
        Password: password,
        Timestamp: timestamp,
        TransactionID: receiptCode,
        IdentifierType: "1",
        Remarks: "Receipt Verification",
        Occasion: "Payment Confirmation",
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );
    
    return response.data;
  } catch (error) {
    console.error("Receipt verification error:", error.message);
    return null;
  }
}

// ─── BOT COMMANDS ────────────────────────────────────────────────────────────

// Start command
bot.onText(/\/start/, async (msg) => {
  const chatId = cid(msg.chat.id);
  const username = msg.from.username || msg.from.first_name;
  
  if (!userSelections[chatId]) {
    userSelections[chatId] = {};
  }
  userSelections[chatId].username = username;
  saveData();
  
  await safeSendMessage(chatId,
    `🔥 *WELCOME ${username.toUpperCase()}!* 🔥\n\n` +
    `Welcome to ALJAKI Enterprise - Premium Content Access\n\n` +
    `Choose your package below:`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔥 NAUGHTY PREMIUM LEAKS", callback_data: "pkg_naughty" }],
          [{ text: "💥 NAUGHTY EXPLICIT (Hookups)", callback_data: "pkg_explicit" }],
        ],
      },
    }
  );
});

// Test token command
bot.onText(/\/testtoken/, async (msg) => {
  const chatId = cid(msg.chat.id);
  if (!ADMIN_IDS.includes(chatId)) {
    await safeSendMessage(chatId, "⛔ Admin only command");
    return;
  }
  
  await safeSendMessage(chatId, "🔑 Testing M-Pesa token...");
  
  try {
    const token = await getMpesaToken();
    await safeSendMessage(chatId,
      `✅ *Token successful!*\n\n` +
      `Token starts with: \`${token.substring(0, 20)}...\`\n\n` +
      `Your M-Pesa credentials are working correctly.\n` +
      `Callback URL: ${CALLBACK_URL}\n` +
      `Environment: ${MPESA_ENV.toUpperCase()}`
    );
  } catch (error) {
    await safeSendMessage(chatId,
      `❌ *Token failed*\n\n` +
      `Error: \`${error.message}\`\n\n` +
      `Please check:\n` +
      `• CONSUMER_KEY and CONSUMER_SECRET\n` +
      `• Environment (sandbox vs production)\n` +
      `• API user permissions`
    );
  }
});

// Grant access command (admin only)
bot.onText(/\/grant (\d+)(?: (.+))?/, async (msg, match) => {
  const adminId = cid(msg.chat.id);
  if (!ADMIN_IDS.includes(adminId)) {
    await safeSendMessage(adminId, "⛔ Not authorized.");
    return;
  }
  
  const targetId = match[1];
  const planName = match[2] || "1 Month";
  const receiptCode = `ADMIN_${Date.now()}`;
  
  await grantAccess(targetId, planName, `✅ Access granted by admin\n📅 Plan: ${planName}`, receiptCode);
  await safeSendMessage(adminId, `✅ Access granted to ${targetId} for ${planName}`);
});

// Check subscription status
bot.onText(/\/status/, async (msg) => {
  const chatId = cid(msg.chat.id);
  const sub = activeSubscriptions[chatId];
  
  if (sub && sub.expiresAt > Date.now()) {
    const daysLeft = Math.ceil((sub.expiresAt - Date.now()) / (1000 * 60 * 60 * 24));
    await safeSendMessage(chatId,
      `✅ *Active Subscription*\n\n` +
      `📅 Plan: ${sub.plan}\n` +
      `⏰ Expires: ${new Date(sub.expiresAt).toLocaleDateString()}\n` +
      `📆 Days left: ${daysLeft}\n\n` +
      `Enjoy your access! 🔥`
    );
  } else {
    await safeSendMessage(chatId,
      `❌ *No Active Subscription*\n\n` +
      `Use /start to purchase access.`
    );
  }
});

// Stats command (admin only)
bot.onText(/\/stats/, async (msg) => {
  const adminId = cid(msg.chat.id);
  if (!ADMIN_IDS.includes(adminId)) return;
  
  const totalUsers = Object.keys(userSelections).length;
  const paidUsers = Object.values(userSelections).filter(u => u.paidAt).length;
  const activeUsers = Object.values(activeSubscriptions).filter(s => s.expiresAt > Date.now()).length;
  
  await safeSendMessage(adminId,
    `📊 *BOT STATS*\n\n` +
    `👥 Total Users: ${totalUsers}\n` +
    `✅ Paid Users: ${paidUsers}\n` +
    `🟢 Active Subs: ${activeUsers}\n` +
    `⏳ Pending STK: ${Object.keys(pendingSTK).length}\n` +
    `💳 Pending Manual: ${Object.keys(pendingReceipts).length}\n\n` +
    `📡 Callback URL: ${CALLBACK_URL}\n` +
    `🏦 Till: ${TILL_NUMBER}`
  );
});

// Ping command
bot.onText(/\/ping/, (msg) => {
  safeSendMessage(cid(msg.chat.id), "🏓 Pong! Bot is alive and running.");
});

// Help command
bot.onText(/\/help/, async (msg) => {
  const chatId = cid(msg.chat.id);
  await safeSendMessage(chatId,
    `📖 *Help Guide*\n\n` +
    `*Commands:*\n` +
    `/start - Start the bot and choose package\n` +
    `/status - Check your subscription status\n` +
    `/ping - Check if bot is alive\n` +
    `/help - Show this help message\n\n` +
    `*Payment Methods:*\n` +
    `• STK Push - Automatic payment via M-Pesa prompt\n` +
    `• Manual Payment - Pay via Till and submit receipt code\n\n` +
    `*Need Help?*\n` +
    `Contact support: @ALJAKI_Support`
  );
});

// ─── CALLBACK QUERIES ─────────────────────────────────────────────────────────
bot.on("callback_query", async (query) => {
  const chatId = cid(query.message.chat.id);
  const data = query.data;
  const messageId = query.message.message_id;
  
  await bot.answerCallbackQuery(query.id);
  
  // Package selection
  if (data === "pkg_naughty") {
    userSelections[chatId].package = "Naughty Premium Leaks";
    userSelections[chatId].packageType = "naughty";
    saveData();
    
    await bot.editMessageText(
      `🔥 *Naughty Premium Leaks*\n\nSelect your plan:`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "1 Day - Ksh 40", callback_data: "plan_naughty_1day" }],
            [{ text: "1 Week - Ksh 170", callback_data: "plan_naughty_1week" }],
            [{ text: "2 Weeks - Ksh 270", callback_data: "plan_naughty_2weeks" }],
            [{ text: "1 Month - Ksh 450", callback_data: "plan_naughty_1month" }],
            [{ text: "6 Months - Ksh 2,500 🔥", callback_data: "plan_naughty_6months" }],
            [{ text: "1 Year - Ksh 6,200 👑", callback_data: "plan_naughty_1year" }],
            [{ text: "⬅️ Back", callback_data: "back_to_packages" }],
          ],
        },
      }
    );
    return;
  }
  
  if (data === "pkg_explicit") {
    userSelections[chatId].package = "Naughty Explicit";
    userSelections[chatId].packageType = "premium";
    saveData();
    
    await bot.editMessageText(
      `💥 *Naughty Explicit (Free Hookups)*\n\nSelect your plan:`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "1 Day - Ksh 50", callback_data: "plan_premium_1day" }],
            [{ text: "1 Week - Ksh 220", callback_data: "plan_premium_1week" }],
            [{ text: "2 Weeks - Ksh 400", callback_data: "plan_premium_2weeks" }],
            [{ text: "1 Month - Ksh 680", callback_data: "plan_premium_1month" }],
            [{ text: "6 Months - Ksh 3,500 🔥", callback_data: "plan_premium_6months" }],
            [{ text: "1 Year - Ksh 7,000 👑", callback_data: "plan_premium_1year" }],
            [{ text: "⬅️ Back", callback_data: "back_to_packages" }],
          ],
        },
      }
    );
    return;
  }
  
  if (data === "back_to_packages") {
    await bot.editMessageText(
      `🔥 *Choose Your Package:*`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔥 NAUGHTY PREMIUM LEAKS", callback_data: "pkg_naughty" }],
            [{ text: "💥 NAUGHTY EXPLICIT (Hookups)", callback_data: "pkg_explicit" }],
          ],
        },
      }
    );
    return;
  }
  
  // Plan selection
  if (data.startsWith("plan_")) {
    const parts = data.split("_");
    const type = parts[1]; // naughty or premium
    const duration = parts[2]; // 1day, 1week, etc.
    
    let price = 0;
    let label = "";
    
    const planMap = {
      naughty: { "1day": 40, "1week": 170, "2weeks": 270, "1month": 450, "6months": 2500, "1year": 6200 },
      premium: { "1day": 50, "1week": 220, "2weeks": 400, "1month": 680, "6months": 3500, "1year": 7000 }
    };
    
    const labelMap = {
      "1day": "1 Day", "1week": "1 Week", "2weeks": "2 Weeks",
      "1month": "1 Month", "6months": "6 Months", "1year": "1 Year"
    };
    
    price = planMap[type][duration];
    label = labelMap[duration];
    
    userSelections[chatId].plan = label;
    userSelections[chatId].price = price;
    userSelections[chatId].planKey = data;
    saveData();
    
    await bot.editMessageText(
      `✅ *${userSelections[chatId].package}* - *${label}*\n💰 *Ksh ${price}*\n\nHow would you like to pay?`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📲 STK Push (Auto - Recommended)", callback_data: "pay_stk" }],
            [{ text: "💳 Manual M-Pesa (Till)", callback_data: "pay_manual" }],
            [{ text: "⬅️ Change Plan", callback_data: `back_to_${type}` }],
          ],
        },
      }
    );
    return;
  }
  
  // Back to plan selection
  if (data === "back_to_naughty") {
    await bot.editMessageText(
      `🔥 *Naughty Premium Leaks*\n\nSelect your plan:`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "1 Day - Ksh 40", callback_data: "plan_naughty_1day" }],
            [{ text: "1 Week - Ksh 170", callback_data: "plan_naughty_1week" }],
            [{ text: "2 Weeks - Ksh 270", callback_data: "plan_naughty_2weeks" }],
            [{ text: "1 Month - Ksh 450", callback_data: "plan_naughty_1month" }],
            [{ text: "6 Months - Ksh 2,500 🔥", callback_data: "plan_naughty_6months" }],
            [{ text: "1 Year - Ksh 6,200 👑", callback_data: "plan_naughty_1year" }],
            [{ text: "⬅️ Back to Packages", callback_data: "back_to_packages" }],
          ],
        },
      }
    );
    return;
  }
  
  if (data === "back_to_premium") {
    await bot.editMessageText(
      `💥 *Naughty Explicit (Free Hookups)*\n\nSelect your plan:`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "1 Day - Ksh 50", callback_data: "plan_premium_1day" }],
            [{ text: "1 Week - Ksh 220", callback_data: "plan_premium_1week" }],
            [{ text: "2 Weeks - Ksh 400", callback_data: "plan_premium_2weeks" }],
            [{ text: "1 Month - Ksh 680", callback_data: "plan_premium_1month" }],
            [{ text: "6 Months - Ksh 3,500 🔥", callback_data: "plan_premium_6months" }],
            [{ text: "1 Year - Ksh 7,000 👑", callback_data: "plan_premium_1year" }],
            [{ text: "⬅️ Back to Packages", callback_data: "back_to_packages" }],
          ],
        },
      }
    );
    return;
  }
  
  // STK Push payment
  if (data === "pay_stk") {
    const userData = userSelections[chatId];
    if (!userData || !userData.price) {
      await safeSendMessage(chatId, "⚠️ Please select a package and plan first using /start");
      return;
    }
    
    userSelections[chatId].awaitingPhone = true;
    saveData();
    
    await safeSendMessage(chatId,
      `📱 *STK Push Payment*\n\n` +
      `Package: *${userData.package}*\n` +
      `Plan: *${userData.plan}*\n` +
      `Amount: *Ksh ${userData.price}*\n\n` +
      `Please enter your M-Pesa phone number:\n\n` +
      `Example: *0712345678* or *0112345678*\n\n` +
      `You will receive a prompt on your phone to enter your PIN.`
    );
    return;
  }
  
  // Manual payment
  if (data === "pay_manual") {
    const userData = userSelections[chatId];
    if (!userData || !userData.price) {
      await safeSendMessage(chatId, "⚠️ Please select a package and plan first using /start");
      return;
    }
    
    await safeSendMessage(chatId,
      `💳 *Manual M-Pesa Payment*\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🏦 *TILL NUMBER:* ${TILL_NUMBER}\n` +
      `🏪 *BUSINESS NAME:* ${TILL_NAME}\n` +
      `📦 *PACKAGE:* ${userData.package}\n` +
      `📅 *PLAN:* ${userData.plan}\n` +
      `💰 *AMOUNT:* Ksh ${userData.price}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `*STEPS:*\n` +
      `1. Go to M-Pesa → Lipa Na M-Pesa → Buy Goods\n` +
      `2. Enter Till Number: *${TILL_NUMBER}*\n` +
      `3. Enter Amount: *${userData.price}*\n` +
      `4. Complete payment\n` +
      `5. Send your M-Pesa confirmation code here\n\n` +
      `After payment, tap "I've Paid" below 👇`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ I'VE PAID - SUBMIT CODE", callback_data: "submit_receipt" }],
            [{ text: "⬅️ Back", callback_data: `back_to_${userData.packageType}` }],
          ],
        },
      }
    );
    return;
  }
  
  // Submit receipt code
  if (data === "submit_receipt") {
    userSelections[chatId].awaitingReceipt = true;
    saveData();
    
    await safeSendMessage(chatId,
      `📝 *Enter Your M-Pesa Confirmation Code*\n\n` +
      `Please type the *10-character code* from your M-Pesa SMS.\n\n` +
      `Example: \`RCX4B2K9QP\`\n\n` +
      `We will verify it and grant access immediately. 🔍`
    );
    return;
  }
  
  // Restart
  if (data === "restart") {
    await bot.editMessageText(
      `🔥 *Welcome Back!*\n\nChoose your package below:`,
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔥 NAUGHTY PREMIUM LEAKS", callback_data: "pkg_naughty" }],
            [{ text: "💥 NAUGHTY EXPLICIT (Hookups)", callback_data: "pkg_explicit" }],
          ],
        },
      }
    );
    return;
  }
});

// ─── TEXT MESSAGE HANDLER ─────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  
  const chatId = cid(msg.chat.id);
  const text = msg.text.trim();
  const userData = userSelections[chatId];
  
  if (!userData) {
    await safeSendMessage(chatId, "Please use /start to begin.");
    return;
  }
  
  // Handle phone number for STK push
  if (userData.awaitingPhone) {
    userData.awaitingPhone = false;
    
    let phone;
    try {
      phone = validatePhone(text);
    } catch (error) {
      await safeSendMessage(chatId, `❌ ${error.message}\n\nPlease try again with a valid Safaricom number.`);
      userData.awaitingPhone = true;
      saveData();
      return;
    }
    
    await safeSendMessage(chatId, `⏳ Sending payment prompt to ${phone}...`);
    
    const result = await stkPush(phone, userData.price, chatId, userData.plan, userData.package);
    
    if (result.success) {
      await safeSendMessage(chatId,
        `✅ *Payment prompt sent!* 📲\n\n` +
        `Check your phone and enter your M-Pesa PIN.\n\n` +
        `The payment will be confirmed automatically within 30 seconds.\n\n` +
        `You will receive your access link immediately after confirmation. 🔐`
      );
    } else {
      await safeSendMessage(chatId,
        `❌ *Failed to send payment prompt*\n\n` +
        `Error: ${result.message}\n\n` +
        `Possible issues:\n` +
        `• Phone number not registered on M-Pesa\n` +
        `• Network connectivity issues\n` +
        `• M-Pesa service temporarily unavailable\n\n` +
        `Please use manual payment instead.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "💳 Manual Payment", callback_data: "pay_manual" }],
              [{ text: "🔄 Try Again", callback_data: "pay_stk" }],
            ],
          },
        }
      );
    }
    saveData();
    return;
  }
  
  // Handle receipt code submission
  if (userData.awaitingReceipt) {
    userData.awaitingReceipt = false;
    
    const receiptCode = text.toUpperCase().replace(/\s/g, "");
    
    if (!/^[A-Z0-9]{10,12}$/.test(receiptCode)) {
      await safeSendMessage(chatId,
        `❌ *Invalid M-Pesa code*\n\n` +
        `Code should be 10-12 characters, e.g., \`RCX4B2K9QP\`\n\n` +
        `Please check your SMS and try again.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "📝 Try Again", callback_data: "submit_receipt" }],
              [{ text: "💳 Pay via STK", callback_data: "pay_stk" }],
            ],
          },
        }
      );
      userData.awaitingReceipt = true;
      saveData();
      return;
    }
    
    // Store pending receipt for admin verification
    pendingReceipts[receiptCode] = {
      chatId: chatId,
      amount: userData.price,
      plan: userData.plan,
      package: userData.package,
      timestamp: Date.now(),
    };
    saveData();
    
    await safeSendMessage(chatId,
      `✅ *Receipt received!* 🔍\n\n` +
      `Code: \`${receiptCode}\`\n` +
      `Amount: Ksh ${userData.price}\n\n` +
      `Our team is verifying your payment...\n\n` +
      `You will receive access within 2-5 minutes. 🙏`
    );
    
    // Notify admins for verification
    notifyAdmins(
      `🔔 *MANUAL PAYMENT AWAITING VERIFICATION*\n\n` +
      `👤 User: ${chatId}\n` +
      `📦 Package: ${userData.package}\n` +
      `📅 Plan: ${userData.plan}\n` +
      `💰 Amount: Ksh ${userData.price}\n` +
      `🧾 Code: ${receiptCode}\n\n` +
      `To grant access: /grant ${chatId} "${userData.plan || "1 Month"}"\n` +
      `Or reply: /confirm ${receiptCode}`,
      {
        inline_keyboard: [[
          { text: `✅ Grant Access to ${chatId}`, callback_data: `admin_grant_${chatId}_${userData.plan || "1 Month"}` }
        ]]
      }
    );
    
    return;
  }
  
  // Default response
  await safeSendMessage(chatId,
    `❓ I didn't understand that.\n\n` +
    `Please use the buttons below or type /start to begin again.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔄 Start Over", callback_data: "restart" }],
          [{ text: "📖 Help", callback_data: "help" }],
        ],
      },
    }
  );
});

// ─── START SERVER ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 =========================================`);
  console.log(`🚀 SERVER RUNNING ON PORT ${PORT}`);
  console.log(`🚀 =========================================`);
  console.log(`📡 Callback URL: ${CALLBACK_URL || "⚠️ NOT SET - STK PUSH WILL FAIL"}`);
  console.log(`🏦 Till Number: ${TILL_NUMBER}`);
  console.log(`🏪 Business Name: ${TILL_NAME}`);
  console.log(`📺 Channel ID: ${CHANNEL_ID}`);
  console.log(`👥 Admins: ${ADMIN_IDS.join(", ")}`);
  console.log(`🔧 M-Pesa Env: ${MPESA_ENV.toUpperCase()}`);
  console.log(`🌐 Daraja URL: ${DARAJA_BASE_URL}`);
  console.log(`=========================================\n`);
  
  // Send startup notification to admins
  setTimeout(() => {
    notifyAdmins(
      `🤖 *BOT STARTED SUCCESSFULLY*\n\n` +
      `📡 Callback URL: ${CALLBACK_URL || "⚠️ NOT SET"}\n` +
      `🏦 Till: ${TILL_NUMBER}\n` +
      `🔧 Mode: ${MPESA_ENV.toUpperCase()}\n\n` +
      `Test token: /testtoken\n` +
      `Check stats: /stats`
    );
  }, 3000);
});

// Keep-alive for Render
if (RENDER_URL) {
  setInterval(() => {
    axios.get(RENDER_URL).catch(() => {});
  }, 10 * 60 * 1000);
}

// Handle graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, saving data...");
  saveData();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("SIGINT received, saving data...");
  saveData();
  process.exit(0);
});