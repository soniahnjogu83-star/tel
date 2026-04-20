// Daraja M-PESA Production Credentials
const darajaConfig = {
    consumerKey: process.env.CONSUMER_KEY,
    consumerSecret: process.env.CONSUMER_SECRET,
    businessShortCode: process.env.SHORTCODE,
    tillNumber: process.env.TILL_NUMBER || '4902476', // fallback if not set
    passkey: process.env.PASSKEY,
    apiEndpoints: {
        mpesaExpress: 'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
    }
};

module.exports = darajaConfig;