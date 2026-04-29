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

app.get("/mpesa/debug", (req, res) => {
  res.json({
    status: "Server running",
    callbackUrl: process.env.CALLBACK_URL,
    mpesaEnv: process.env.MPESA_ENV || "production",
    shortcode: process.env.SHORTCODE ? "set" : "missing",
    tillNumber: process.env.TILL_NUMBER,
    businessName: process.env.TILL_NAME,
    hasConsumerKey: !!process.env.CONSUMER_KEY,
    hasConsumerSecret: !!process.env.CONSUMER_SECRET,
    hasPasskey: !!process.env.PASSKEY,
    mpesaType: process.env.MPESA_TYPE || "till",
    endpoints: ["/", "/health", "/mpesa/debug", "/mpesa/callback"]
  });
});

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// IMPORTANT: For Buy Goods (Till) - use your VALID Till Number (e.g., 4902476)
// For Paybill - use your Paybill number and set MPESA_TYPE=paybill
const TILL_NUMBER = process.env.TILL_NUMBER || "4902476"; // CHANGE THIS to your valid Till number
const TILL_NAME = process.env.TILL_NAME || "ALJAKI Enterprise";
const SHORTCODE = process.env.SHORTCODE || TILL_NUMBER; // For Paybill, this is your Paybill number
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
const MPESA_TYPE = (process.env.MPESA_TYPE || "till").toLowerCase(); // "till" or "paybill"
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
    const data = { userSelections, pendingReceipts, activeSubscriptions, lastSaved: Date.now() };
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

loadData();
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
    
    console.log(`🔑 Fetching token from ${DARAJA_BASE_URL}...`);
    
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
    
    // Determine business shortcode and party B based on transaction type
    let businessShortCode, partyB, transactionType;
    
    if (MPESA_TYPE === "paybill") {
      // Paybill mode
      businessShortCode = SHORTCODE; // Your Paybill number
      partyB = SHORTCODE; // For Paybill, PartyB is also the Paybill number
      transactionType = "CustomerPayBillOnline";
      console.log(`📲 Using Paybill mode - Business: ${businessShortCode}`);
    } else {
      // Till mode (Buy Goods)
      businessShortCode = TILL_NUMBER; // Your Till number
      partyB = TILL_NUMBER; // For Till, PartyB is the Till number
      transactionType = "CustomerBuyGoodsOnline";
      console.log(`📲 Using Till mode - Till: ${businessShortCode}`);
    }
    
    const password = Buffer.from(`${businessShortCode}${PASSKEY}${timestamp}`).toString("base64");
    
    let formattedPhone = phone;
    if (formattedPhone.startsWith("0")) {
      formattedPhone = "254" + formattedPhone.substring(1);
    } else if (formattedPhone.startsWith("+")) {
      formattedPhone = formattedPhone.substring(1);
    }
    
    console.log(`📲 STK Push Request:`);
    console.log(`   Type: ${MPESA_TYPE.toUpperCase()}`);
    console.log(`   Phone: ${formattedPhone}`);
    console.log(`   Amount: ${amount}`);
    console.log(`   BusinessShortCode: ${businessShortCode}`);
    console.log(`   PartyB: ${partyB}`);
    console.log(`   TransactionType: ${transactionType}`);
    
    const payload = {
      BusinessShortCode: businessShortCode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: transactionType,
      Amount: Math.ceil(Number(amount)),
      PartyA: formattedPhone,
      PartyB: partyB,
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
    if (activeSubscriptions[chatIdStr] && activeSubscriptions[chatIdStr].expiresAt > Date.now()) {
      await safeSendMessage(chatId,
        `✅ *You already have active access!*\n\n` +
        `Expires: ${new Date(activeSubscriptions[chatIdStr].expiresAt).toLocaleDateString()}`
      );
      return true;
    }
    
    const expiresAt = Date.now() + (days * 24 * 60 * 60 * 1000);
    const inviteExpiry = Math.floor(expiresAt / 1000);
    
    const invite = await bot.createChatInviteLink(CHANNEL_ID, {
      member_limit: 1,
      expire_date: inviteExpiry,
      name: `Access-${chatId}-${Date.now()}`,
    });
    
    await safeSendMessage(chatId,
      `🎉 *ACCESS GRANTED!* 🎉\n\n` +
      `${paymentMessage}\n\n` +
      `👇 *Join the channel here:*\n${invite.invite_link}\n\n` +
      `⚠️ *Important:*\n• Link expires in ${days} days\n• Single use only\n\n` +
      `Welcome to the family! 🔥`
    );
    
    activeSubscriptions[chatIdStr] = {
      plan: planLabel,
      expiresAt: expiresAt,
      grantedAt: Date.now(),
      receiptCode: receiptCode,
    };
    
    if (userSelections[chatIdStr]) {
      userSelections[chatIdStr].paidAt = Date.now();
      userSelections[chatIdStr].expiresAt = expiresAt;
    }
    
    saveData();
    console.log(`✅ Access granted to ${chatId} for ${days} days`);
    
    notifyAdmins(`✅ *ACCESS GRANTED*\n👤 User: ${chatId}\n📅 Plan: ${planLabel}`);
    
    return true;
  } catch (error) {
    console.error(`❌ Grant access error:`, error);
    await safeSendMessage(chatId,
      `✅ *Payment Confirmed!*\n\n${paymentMessage}\n\n` +
      `⚠️ An admin will send your link within 5 minutes.`
    );
    notifyAdmins(`🚨 Auto-invite failed for ${chatId}\nError: ${error.message}`);
    return false;
  }
}

// ─── M-PESA CALLBACK ENDPOINT ─────────────────────────────────────────────────
app.post("/mpesa/callback", async (req, res) => {
  console.log("📩 M-PESA CALLBACK RECEIVED");
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
    
    const pending = pendingSTK[checkoutId];
    if (!pending) {
      console.log(`No pending payment found for ${checkoutId}`);
      return;
    }
    
    if (resultCode === 0) {
      const metadata = callback.CallbackMetadata?.Item || [];
      const getItem = (name) => {
        const item = metadata.find(i => i.Name === name);
        return item ? item.Value : null;
      };
      
      const amount = getItem("Amount");
      const mpesaReceipt = getItem("MpesaReceiptNumber");
      const phoneNumber = getItem("PhoneNumber");
      
      console.log(`✅ Payment confirmed! Receipt: ${mpesaReceipt}`);
      
      delete pendingSTK[checkoutId];
      saveData();
      
      await grantAccess(
        pending.chatId,
        pending.plan || "1 Month",
        `✅ *Payment Confirmed*\n💰 Amount: Ksh ${amount}\n🧾 Receipt: ${mpesaReceipt}`,
        mpesaReceipt
      );
      
      notifyAdmins(`💰 *PAYMENT RECEIVED*\n👤 ${pending.chatId}\n💰 Ksh ${amount}\n🧾 ${mpesaReceipt}`);
    } else {
      console.log(`❌ Payment failed: ${resultDesc}`);
      delete pendingSTK[checkoutId];
      saveData();
      
      let userMessage = `⚠️ *Payment Failed*\n\nReason: ${resultDesc}\n\n`;
      
      if (resultDesc.includes("Agent number") || resultDesc.includes("Store number")) {
        userMessage += `This means your Till/Paybill number is not configured correctly.\n\n` +
          `Please use manual payment instead or contact support.`;
      } else {
        userMessage += `Please try again or use manual payment.`;
      }
      
      await safeSendMessage(pending.chatId, userMessage, {
        reply_markup: {
          inline_keyboard: [
            [{ text: "💳 Manual Payment", callback_data: "pay_manual" }],
            [{ text: "🔄 Try Again", callback_data: "pay_stk" }],
          ],
        },
      });
    }
  } catch (error) {
    console.error("❌ Callback error:", error);
  }
});

// ─── BOT COMMANDS ────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId = cid(msg.chat.id);
  const username = msg.from.username || msg.from.first_name;
  
  if (!userSelections[chatId]) userSelections[chatId] = {};
  userSelections[chatId].username = username;
  saveData();
  
  await safeSendMessage(chatId,
    `🔥 *WELCOME ${username.toUpperCase()}!* 🔥\n\nChoose your package:`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔥 NAUGHTY PREMIUM LEAKS", callback_data: "pkg_naughty" }],
          [{ text: "💥 NAUGHTY EXPLICIT", callback_data: "pkg_explicit" }],
        ],
      },
    }
  );
});

bot.onText(/\/testtoken/, async (msg) => {
  const chatId = cid(msg.chat.id);
  if (!ADMIN_IDS.includes(chatId)) return;
  
  await safeSendMessage(chatId, "🔑 Testing M-Pesa token...");
  
  try {
    const token = await getMpesaToken();
    await safeSendMessage(chatId,
      `✅ *Token successful!*\n\n` +
      `Token starts: \`${token.substring(0, 20)}...\`\n` +
      `Callback URL: ${CALLBACK_URL}\n` +
      `Mode: ${MPESA_TYPE.toUpperCase()}\n` +
      `Till/Shortcode: ${MPESA_TYPE === "till" ? TILL_NUMBER : SHORTCODE}`
    );
  } catch (error) {
    await safeSendMessage(chatId, `❌ Token failed: ${error.message}`);
  }
});

bot.onText(/\/grant (\d+)(?: (.+))?/, async (msg, match) => {
  const adminId = cid(msg.chat.id);
  if (!ADMIN_IDS.includes(adminId)) return;
  
  const targetId = match[1];
  const planName = match[2] || "1 Month";
  
  await grantAccess(targetId, planName, `✅ Access granted by admin`, `ADMIN_${Date.now()}`);
  await safeSendMessage(adminId, `✅ Access granted to ${targetId} for ${planName}`);
});

bot.onText(/\/stats/, async (msg) => {
  const adminId = cid(msg.chat.id);
  if (!ADMIN_IDS.includes(adminId)) return;
  
  const totalUsers = Object.keys(userSelections).length;
  const paidUsers = Object.values(userSelections).filter(u => u.paidAt).length;
  const activeUsers = Object.values(activeSubscriptions).filter(s => s.expiresAt > Date.now()).length;
  
  await safeSendMessage(adminId,
    `📊 *STATS*\n👥 Users: ${totalUsers}\n✅ Paid: ${paidUsers}\n🟢 Active: ${activeUsers}\n⏳ Pending STK: ${Object.keys(pendingSTK).length}`
  );
});

bot.onText(/\/ping/, (msg) => {
  safeSendMessage(cid(msg.chat.id), "🏓 Pong!");
});

// ─── CALLBACK QUERIES ─────────────────────────────────────────────────────────
bot.on("callback_query", async (query) => {
  const chatId = cid(query.message.chat.id);
  const data = query.data;
  const messageId = query.message.message_id;
  
  await bot.answerCallbackQuery(query.id);
  
  // Package selection handlers (simplified for brevity - same structure as before)
  if (data === "pkg_naughty") {
    userSelections[chatId].package = "Naughty Premium Leaks";
    userSelections[chatId].packageType = "naughty";
    saveData();
    
    await bot.editMessageText(`🔥 *Naughty Premium Leaks*\n\nSelect your plan:`, {
      chat_id: chatId, message_id: messageId, parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "1 Day - Ksh 40", callback_data: "plan_naughty_1day" }],
          [{ text: "1 Week - Ksh 170", callback_data: "plan_naughty_1week" }],
          [{ text: "1 Month - Ksh 450", callback_data: "plan_naughty_1month" }],
          [{ text: "6 Months - Ksh 2,500 🔥", callback_data: "plan_naughty_6months" }],
          [{ text: "⬅️ Back", callback_data: "back_to_packages" }],
        ],
      },
    });
    return;
  }
  
  if (data === "pkg_explicit") {
    userSelections[chatId].package = "Naughty Explicit";
    userSelections[chatId].packageType = "premium";
    saveData();
    
    await bot.editMessageText(`💥 *Naughty Explicit*\n\nSelect your plan:`, {
      chat_id: chatId, message_id: messageId, parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "1 Day - Ksh 50", callback_data: "plan_premium_1day" }],
          [{ text: "1 Week - Ksh 220", callback_data: "plan_premium_1week" }],
          [{ text: "1 Month - Ksh 680", callback_data: "plan_premium_1month" }],
          [{ text: "6 Months - Ksh 3,500 🔥", callback_data: "plan_premium_6months" }],
          [{ text: "⬅️ Back", callback_data: "back_to_packages" }],
        ],
      },
    });
    return;
  }
  
  if (data === "back_to_packages") {
    await bot.editMessageText(`🔥 *Choose Your Package:*`, {
      chat_id: chatId, message_id: messageId, parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔥 NAUGHTY PREMIUM LEAKS", callback_data: "pkg_naughty" }],
          [{ text: "💥 NAUGHTY EXPLICIT", callback_data: "pkg_explicit" }],
        ],
      },
    });
    return;
  }
  
  // Plan selection
  if (data.startsWith("plan_")) {
    const parts = data.split("_");
    const type = parts[1];
    const duration = parts[2];
    
    const prices = { naughty: { "1day": 40, "1week": 170, "1month": 450, "6months": 2500 },
                     premium: { "1day": 50, "1week": 220, "1month": 680, "6months": 3500 } };
    const labels = { "1day": "1 Day", "1week": "1 Week", "1month": "1 Month", "6months": "6 Months" };
    
    const price = prices[type][duration];
    const label = labels[duration];
    
    userSelections[chatId].plan = label;
    userSelections[chatId].price = price;
    saveData();
    
    await bot.editMessageText(`✅ *${userSelections[chatId].package}* - *${label}*\n💰 *Ksh ${price}*\n\nHow would you like to pay?`, {
      chat_id: chatId, message_id: messageId, parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📲 STK Push (Auto)", callback_data: "pay_stk" }],
          [{ text: "💳 Manual Payment", callback_data: "pay_manual" }],
        ],
      },
    });
    return;
  }
  
  // Payment handlers
  if (data === "pay_stk") {
    const userData = userSelections[chatId];
    if (!userData?.price) {
      await safeSendMessage(chatId, "⚠️ Please select a package first");
      return;
    }
    
    userSelections[chatId].awaitingPhone = true;
    saveData();
    
    await safeSendMessage(chatId,
      `📱 *STK Push Payment*\n\n` +
      `Package: ${userData.package}\n` +
      `Plan: ${userData.plan}\n` +
      `Amount: Ksh ${userData.price}\n\n` +
      `Enter your M-Pesa phone number (e.g., 0712345678):`
    );
    return;
  }
  
  if (data === "pay_manual") {
    const userData = userSelections[chatId];
    await safeSendMessage(chatId,
      `💳 *Manual Payment*\n\n` +
      `🏦 *TILL NUMBER:* ${TILL_NUMBER}\n` +
      `🏪 *BUSINESS:* ${TILL_NAME}\n` +
      `💰 *AMOUNT:* Ksh ${userData.price}\n\n` +
      `After payment, send your M-Pesa confirmation code here.`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: "✅ I'VE PAID", callback_data: "submit_receipt" }]],
        },
      }
    );
    return;
  }
  
  if (data === "submit_receipt") {
    userSelections[chatId].awaitingReceipt = true;
    saveData();
    await safeSendMessage(chatId, `📝 *Enter your M-Pesa confirmation code* (e.g., RCX4B2K9QP):`);
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
      await safeSendMessage(chatId, `❌ ${error.message}\n\nPlease try again.`);
      userData.awaitingPhone = true;
      saveData();
      return;
    }
    
    await safeSendMessage(chatId, `⏳ Sending payment prompt...`);
    
    const result = await stkPush(phone, userData.price, chatId, userData.plan, userData.package);
    
    if (result.success) {
      await safeSendMessage(chatId,
        `✅ *Payment prompt sent!*\n\n` +
        `Check your phone and enter your M-Pesa PIN.\n` +
        `Access will be granted automatically upon confirmation.`
      );
    } else {
      await safeSendMessage(chatId,
        `❌ *Failed: ${result.message}*\n\nPlease use manual payment.`,
        {
          reply_markup: {
            inline_keyboard: [[{ text: "💳 Manual Payment", callback_data: "pay_manual" }]],
          },
        }
      );
    }
    saveData();
    return;
  }
  
  // Handle receipt code
  if (userData.awaitingReceipt) {
    userData.awaitingReceipt = false;
    const receiptCode = text.toUpperCase().replace(/\s/g, "");
    
    if (!/^[A-Z0-9]{10,12}$/.test(receiptCode)) {
      await safeSendMessage(chatId, `❌ Invalid code. Please enter the 10-character code from your SMS.`);
      userData.awaitingReceipt = true;
      saveData();
      return;
    }
    
    pendingReceipts[receiptCode] = {
      chatId: chatId,
      amount: userData.price,
      plan: userData.plan,
      package: userData.package,
      timestamp: Date.now(),
    };
    saveData();
    
    await safeSendMessage(chatId,
      `✅ *Receipt received!*\n\n` +
      `Code: ${receiptCode}\n` +
      `Amount: Ksh ${userData.price}\n\n` +
      `Admin will verify and grant access shortly.`
    );
    
    notifyAdmins(
      `🔔 *MANUAL PAYMENT*\n👤 ${chatId}\n📦 ${userData.package}\n💰 Ksh ${userData.price}\n🧾 ${receiptCode}\n\n/grant ${chatId} "${userData.plan}"`
    );
    return;
  }
});

// ─── START SERVER ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Server on port ${PORT}`);
  console.log(`📡 Callback: ${CALLBACK_URL}`);
  console.log(`🏦 Till: ${TILL_NUMBER}`);
  console.log(`💳 Mode: ${MPESA_TYPE.toUpperCase()}`);
  console.log(`=========================================\n`);
});

if (RENDER_URL) {
  setInterval(() => axios.get(RENDER_URL).catch(() => {}), 10 * 60 * 1000);
}