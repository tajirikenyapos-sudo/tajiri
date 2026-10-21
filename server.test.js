// @vitest-environment node

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  afterEach,
  describe,
  expect,
  it,
  vi,
} = await import("vitest");
const {
  applyStkCallback,
  createAppServer,
  getDarajaConfig,
  getKenyaTimestamp,
  normalizeKenyanPhone,
  validateStkRequest,
} = require("./server");

const callbackToken = "test-callback-token-12345678901234567890";
const env = {
  DARAJA_ENV: "sandbox",
  DARAJA_CONSUMER_KEY: "test-key",
  DARAJA_CONSUMER_SECRET: "test-secret",
  DARAJA_SHORTCODE: "174379",
  DARAJA_PASSKEY: "test-passkey",
  DARAJA_TRANSACTION_TYPE: "CustomerPayBillOnline",
  DARAJA_CALLBACK_TOKEN: callbackToken,
  DARAJA_CALLBACK_URL: `https://pos.example.test/api/mpesa/callback/${callbackToken}`,
};

describe("Daraja server helpers", () => {
  it("normalizes Kenya M-Pesa numbers", () => {
    expect(normalizeKenyanPhone("0712345678")).toBe("254712345678");
    expect(normalizeKenyanPhone("+254112345678")).toBe("254112345678");
    expect(normalizeKenyanPhone("12345")).toBeNull();
  });

  it("requires valid server credentials and an HTTPS callback", () => {
    expect(getDarajaConfig(env).configured).toBe(true);
    expect(
      getDarajaConfig({
        ...env,
        DARAJA_CALLBACK_URL: `http://localhost/api/mpesa/callback/${callbackToken}`,
      }).configured,
    ).toBe(false);
    expect(getDarajaConfig({ ...env, DARAJA_PASSKEY: "" }).configured).toBe(
      false,
    );
    expect(
      getDarajaConfig({
        ...env,
        DARAJA_CALLBACK_TOKEN: "token/with/path-separator-and-more-characters",
      }).configured,
    ).toBe(false);
  });

  it("validates whole-shilling amounts and Kenyan phone numbers", () => {
    expect(validateStkRequest({ amount: 120, phone: "0712345678" })).toEqual({
      amount: 120,
      phone: "254712345678",
    });
    expect(validateStkRequest({ amount: 1.25, phone: "0712345678" }).error)
      .toBeTruthy();
    expect(validateStkRequest({ amount: 120, phone: "12345" }).error)
      .toBeTruthy();
  });

  it("formats the timestamp in the Daraja-required Kenya time zone", () => {
    expect(getKenyaTimestamp(new Date("2026-10-14T12:03:05.000Z"))).toBe(
      "20261014150305",
    );
  });

  it("confirms a payment only when callback amount, phone, and receipt match", () => {
    const store = {
      one: {
        requestId: "one",
        checkoutRequestId: "ws_CO_123",
        amount: 120,
        phone: "254712345678",
        status: "pending",
      },
    };
    const callback = {
      Body: {
        stkCallback: {
          CheckoutRequestID: "ws_CO_123",
          ResultCode: 0,
          CallbackMetadata: {
            Item: [
              { Name: "Amount", Value: 120 },
              { Name: "MpesaReceiptNumber", Value: "QWE1234567" },
              { Name: "PhoneNumber", Value: 254712345678 },
            ],
          },
        },
      },
    };
    const result = applyStkCallback(store, callback);
    expect(result.accepted).toBe(true);
    expect(result.payment.status).toBe("success");
    expect(result.payment.mpesaReceiptNumber).toBe("QWE1234567");

    const mismatchStore = {
      two: {
        requestId: "two",
        checkoutRequestId: "ws_CO_456",
        amount: 120,
        phone: "254712345678",
        status: "pending",
      },
    };
    const mismatch = applyStkCallback(mismatchStore, {
      Body: {
        stkCallback: {
          ...callback.Body.stkCallback,
          CheckoutRequestID: "ws_CO_456",
          CallbackMetadata: {
            Item: [
              { Name: "Amount", Value: 119 },
              { Name: "MpesaReceiptNumber", Value: "QWE1234567" },
              { Name: "PhoneNumber", Value: 254712345678 },
            ],
          },
        },
      },
    });
    expect(mismatch.payment.status).toBe("review");

    const missingPhoneStore = {
      three: {
        requestId: "three",
        checkoutRequestId: "ws_CO_789",
        amount: 120,
        phone: "254712345678",
        status: "pending",
      },
    };
    const missingPhone = applyStkCallback(missingPhoneStore, {
      Body: {
        stkCallback: {
          ...callback.Body.stkCallback,
          CheckoutRequestID: "ws_CO_789",
          CallbackMetadata: {
            Item: [
              { Name: "Amount", Value: 120 },
              { Name: "MpesaReceiptNumber", Value: "QWE1234567" },
            ],
          },
        },
      },
    });
    expect(missingPhone.payment.status).toBe("review");
  });
});

describe("Daraja HTTP API", () => {
  let server;
  let dataDirectory;
  let baseUrl;

  afterEach(async () => {
    if (server?.listening)
      await new Promise((resolve) => server.close(resolve));
    if (dataDirectory)
      await fs.rm(dataDirectory, { recursive: true, force: true });
    server = null;
    dataDirectory = null;
  });

  it("serves authentication entry pages without browser caching", async () => {
    dataDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "tajiri-auth-pages-test-"),
    );
    server = createAppServer({
      env,
      fetchImpl: vi.fn(),
      dataFile: path.join(dataDirectory, "payments.json"),
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const home = await fetch(`${baseUrl}/`);
    expect(home.status).toBe(200);
    expect(home.headers.get("cache-control")).toBe("no-store");
    const homeHtml = await home.text();
    expect(homeHtml).toContain("Choose a workspace to continue to your point of sale.");
    expect(homeHtml).toContain('href="admin.html"');
    expect(homeHtml).toContain('href="cashier.html"');

    for (const route of ["/login.html", "/admin.html", "/cashier.html"]) {
      const response = await fetch(`${baseUrl}${route}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }

    const manifest = await fetch(`${baseUrl}/manifest.webmanifest`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("content-type")).toContain(
      "application/manifest+json",
    );
    const manifestJson = await manifest.json();
    expect(manifestJson.start_url).toBe("./main.html");
    expect(manifestJson.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sizes: "192x192", type: "image/png" }),
        expect.objectContaining({ sizes: "512x512", type: "image/png" }),
      ]),
    );

    for (const route of [
      "/service-worker.js",
      "/icons/tajiri-pos-192.png",
      "/icons/tajiri-pos-512.png",
    ]) {
      const response = await fetch(`${baseUrl}${route}`);
      expect(response.status).toBe(200);
    }
  });

  it("starts STK Push and reports success only after the matching callback", async () => {
    dataDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "tajiri-daraja-test-"),
    );
    const fetchImpl = vi.fn(async (url, options = {}) => {
      if (String(url).includes("/oauth/")) {
        return new Response(
          JSON.stringify({ access_token: "test-access-token", expires_in: 3600 }),
          { status: 200 },
        );
      }
      expect(String(url)).toContain("/mpesa/stkpush/v1/processrequest");
      const requestBody = JSON.parse(options.body);
      expect(requestBody.Amount).toBe(120);
      expect(requestBody.PhoneNumber).toBe("254712345678");
      expect(requestBody.CallBackURL).toBe(env.DARAJA_CALLBACK_URL);
      expect(options.headers.Authorization).toBe("Bearer test-access-token");
      return new Response(
        JSON.stringify({
          ResponseCode: "0",
          CheckoutRequestID: "ws_CO_123",
          MerchantRequestID: "merchant_123",
          CustomerMessage: "Success. Request accepted for processing",
        }),
        { status: 200 },
      );
    });
    server = createAppServer({
      env,
      fetchImpl,
      dataFile: path.join(dataDirectory, "payments.json"),
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const startedResponse = await fetch(`${baseUrl}/api/mpesa/stk-push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: baseUrl,
      },
      body: JSON.stringify({ amount: 120, phone: "0712345678" }),
    });
    expect(startedResponse.status).toBe(202);
    const started = await startedResponse.json();
    expect(started.success).toBe(true);
    expect(started.status).toBe("pending");

    const pendingResponse = await fetch(
      `${baseUrl}/api/mpesa/status/${started.requestId}`,
    );
    expect((await pendingResponse.json()).status).toBe("pending");

    const callbackResponse = await fetch(
      `${baseUrl}/api/mpesa/callback/${callbackToken}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          Body: {
            stkCallback: {
              CheckoutRequestID: "ws_CO_123",
              ResultCode: 0,
              ResultDesc: "The service request is processed successfully",
              CallbackMetadata: {
                Item: [
                  { Name: "Amount", Value: 120 },
                  { Name: "MpesaReceiptNumber", Value: "QWE1234567" },
                  { Name: "PhoneNumber", Value: 254712345678 },
                ],
              },
            },
          },
        }),
      },
    );
    expect(callbackResponse.status).toBe(200);

    const confirmedResponse = await fetch(
      `${baseUrl}/api/mpesa/status/${started.requestId}`,
    );
    const confirmed = await confirmedResponse.json();
    expect(confirmed.status).toBe("success");
    expect(confirmed.mpesaReceiptNumber).toBe("QWE1234567");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects cross-origin payment initiation", async () => {
    dataDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "tajiri-daraja-test-"),
    );
    server = createAppServer({
      env,
      fetchImpl: vi.fn(),
      dataFile: path.join(dataDirectory, "payments.json"),
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${baseUrl}/api/mpesa/stk-push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://attacker.example",
      },
      body: JSON.stringify({ amount: 120, phone: "0712345678" }),
    });
    expect(response.status).toBe(403);
  });
});
