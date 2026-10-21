# Safaricom Daraja STK Push setup

Tajiri POS can send M-Pesa STK Push requests through either `server.js` or
`php-server.php`. Both backends implement the same `/api/mpesa` routes and use
the same payment-status file. Run only one backend at a time. Daraja credentials
stay on the server; they must never be entered into browser settings or
committed to source control.

## Sandbox setup

1. Create/configure a Daraja app in the Safaricom developer portal and obtain
   the consumer key, consumer secret, shortcode, and passkey for the sandbox.
2. Copy `.env.example` to `.env`. Keep `DARAJA_ENV=sandbox`, fill in the
   credentials, and select the transaction type assigned to your shortcode.
3. Generate a random URL-safe callback token of at least 32 characters. Use
   that exact token both in `DARAJA_CALLBACK_TOKEN` and as the final segment of
   `DARAJA_CALLBACK_URL`.
4. Configure the callback URL with a publicly reachable HTTPS tunnel or HTTPS
   reverse proxy. Daraja cannot call a `localhost` callback.
5. Start the POS with `npm start`, then open `http://127.0.0.1:3000`. The
   Settings screen reports whether the server has all required configuration.
6. Use a Daraja sandbox test phone number. The sale is recorded only after the
   callback confirms a matching amount, phone number, and M-Pesa receipt
   number. Failed or mismatched callbacks do not complete sales.

## Run the PHP backend

Install PHP 8+ with the cURL extension enabled, then run `npm run start:php`
from the project folder. Alternatively, run
`php -S 127.0.0.1:8000 php-server.php`. Open `http://127.0.0.1:8000` and check
the Daraja connection from Settings. The PHP router reads the same `.env` file
as Node and serves the POS UI and Daraja APIs from the project directory.

The backend retains payment request status in `data/daraja-payments.json`.
That file contains customer phone numbers and transaction references; protect
it like business data. It is ignored by Git.

## Production requirements

Switch to `DARAJA_ENV=production` only after Safaricom has approved the
production shortcode and credentials. Set a production callback URL with valid
HTTPS. Both included backends bind to loopback by default; the PHP built-in
server is for local development. Neither has server-side POS user
authentication or a multi-device database. Do not expose them directly to the
internet or a store network. Before a shared/hosted deployment, put the backend
behind authentication and a TLS reverse proxy, and use durable production
storage with backups.

Daraja callbacks do not include a provider signature in this integration. The
callback path token and server-side checkout/amount/phone/receipt matching
reduce unsolicited or mismatched callback risk, but are not a replacement for
an authenticated production backend. Verify any transaction marked for review
in the Daraja portal before recording or refunding it.
