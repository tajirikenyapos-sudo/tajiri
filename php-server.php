<?php
declare(strict_types=1);

const POS_ROOT = __DIR__;
const MAX_REQUEST_BYTES = 16384;
const MAX_STK_AMOUNT = 150000;
const PAYMENT_FILE = POS_ROOT . '/data/daraja-payments.json';

function jsonResponse(int $status, array $payload): void
{
    http_response_code($status);
    header('Cache-Control: no-store');
    header('Content-Type: application/json; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
}

function loadDotEnv(): void
{
    $file = POS_ROOT . '/.env';
    if (!is_file($file) || !is_readable($file)) {
        return;
    }
    foreach (file($file, FILE_IGNORE_NEW_LINES) ?: [] as $line) {
        $line = trim($line);
        if ($line === '' || str_starts_with($line, '#') || !str_contains($line, '=')) {
            continue;
        }
        [$name, $value] = explode('=', $line, 2);
        $name = trim($name);
        $value = trim($value);
        if (!preg_match('/^[A-Z_][A-Z0-9_]*$/i', $name) || getenv($name) !== false) {
            continue;
        }
        if (strlen($value) >= 2 && (($value[0] === '"' && str_ends_with($value, '"')) || ($value[0] === "'" && str_ends_with($value, "'")))) {
            $value = substr($value, 1, -1);
        } else {
            $value = preg_replace('/\s+#.*$/', '', $value) ?? $value;
        }
        putenv($name . '=' . $value);
        $_ENV[$name] = $value;
    }
}

function envValue(string $name, string $default = ''): string
{
    $value = getenv($name);
    return $value === false ? $default : trim($value);
}

function darajaConfig(): array
{
    $environment = envValue('DARAJA_ENV', 'sandbox');
    $hosts = [
        'sandbox' => 'https://sandbox.safaricom.co.ke',
        'production' => 'https://api.safaricom.co.ke',
    ];
    $shortcode = envValue('DARAJA_SHORTCODE');
    $consumerKey = envValue('DARAJA_CONSUMER_KEY');
    $consumerSecret = envValue('DARAJA_CONSUMER_SECRET');
    $passkey = envValue('DARAJA_PASSKEY');
    $callbackToken = envValue('DARAJA_CALLBACK_TOKEN');
    $callbackUrl = envValue('DARAJA_CALLBACK_URL');
    $transactionType = envValue('DARAJA_TRANSACTION_TYPE', 'CustomerPayBillOnline');
    $callbackUrlValid = false;

    if ($callbackUrl !== '' && preg_match('/^[A-Za-z0-9_-]{32,}$/', $callbackToken)) {
        $callback = parse_url($callbackUrl);
        $callbackUrlValid = is_array($callback)
            && ($callback['scheme'] ?? '') === 'https'
            && !empty($callback['host'])
            && !isset($callback['user'])
            && !isset($callback['pass'])
            && ($callback['path'] ?? '') === '/api/mpesa/callback/' . $callbackToken
            && !isset($callback['query'])
            && !isset($callback['fragment']);
    }

    return [
        'environment' => $environment,
        'apiHost' => $hosts[$environment] ?? '',
        'shortcode' => $shortcode,
        'consumerKey' => $consumerKey,
        'consumerSecret' => $consumerSecret,
        'passkey' => $passkey,
        'callbackToken' => $callbackToken,
        'callbackUrl' => $callbackUrl,
        'transactionType' => $transactionType,
        'configured' => isset($hosts[$environment])
            && $shortcode !== ''
            && $consumerKey !== ''
            && $consumerSecret !== ''
            && $passkey !== ''
            && preg_match('/^[A-Za-z0-9_-]{32,}$/', $callbackToken) === 1
            && $callbackUrlValid
            && in_array($transactionType, ['CustomerPayBillOnline', 'CustomerBuyGoodsOnline'], true)
            && function_exists('curl_init'),
    ];
}

function normalizePhone(mixed $value): ?string
{
    $digits = preg_replace('/\D/', '', (string)($value ?? '')) ?? '';
    if (preg_match('/^0[17]\d{8}$/', $digits)) {
        return '254' . substr($digits, 1);
    }
    if (preg_match('/^[17]\d{8}$/', $digits)) {
        return '254' . $digits;
    }
    return preg_match('/^254[17]\d{8}$/', $digits) ? $digits : null;
}

function requestJson(): array
{
    $length = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
    if ($length > MAX_REQUEST_BYTES) {
        throw new RuntimeException('Request body is too large');
    }
    $body = file_get_contents('php://input', false, null, 0, MAX_REQUEST_BYTES + 1);
    if ($body === false || strlen($body) > MAX_REQUEST_BYTES) {
        throw new RuntimeException('Request body is too large');
    }
    try {
        $decoded = json_decode($body, true, 512, JSON_THROW_ON_ERROR);
    } catch (JsonException) {
        throw new RuntimeException('Request body must be valid JSON');
    }
    if (!is_array($decoded)) {
        throw new RuntimeException('Request body must be a JSON object');
    }
    return $decoded;
}

function sameOriginRequest(): bool
{
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin === '') {
        return true;
    }
    $originHost = parse_url($origin, PHP_URL_HOST);
    $originPort = parse_url($origin, PHP_URL_PORT);
    $requestHost = strtolower($_SERVER['HTTP_HOST'] ?? '');
    if (!is_string($originHost) || $requestHost === '') {
        return false;
    }
    $expectedHost = strtolower($originHost . ($originPort === null ? '' : ':' . $originPort));
    return hash_equals($requestHost, $expectedHost);
}

function readPaymentStore(): array
{
    if (!is_file(PAYMENT_FILE)) {
        return [];
    }
    $handle = fopen(PAYMENT_FILE, 'rb');
    if ($handle === false) {
        throw new RuntimeException('Could not read Daraja payment store');
    }
    try {
        if (!flock($handle, LOCK_SH)) {
            throw new RuntimeException('Could not lock Daraja payment store');
        }
        $contents = stream_get_contents($handle);
        try {
            $store = json_decode($contents ?: '', true, 512, JSON_THROW_ON_ERROR);
        } catch (JsonException $error) {
            throw new RuntimeException('Daraja payment store contains invalid JSON', 0, $error);
        }
        if (!is_array($store)) {
            throw new RuntimeException('Daraja payment store must be a JSON object');
        }
        flock($handle, LOCK_UN);
        return $store;
    } finally {
        fclose($handle);
    }
}

function updatePaymentStore(callable $callback): mixed
{
    $directory = dirname(PAYMENT_FILE);
    if (!is_dir($directory) && !mkdir($directory, 0700, true) && !is_dir($directory)) {
        throw new RuntimeException('Could not create Daraja payment data directory');
    }
    $handle = fopen(PAYMENT_FILE, 'c+');
    if ($handle === false) {
        throw new RuntimeException('Could not open Daraja payment store');
    }
    try {
        if (!flock($handle, LOCK_EX)) {
            throw new RuntimeException('Could not lock Daraja payment store');
        }
        rewind($handle);
        $contents = stream_get_contents($handle);
        try {
            $store = $contents === '' ? [] : json_decode($contents, true, 512, JSON_THROW_ON_ERROR);
        } catch (JsonException $error) {
            throw new RuntimeException('Daraja payment store contains invalid JSON', 0, $error);
        }
        if (!is_array($store)) {
            throw new RuntimeException('Daraja payment store must be a JSON object');
        }
        $result = $callback($store);
        $encoded = json_encode($store, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
        rewind($handle);
        if (!ftruncate($handle, 0) || fwrite($handle, $encoded) === false || !fflush($handle)) {
            throw new RuntimeException('Could not save Daraja payment store');
        }
        chmod(PAYMENT_FILE, 0600);
        flock($handle, LOCK_UN);
        return $result;
    } finally {
        fclose($handle);
    }
}

function safePaymentResponse(array $payment): array
{
    return [
        'requestId' => $payment['requestId'],
        'status' => $payment['status'],
        'amount' => $payment['amount'],
        'resultDesc' => $payment['resultDesc'] ?? '',
        'mpesaReceiptNumber' => $payment['mpesaReceiptNumber'] ?? '',
    ];
}

function darajaRequest(string $url, string $method, array $headers, ?array $body = null): array
{
    $handle = curl_init($url);
    if ($handle === false) {
        throw new RuntimeException('Could not initialize the Daraja request');
    }
    $options = [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => 20,
    ];
    if ($method === 'POST') {
        $options[CURLOPT_POST] = true;
        $options[CURLOPT_POSTFIELDS] = json_encode($body, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    }
    curl_setopt_array($handle, $options);
    $responseBody = curl_exec($handle);
    $status = (int)curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
    $curlError = curl_error($handle);
    curl_close($handle);
    if (!is_string($responseBody)) {
        throw new RuntimeException('Daraja request failed: ' . ($curlError ?: 'no response'));
    }
    $decoded = json_decode($responseBody, true);
    return ['status' => $status, 'body' => is_array($decoded) ? $decoded : []];
}

function requestAccessToken(array $config): string
{
    $credentials = base64_encode($config['consumerKey'] . ':' . $config['consumerSecret']);
    $response = darajaRequest(
        $config['apiHost'] . '/oauth/v1/generate?grant_type=client_credentials',
        'GET',
        ['Authorization: Basic ' . $credentials],
    );
    $token = $response['body']['access_token'] ?? '';
    if ($response['status'] < 200 || $response['status'] >= 300 || !is_string($token) || $token === '') {
        throw new RuntimeException('Daraja authentication failed; verify the server credentials');
    }
    return $token;
}

function darajaTimestamp(): string
{
    return (new DateTimeImmutable('now', new DateTimeZone('Africa/Nairobi')))->format('YmdHis');
}

function paymentUuid(): string
{
    $bytes = random_bytes(16);
    $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
    $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
    $hex = bin2hex($bytes);
    return substr($hex, 0, 8) . '-' . substr($hex, 8, 4) . '-'
        . substr($hex, 12, 4) . '-' . substr($hex, 16, 4) . '-' . substr($hex, 20);
}

function callbackResult(array &$store, array $body): array
{
    $callback = $body['Body']['stkCallback'] ?? null;
    if (!is_array($callback)) {
        return ['accepted' => false, 'reason' => 'Invalid callback body'];
    }
    $checkoutId = $callback['CheckoutRequestID'] ?? null;
    $requestId = null;
    foreach ($store as $id => $entry) {
        if (is_array($entry) && ($entry['checkoutRequestId'] ?? null) === $checkoutId) {
            $requestId = $id;
            break;
        }
    }
    if ($requestId === null) {
        return ['accepted' => false, 'reason' => 'Unknown checkout request'];
    }
    if (($store[$requestId]['status'] ?? '') !== 'pending') {
        return ['accepted' => true, 'duplicate' => true];
    }
    $resultCode = filter_var($callback['ResultCode'] ?? null, FILTER_VALIDATE_INT);
    if ($resultCode === false) {
        return ['accepted' => false, 'reason' => 'Invalid callback result code'];
    }
    if ($resultCode !== 0) {
        $store[$requestId]['status'] = 'failed';
        $store[$requestId]['resultDesc'] = substr((string)($callback['ResultDesc'] ?? 'M-Pesa payment was not completed'), 0, 256);
        $store[$requestId]['updatedAt'] = gmdate('c');
        return ['accepted' => true];
    }

    $metadata = [];
    foreach (($callback['CallbackMetadata']['Item'] ?? []) as $item) {
        if (is_array($item) && is_string($item['Name'] ?? null)) {
            $metadata[$item['Name']] = $item['Value'] ?? null;
        }
    }
    $amount = filter_var($metadata['Amount'] ?? null, FILTER_VALIDATE_INT);
    $phone = normalizePhone($metadata['PhoneNumber'] ?? null);
    $receipt = trim((string)($metadata['MpesaReceiptNumber'] ?? ''));
    if (
        $amount === false
        || $amount !== (int)$store[$requestId]['amount']
        || $phone === null
        || $phone !== $store[$requestId]['phone']
        || !preg_match('/^[A-Z0-9]{6,20}$/i', $receipt)
    ) {
        $store[$requestId]['status'] = 'review';
        $store[$requestId]['resultDesc'] = 'Payment callback did not match the expected amount, phone, or receipt';
        $store[$requestId]['updatedAt'] = gmdate('c');
        return ['accepted' => true];
    }
    $store[$requestId]['status'] = 'success';
    $store[$requestId]['mpesaReceiptNumber'] = $receipt;
    $store[$requestId]['resultDesc'] = 'M-Pesa payment confirmed';
    $store[$requestId]['updatedAt'] = gmdate('c');
    return ['accepted' => true];
}

function serveStaticFile(string $path): void
{
    $decoded = rawurldecode($path);
    if (str_contains($decoded, "\0") || str_contains($decoded, '\\')) {
        jsonResponse(400, ['success' => false, 'message' => 'Invalid path']);
        return;
    }
    $relative = ltrim($decoded === '/' ? '/index.html' : $decoded, '/');
    $file = realpath(POS_ROOT . '/' . $relative);
    $root = realpath(POS_ROOT);
    $allowedExtensions = ['html', 'css', 'js', 'ico', 'jpg', 'jpeg', 'png', 'svg', 'webp', 'woff', 'woff2'];
    if (
        $file === false
        || $root === false
        || !str_starts_with($file, $root . DIRECTORY_SEPARATOR)
        || !is_file($file)
        || !in_array(strtolower(pathinfo($file, PATHINFO_EXTENSION)), $allowedExtensions, true)
    ) {
        jsonResponse(404, ['success' => false, 'message' => 'Not found']);
        return;
    }
    $mimeTypes = [
        'css' => 'text/css; charset=utf-8',
        'html' => 'text/html; charset=utf-8',
        'ico' => 'image/x-icon',
        'jpg' => 'image/jpeg',
        'jpeg' => 'image/jpeg',
        'js' => 'text/javascript; charset=utf-8',
        'png' => 'image/png',
        'svg' => 'image/svg+xml',
        'webp' => 'image/webp',
        'woff' => 'font/woff',
        'woff2' => 'font/woff2',
    ];
    header('Cache-Control: no-cache');
    header('Content-Type: ' . $mimeTypes[strtolower(pathinfo($file, PATHINFO_EXTENSION))]);
    header('X-Content-Type-Options: nosniff');
    readfile($file);
}

if (defined('TAJIRI_PHP_SERVER_LIBRARY_ONLY')) {
    return;
}

loadDotEnv();
$config = darajaConfig();
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$uriPath = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';

try {
    if (str_starts_with($uriPath, '/api/') && !sameOriginRequest()) {
        jsonResponse(403, ['success' => false, 'message' => 'Cross-origin API requests are not allowed']);
    } elseif ($method === 'GET' && $uriPath === '/api/mpesa/config') {
        jsonResponse(200, [
            'success' => true,
            'configured' => $config['configured'],
            'environment' => $config['environment'],
        ]);
    } elseif ($method === 'POST' && $uriPath === '/api/mpesa/stk-push') {
        if (!$config['configured']) {
            jsonResponse(503, ['success' => false, 'message' => 'Daraja backend is not configured or PHP cURL is unavailable']);
        } else {
            $body = requestJson();
            $amount = filter_var($body['amount'] ?? null, FILTER_VALIDATE_INT);
            $phone = normalizePhone($body['phone'] ?? null);
            if ($amount === false || $amount < 1 || $amount > MAX_STK_AMOUNT) {
                jsonResponse(400, ['success' => false, 'message' => 'Amount must be a whole KES value from 1 to ' . MAX_STK_AMOUNT]);
            } elseif ($phone === null) {
                jsonResponse(400, ['success' => false, 'message' => 'Enter a valid Kenyan M-Pesa phone number']);
            } else {
                $requestId = paymentUuid();
                $payment = [
                    'requestId' => $requestId,
                    'amount' => $amount,
                    'phone' => $phone,
                    'status' => 'initiating',
                    'createdAt' => gmdate('c'),
                    'updatedAt' => gmdate('c'),
                ];
                updatePaymentStore(static function (array &$store) use ($requestId, $payment): void {
                    $store[$requestId] = $payment;
                });
                try {
                    $timestamp = darajaTimestamp();
                    $password = base64_encode($config['shortcode'] . $config['passkey'] . $timestamp);
                    $accessToken = requestAccessToken($config);
                    $result = darajaRequest(
                        $config['apiHost'] . '/mpesa/stkpush/v1/processrequest',
                        'POST',
                        ['Authorization: Bearer ' . $accessToken, 'Content-Type: application/json'],
                        [
                            'BusinessShortCode' => $config['shortcode'],
                            'Password' => $password,
                            'Timestamp' => $timestamp,
                            'TransactionType' => $config['transactionType'],
                            'Amount' => $amount,
                            'PartyA' => $phone,
                            'PartyB' => $config['shortcode'],
                            'PhoneNumber' => $phone,
                            'CallBackURL' => $config['callbackUrl'],
                            'AccountReference' => 'TAJIRI POS',
                            'TransactionDesc' => 'POS payment',
                        ],
                    );
                    $daraja = $result['body'];
                    if (
                        $result['status'] < 200
                        || $result['status'] >= 300
                        || (string)($daraja['ResponseCode'] ?? '') !== '0'
                        || empty($daraja['CheckoutRequestID'])
                    ) {
                        $description = substr((string)($daraja['errorMessage'] ?? $daraja['ResponseDescription'] ?? 'Daraja rejected the STK request'), 0, 256);
                        updatePaymentStore(static function (array &$store) use ($requestId, $description): void {
                            $store[$requestId]['status'] = 'failed';
                            $store[$requestId]['resultDesc'] = $description;
                            $store[$requestId]['updatedAt'] = gmdate('c');
                        });
                        jsonResponse(502, ['success' => false, 'message' => $description]);
                    } else {
                        updatePaymentStore(static function (array &$store) use ($requestId, $daraja): void {
                            $store[$requestId]['status'] = 'pending';
                            $store[$requestId]['checkoutRequestId'] = (string)$daraja['CheckoutRequestID'];
                            $store[$requestId]['merchantRequestId'] = (string)($daraja['MerchantRequestID'] ?? '');
                            $store[$requestId]['customerMessage'] = (string)($daraja['CustomerMessage'] ?? '');
                            $store[$requestId]['updatedAt'] = gmdate('c');
                        });
                        $payment['status'] = 'pending';
                        $payment['customerMessage'] = (string)($daraja['CustomerMessage'] ?? '');
                        jsonResponse(202, ['success' => true] + safePaymentResponse($payment) + ['customerMessage' => $payment['customerMessage']]);
                    }
                } catch (Throwable $error) {
                    error_log('Daraja STK request outcome is unknown: ' . $error->getMessage());
                    $description = 'Daraja response was unavailable; verify the request in the Daraja portal before retrying';
                    updatePaymentStore(static function (array &$store) use ($requestId, $description): void {
                        $store[$requestId]['status'] = 'review';
                        $store[$requestId]['resultDesc'] = $description;
                        $store[$requestId]['updatedAt'] = gmdate('c');
                    });
                    $payment['status'] = 'review';
                    $payment['resultDesc'] = $description;
                    jsonResponse(202, ['success' => true] + safePaymentResponse($payment));
                }
            }
        }
    } elseif ($method === 'GET' && preg_match('#^/api/mpesa/status/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$#i', $uriPath, $match)) {
        $store = readPaymentStore();
        $payment = $store[$match[1]] ?? null;
        if (!is_array($payment)) {
            jsonResponse(404, ['success' => false, 'message' => 'Payment request not found']);
        } else {
            jsonResponse(200, ['success' => true] + safePaymentResponse($payment));
        }
    } elseif ($method === 'POST' && preg_match('#^/api/mpesa/callback/([^/]+)$#', $uriPath, $match)) {
        if ($config['callbackToken'] === '' || !hash_equals($config['callbackToken'], $match[1]) || !$config['configured']) {
            jsonResponse(404, ['success' => false]);
        } else {
            $body = requestJson();
            $result = updatePaymentStore(static function (array &$store) use ($body): array {
                return callbackResult($store, $body);
            });
            if (!$result['accepted']) {
                error_log('Rejected unmatched Daraja callback: ' . $result['reason']);
                jsonResponse(200, ['ResultCode' => 1, 'ResultDesc' => $result['reason']]);
            } else {
                jsonResponse(200, ['ResultCode' => 0, 'ResultDesc' => 'Accepted']);
            }
        }
    } elseif (str_starts_with($uriPath, '/api/')) {
        jsonResponse(404, ['success' => false, 'message' => 'API route not found']);
    } elseif (in_array($method, ['GET', 'HEAD'], true)) {
        if ($method === 'HEAD') {
            http_response_code(200);
        } else {
            serveStaticFile($uriPath);
        }
    } else {
        jsonResponse(405, ['success' => false, 'message' => 'Method not allowed']);
    }
} catch (Throwable $error) {
    error_log('POS PHP request failed: ' . $error->getMessage());
    jsonResponse(500, ['success' => false, 'message' => $error->getMessage()]);
}
