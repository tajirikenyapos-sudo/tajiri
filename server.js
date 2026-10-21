"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

const ROOT = __dirname;
// In packaged Electron builds, TAJIRI_DATA_DIR points to the writable
// per-user folder (%APPDATA%/Tajiri POS) so data survives app updates.
const DATA_DIR =
  process.env.TAJIRI_DATA_DIR || path.join(ROOT, "data");
const DEFAULT_DATA_FILE = path.join(DATA_DIR, "daraja-payments.json");
const MAX_BODY_BYTES = 16 * 1024;
const MAX_STK_AMOUNT = 150_000;
const PAYMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

function normalizeKenyanPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  return null;
}

function getDarajaConfig(env = process.env) {
  const environment = env.DARAJA_ENV || "sandbox";
  const apiHosts = {
    sandbox: "https://sandbox.safaricom.co.ke",
    production: "https://api.safaricom.co.ke",
  };
  const shortCode = String(env.DARAJA_SHORTCODE || "").trim();
  const consumerKey = String(env.DARAJA_CONSUMER_KEY || "").trim();
  const consumerSecret = String(env.DARAJA_CONSUMER_SECRET || "").trim();
  const passkey = String(env.DARAJA_PASSKEY || "").trim();
  const callbackToken = String(env.DARAJA_CALLBACK_TOKEN || "").trim();
  const callbackUrl = String(env.DARAJA_CALLBACK_URL || "").trim();
  const transactionType =
    env.DARAJA_TRANSACTION_TYPE || "CustomerPayBillOnline";
  const callbackPath = `/api/mpesa/callback/${callbackToken}`;
  let callbackUrlValid = false;
  if (callbackUrl) {
    try {
      const parsedCallbackUrl = new URL(callbackUrl);
      callbackUrlValid =
        parsedCallbackUrl.protocol === "https:" &&
        parsedCallbackUrl.pathname === callbackPath &&
        !parsedCallbackUrl.search &&
        !parsedCallbackUrl.hash;
    } catch {
      callbackUrlValid = false;
    }
  }

  return {
    environment,
    apiHost: apiHosts[environment],
    shortCode,
    consumerKey,
    consumerSecret,
    passkey,
    callbackToken,
    callbackUrl,
    callbackUrlValid: Boolean(callbackUrlValid),
    transactionType,
    configured: Boolean(
      apiHosts[environment] &&
        shortCode &&
        consumerKey &&
        consumerSecret &&
        passkey &&
        /^[A-Za-z0-9_-]{32,}$/.test(callbackToken) &&
        callbackUrlValid &&
        [
          "CustomerPayBillOnline",
          "CustomerBuyGoodsOnline",
        ].includes(transactionType),
    ),
  };
}

function getKenyaTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
  return `${values.year}${values.month}${values.day}${values.hour}${values.minute}${values.second}`;
}

async function readJsonBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

function sendJson(response, statusCode, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(encoded),
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(encoded);
}

function isSameOriginRequest(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

async function readPaymentStore(dataFile) {
  try {
    const contents = await fs.readFile(dataFile, "utf8");
    const store = JSON.parse(contents);
    if (!store || typeof store !== "object" || Array.isArray(store))
      throw new Error("Daraja payment store must be a JSON object");
    return store;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`Could not read Daraja payment store: ${error.message}`);
  }
}

async function writePaymentStore(dataFile, store) {
  await fs.mkdir(path.dirname(dataFile), { recursive: true });
  const tempFile = `${dataFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempFile, JSON.stringify(store, null, 2), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(tempFile, dataFile);
  } catch (error) {
    await fs.rm(tempFile, { force: true }).catch(() => {});
    throw error;
  }
}

function callbackMetadata(callback) {
  const items = callback?.Body?.stkCallback?.CallbackMetadata?.Item;
  if (!Array.isArray(items)) return {};
  return Object.fromEntries(
    items
      .filter((item) => item && typeof item.Name === "string")
      .map((item) => [item.Name, item.Value]),
  );
}

function applyStkCallback(store, body) {
  const callback = body?.Body?.stkCallback;
  const checkoutId = callback?.CheckoutRequestID;
  const payment = Object.values(store).find(
    (entry) => entry.checkoutRequestId === checkoutId,
  );
  if (!payment) return { accepted: false, reason: "Unknown checkout request" };
  if (payment.status !== "pending")
    return { accepted: true, duplicate: true, payment };

  const resultCode = Number(callback.ResultCode);
  if (!Number.isInteger(resultCode))
    return { accepted: false, reason: "Invalid callback result code" };
  if (resultCode !== 0) {
    payment.status = "failed";
    payment.resultDesc =
      typeof callback.ResultDesc === "string"
        ? callback.ResultDesc.slice(0, 256)
        : "M-Pesa payment was not completed";
    payment.updatedAt = new Date().toISOString();
    return { accepted: true, payment };
  }

  const metadata = callbackMetadata(body);
  const callbackAmount = Number(metadata.Amount);
  const callbackPhone = normalizeKenyanPhone(metadata.PhoneNumber);
  const receiptNumber = String(metadata.MpesaReceiptNumber || "").trim();
  if (
    !Number.isSafeInteger(callbackAmount) ||
    callbackAmount !== payment.amount ||
    !callbackPhone ||
    callbackPhone !== payment.phone ||
    !/^[A-Z0-9]{6,20}$/i.test(receiptNumber)
  ) {
    payment.status = "review";
    payment.resultDesc =
      "Payment callback did not match the expected amount, phone, or receipt";
    payment.updatedAt = new Date().toISOString();
    return { accepted: true, payment };
  }

  payment.status = "success";
  payment.mpesaReceiptNumber = receiptNumber;
  payment.resultDesc = "M-Pesa payment confirmed";
  payment.updatedAt = new Date().toISOString();
  return { accepted: true, payment };
}

function safePaymentResponse(payment) {
  return {
    requestId: payment.requestId,
    status: payment.status,
    amount: payment.amount,
    resultDesc: payment.resultDesc || "",
    mpesaReceiptNumber: payment.mpesaReceiptNumber || "",
  };
}

function validateStkRequest(body) {
  const amount = Number(body?.amount);
  const phone = normalizeKenyanPhone(body?.phone);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_STK_AMOUNT)
    return { error: `Amount must be a whole KES value from 1 to ${MAX_STK_AMOUNT}` };
  if (!phone) return { error: "Enter a valid Kenyan M-Pesa phone number" };
  return { amount, phone };
}

function validateCallbackToken(provided, expected) {
  if (!expected || expected.length < 32 || !provided) return false;
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return (
    expectedBuffer.length === providedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, providedBuffer)
  );
}

async function serveStaticFile(response, pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    sendJson(response, 400, { success: false, message: "Invalid path" });
    return;
  }
  const relativePath = decodedPath === "/" ? "main.html" : decodedPath.slice(1);
  const filePath = path.resolve(ROOT, relativePath);
  if (!filePath.startsWith(`${ROOT}${path.sep}`)) {
    sendJson(response, 404, { success: false, message: "Not found" });
    return;
  }
  const mimeType = MIME_TYPES[path.extname(filePath).toLowerCase()];
  if (!mimeType) {
    sendJson(response, 404, { success: false, message: "Not found" });
    return;
  }
  try {
    const file = await fs.readFile(filePath);
    response.writeHead(200, {
      "Cache-Control":
        path.extname(filePath).toLowerCase() === ".html"
          ? "no-store"
          : "no-cache",
      "Content-Length": file.length,
      "Content-Type": mimeType,
      "X-Content-Type-Options": "nosniff",
    });
    response.end(file);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendJson(response, 404, { success: false, message: "Not found" });
      return;
    }
    throw error;
  }
}

function createAppServer({
  env = process.env,
  fetchImpl = globalThis.fetch,
  dataFile = DEFAULT_DATA_FILE,
} = {}) {
  let tokenCache = null;
  let paymentStorePromise = readPaymentStore(dataFile);
  let writeQueue = Promise.resolve();
  const config = getDarajaConfig(env);

  function savePaymentStore(store) {
    writeQueue = writeQueue.then(() => writePaymentStore(dataFile, store));
    return writeQueue;
  }

  async function getAccessToken() {
    if (tokenCache && tokenCache.expiresAt > Date.now() + 30_000)
      return tokenCache.value;
    const credentials = Buffer.from(
      `${config.consumerKey}:${config.consumerSecret}`,
    ).toString("base64");
    const response = await fetchImpl(
      `${config.apiHost}/oauth/v1/generate?grant_type=client_credentials`,
      {
        headers: { Authorization: `Basic ${credentials}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.access_token)
      throw new Error("Daraja authentication failed; verify the server credentials");
    const expiresIn = Math.max(60, Number(result.expires_in) || 3600);
    tokenCache = {
      value: result.access_token,
      expiresAt: Date.now() + expiresIn * 1000,
    };
    return tokenCache.value;
  }

  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const pathname = requestUrl.pathname;
    try {
      if (pathname.startsWith("/api/") && !isSameOriginRequest(request)) {
        sendJson(response, 403, {
          success: false,
          message: "Cross-origin API requests are not allowed",
        });
        return;
      }

      if (request.method === "GET" && pathname === "/api/mpesa/config") {
        sendJson(response, 200, {
          success: true,
          configured: config.configured,
          environment: config.environment,
        });
        return;
      }

      if (request.method === "POST" && pathname === "/api/mpesa/stk-push") {
        if (!config.configured) {
          sendJson(response, 503, {
            success: false,
            message: "Daraja backend is not configured",
          });
          return;
        }
        const body = await readJsonBody(request);
        const validated = validateStkRequest(body);
        if (validated.error) {
          sendJson(response, 400, {
            success: false,
            message: validated.error,
          });
          return;
        }

        const store = await paymentStorePromise;
        const requestId = crypto.randomUUID();
        const payment = {
          requestId,
          amount: validated.amount,
          phone: validated.phone,
          status: "initiating",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        store[requestId] = payment;
        await savePaymentStore(store);

        let result;
        let darajaResponse;
        try {
          const timestamp = getKenyaTimestamp();
          const password = Buffer.from(
            `${config.shortCode}${config.passkey}${timestamp}`,
          ).toString("base64");
          const accessToken = await getAccessToken();
          darajaResponse = await fetchImpl(
            `${config.apiHost}/mpesa/stkpush/v1/processrequest`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                BusinessShortCode: config.shortCode,
                Password: password,
                Timestamp: timestamp,
                TransactionType: config.transactionType,
                Amount: validated.amount,
                PartyA: validated.phone,
                PartyB: config.shortCode,
                PhoneNumber: validated.phone,
                CallBackURL: config.callbackUrl,
                AccountReference: "TAJIRI POS",
                TransactionDesc: "POS payment",
              }),
              signal: AbortSignal.timeout(20_000),
            },
          );
          result = await darajaResponse.json().catch(() => ({}));
        } catch (error) {
          payment.status = "review";
          payment.resultDesc =
            "Daraja response was unavailable; verify the request in the Daraja portal before retrying";
          payment.updatedAt = new Date().toISOString();
          await savePaymentStore(store);
          console.error("Daraja STK request outcome is unknown:", error.message);
          sendJson(response, 202, {
            success: true,
            ...safePaymentResponse(payment),
          });
          return;
        }
        if (
          !darajaResponse.ok ||
          String(result.ResponseCode) !== "0" ||
          !result.CheckoutRequestID
        ) {
          payment.status = "failed";
          payment.resultDesc = String(
            result.errorMessage || result.ResponseDescription || "Daraja rejected the STK request",
          ).slice(0, 256);
          payment.updatedAt = new Date().toISOString();
          await savePaymentStore(store);
          sendJson(response, 502, {
            success: false,
            message: payment.resultDesc,
          });
          return;
        }
        payment.status = "pending";
        payment.checkoutRequestId = String(result.CheckoutRequestID);
        payment.merchantRequestId = String(result.MerchantRequestID || "");
        payment.customerMessage = String(result.CustomerMessage || "");
        payment.updatedAt = new Date().toISOString();
        await savePaymentStore(store);
        sendJson(response, 202, {
          success: true,
          ...safePaymentResponse(payment),
          customerMessage: payment.customerMessage,
        });
        return;
      }

      const statusMatch = pathname.match(
        /^\/api\/mpesa\/status\/([0-9a-f-]{36})$/i,
      );
      if (request.method === "GET" && statusMatch) {
        if (!PAYMENT_ID_PATTERN.test(statusMatch[1])) {
          sendJson(response, 400, {
            success: false,
            message: "Invalid payment reference",
          });
          return;
        }
        const store = await paymentStorePromise;
        const payment = store[statusMatch[1]];
        if (!payment) {
          sendJson(response, 404, {
            success: false,
            message: "Payment request not found",
          });
          return;
        }
        sendJson(response, 200, {
          success: true,
          ...safePaymentResponse(payment),
        });
        return;
      }

      const callbackMatch = pathname.match(
        /^\/api\/mpesa\/callback\/([^/]+)$/,
      );
      if (request.method === "POST" && callbackMatch) {
        if (
          !validateCallbackToken(callbackMatch[1], config.callbackToken) ||
          !config.configured
        ) {
          sendJson(response, 404, { success: false });
          return;
        }
        const body = await readJsonBody(request);
        const store = await paymentStorePromise;
        const result = applyStkCallback(store, body);
        if (!result.accepted) {
          console.warn("Rejected unmatched Daraja callback:", result.reason);
          sendJson(response, 200, {
            ResultCode: 1,
            ResultDesc: result.reason,
          });
          return;
        }
        if (!result.duplicate) await savePaymentStore(store);
        sendJson(response, 200, {
          ResultCode: 0,
          ResultDesc: "Accepted",
        });
        return;
      }

      if (pathname.startsWith("/api/")) {
        sendJson(response, 404, { success: false, message: "API route not found" });
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 405, { success: false, message: "Method not allowed" });
        return;
      }
      await serveStaticFile(response, pathname);
    } catch (error) {
      console.error("POS API request failed:", error);
      if (!response.headersSent)
        sendJson(response, 500, {
          success: false,
          message: error.message || "The request could not be completed",
        });
      else response.destroy();
    }
  });

  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "127.0.0.1";
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    console.error("PORT must be an integer between 1 and 65535");
    process.exitCode = 1;
  } else {
    const server = createAppServer();
    server.listen(port, host, () => {
      console.log(`Tajiri POS server listening at http://${host}:${port}`);
      console.log(
        `Daraja STK Push configuration: ${getDarajaConfig().configured ? "ready" : "not configured"}`,
      );
    });
  }
}

module.exports = {
  applyStkCallback,
  createAppServer,
  getDarajaConfig,
  getKenyaTimestamp,
  normalizeKenyanPhone,
  validateStkRequest,
};
