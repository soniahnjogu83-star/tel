// Daraja M-PESA Production Credentials
const darajaConfig = {
    consumerKey: process.env.CONSUMER_KEY,
    consumerSecret: process.env.CONSUMER_SECRET,
    businessShortCode: process.env.SHORTCODE,
    tillNumber: process.env.TILL_NUMBER || '4902476', // fallback if not set
    passkey: process.env.PASSKEY,
    callbackUrl: process.env.CALLBACK_URL || 'https://telegram-payment-bot-tbad.onrender.com/api/mpesa/callback',
    apiEndpoints: {
        mpesaExpress: 'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
        oauthToken: 'https://api.safaricom.co.ke/oauth/v1/generate',
        c2bRegister: 'https://api.safaricom.co.ke/mpesa/c2b/v1/registerurl',
        c2bSimulate: 'https://api.safaricom.co.ke/mpesa/c2b/v1/simulate'
    }
};
