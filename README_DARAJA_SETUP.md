# Daraja M-PESA Integration Setup

This document provides complete instructions on how to set up the Daraja M-PESA integration for your project. Follow the steps below to ensure proper configuration.

## Prerequisites
- Ensure you have a registered account on the M-PESA Developer Portal.
- Obtain your credentials, including the Consumer Key and Consumer Secret.

## Environment Variables
To integrate Daraja M-PESA, you need to set up the following environment variables in your project:

### Required Variables:
- `MPESA_CONSUMER_KEY`: Your M-PESA Consumer Key.
- `MPESA_CONSUMER_SECRET`: Your M-PESA Consumer Secret.
- `MPESA_SHORTCODE`: Your M-PESA Shortcode.
- `MPESA_LIVE_URL`: The API endpoint for live transactions, usually `https://api.safaricom.co.ke/`
- `MPESA_SAFARICOM_PASSKEY`: Your M-PESA passkey for transaction processing.
- `MPESA_SAFARICOM_PUBLIC_KEY`: The public key provided to you or generated for encryption purposes.

### Example Setup:
```bash
export MPESA_CONSUMER_KEY='your_consumer_key'
export MPESA_CONSUMER_SECRET='your_consumer_secret'
export MPESA_SHORTCODE='your_shortcode'
export MPESA_LIVE_URL='https://api.safaricom.co.ke/'
export MPESA_SAFARICOM_PASSKEY='your_passkey'
export MPESA_SAFARICOM_PUBLIC_KEY='your_public_key'
```

## Callback URL Setup
You need to configure the callback URL to handle M-PESA transaction status updates. 
1. In your M-PESA Developer account, navigate to your application settings.
2. Set the following URLs for transaction types you want to monitor:
   - **Payment Callback URL**: This URL should point to your server endpoint that will handle the transaction responses.
   - **Confirmation URL**: A URL to confirm the transaction.

### Example Callback URL:
```plaintext
https://yourdomain.com/api/mpesa/callback
```

## API Endpoints for Production
Below are the relevant API endpoints you'll use during production:

### 1. Request for Access Token
- **Endpoint**: `https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials`
- **Method**: `GET`

### 2. Lipa Na M-PESA Online Payment
- **Endpoint**: `https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest`
- **Method**: `POST`

### 3. Transaction Status Query
- **Endpoint**: `https://api.safaricom.co.ke/mpesa/transactionstatus/v1/query`
- **Method**: `POST`

### 4. Reversal API
- **Endpoint**: `https://api.safaricom.co.ke/mpesa/reversal/v1/request`
- **Method**: `POST`

### NOTE:
Ensure you replace any placeholders in the URLs with your actual account information as needed. For secure operations, always implement necessary security measures including HTTPS.

## Conclusion
With the above setups, you should be able to successfully integrate the Daraja M-PESA API into your application. For more specific implementations, refer to the official M-PESA API documentation or consult developer forums for support.