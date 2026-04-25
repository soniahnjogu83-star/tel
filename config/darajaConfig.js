// Daraja M-PESA Production Credentials
const darajaConfig = {
    consumerKey: 'sGQ4Hjt5Xq95g0bSaArWPkYA3cyUVwGGH0Ls1w38uKGqzdhX',
    consumerSecret: 'eFrvipkVOk5MnAS4W6YKMzGP66QeTQoveKAGc3qGLMTJ3sgW18gMhbY0FyT9iGag',
    businessShortCode: '4902476', // Updated to match TILL_NUMBER
    tillNumber: '4902476',
    passkey: 'b7cf578c0c3badd8648ac1858b47e87491cbd4e5d8d4d9ce119ea664a975fd9c',
    callbackUrl: 'https://telegram-payment-bot-tbad.onrender.com/api/mpesa/callback',
    apiEndpoints: {
        mpesaExpress: 'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
        oauthToken: 'https://api.safaricom.co.ke/oauth/v1/generate',
        c2bRegister: 'https://api.safaricom.co.ke/mpesa/c2b/v1/registerurl',
        c2bSimulate: 'https://api.safaricom.co.ke/mpesa/c2b/v1/simulate'
    }
};

module.exports = darajaConfig;