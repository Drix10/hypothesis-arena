# Demo Code

## TypeScript Implementation

```typescript
import crypto from "crypto";

const API_KEY = "";
const SECRET_KEY = "";
const ACCESS_PASSPHRASE = "";
const BASE_URL = "https://api-contract.weex.com/";

function generateSignature(
  secretKey: string,
  timestamp: string,
  method: string,
  requestPath: string,
  queryString: string,
  body: string
): string {
  const message =
    timestamp + method.toUpperCase() + requestPath + queryString + body;
  const signature = crypto
    .createHmac("sha256", secretKey)
    .update(message)
    .digest("base64");
  return signature;
}

function generateSignatureGet(
  secretKey: string,
  timestamp: string,
  method: string,
  requestPath: string,
  queryString: string
): string {
  const message = timestamp + method.toUpperCase() + requestPath + queryString;
  const signature = crypto
    .createHmac("sha256", secretKey)
    .update(message)
    .digest("base64");
  return signature;
}

async function sendRequestPost(
  apiKey: string,
  secretKey: string,
  accessPassphrase: string,
  method: string,
  requestPath: string,
  queryString: string,
  body: object
): Promise<Response> {
  const timestamp = Date.now().toString();
  const bodyString = JSON.stringify(body);
  const signature = generateSignature(
    secretKey,
    timestamp,
    method,
    requestPath,
    queryString,
    bodyString
  );

  const headers = {
    "ACCESS-KEY": apiKey,
    "ACCESS-SIGN": signature,
    "ACCESS-TIMESTAMP": timestamp,
    "ACCESS-PASSPHRASE": accessPassphrase,
    "Content-Type": "application/json",
    locale: "en-US",
  };

  const url = BASE_URL + requestPath;

  if (method === "GET") {
    return fetch(url, { method: "GET", headers });
  } else if (method === "POST") {
    return fetch(url, { method: "POST", headers, body: bodyString });
  }

  throw new Error("Unsupported method");
}

async function sendRequestGet(
  apiKey: string,
  secretKey: string,
  accessPassphrase: string,
  method: string,
  requestPath: string,
  queryString: string
): Promise<Response> {
  const timestamp = Date.now().toString();
  const signature = generateSignatureGet(
    secretKey,
    timestamp,
    method,
    requestPath,
    queryString
  );

  const headers = {
    "ACCESS-KEY": apiKey,
    "ACCESS-SIGN": signature,
    "ACCESS-TIMESTAMP": timestamp,
    "ACCESS-PASSPHRASE": accessPassphrase,
    "Content-Type": "application/json",
    locale: "en-US",
  };

  const url = BASE_URL + requestPath + queryString;
  return fetch(url, { method: "GET", headers });
}

async function getExample() {
  // Example of calling a GET request
  const requestPath = "/capi/v2/account/position/singlePosition";
  const queryString = "?symbol=cmt_btcusdt";

  const response = await sendRequestGet(
    API_KEY,
    SECRET_KEY,
    ACCESS_PASSPHRASE,
    "GET",
    requestPath,
    queryString
  );

  console.log(response.status);
  console.log(await response.text());
}

async function postExample() {
  // Example of calling a POST request
  const requestPath = "/capi/v2/order/placeOrder";
  const body = {
    symbol: "cmt_btcusdt",
    client_oid: "71557515757447",
    size: "0.01",
    type: "1",
    order_type: "0",
    match_price: "1",
    price: "80000",
  };
  const queryString = "";

  const response = await sendRequestPost(
    API_KEY,
    SECRET_KEY,
    ACCESS_PASSPHRASE,
    "POST",
    requestPath,
    queryString,
    body
  );

  console.log(response.status);
  console.log(await response.text());
}

// Usage
(async () => {
  await getExample();
  await postExample();
})();
```

## Python Implementation

```python
import time
import hmac
import hashlib
import base64
import requests
import json

api_key = ""
secret_key = ""
access_passphrase = ""

def generate_signature(secret_key, timestamp, method, request_path, query_string, body):
  message = timestamp + method.upper() + request_path + query_string + str(body)
  signature = hmac.new(secret_key.encode(), message.encode(), hashlib.sha256).digest()
  return base64.b64encode(signature).decode()

def generate_signature_get(secret_key, timestamp, method, request_path, query_string):
  message = timestamp + method.upper() + request_path + query_string
  signature = hmac.new(secret_key.encode(), message.encode(), hashlib.sha256).digest()
  return base64.b64encode(signature).decode()

def send_request_post(api_key, secret_key, access_passphrase, method, request_path, query_string, body):
  timestamp = str(int(time.time() * 1000))
  body = json.dumps(body)
  signature = generate_signature(secret_key, timestamp, method, request_path, query_string, body)

  headers = {
        "ACCESS-KEY": api_key,
        "ACCESS-SIGN": signature,
        "ACCESS-TIMESTAMP": timestamp,
        "ACCESS-PASSPHRASE": access_passphrase,
        "Content-Type": "application/json",
        "locale": "en-US"
  }

  url = "https://api-contract.weex.com/"
  if method == "GET":
    response = requests.get(url + request_path, headers=headers)
  elif method == "POST":
    response = requests.post(url + request_path, headers=headers, data=body)
  return response

def send_request_get(api_key, secret_key, access_passphrase, method, request_path, query_string):
  timestamp = str(int(time.time() * 1000))
  signature = generate_signature_get(secret_key, timestamp, method, request_path, query_string)

  headers = {
        "ACCESS-KEY": api_key,
        "ACCESS-SIGN": signature,
        "ACCESS-TIMESTAMP": timestamp,
        "ACCESS-PASSPHRASE": access_passphrase,
        "Content-Type": "application/json",
        "locale": "en-US"
  }

  url = "https://api-contract.weex.com/"
  if method == "GET":
    response = requests.get(url + request_path+query_string, headers=headers)
  return response

def get():
    request_path = "/capi/v2/account/position/singlePosition"
    query_string = '?symbol=cmt_btcusdt'
    response = send_request_get(api_key, secret_key, access_passphrase, "GET", request_path, query_string)
    print(response.status_code)
    print(response.text)

def post():
    request_path = "/capi/v2/order/placeOrder"
    body = {
	"symbol": "cmt_btcusdt",
	"client_oid": "71557515757447",
	"size": "0.01",
	"type": "1",
	"order_type": "0",
	"match_price": "1",
	"price": "80000"}
    query_string = ""
    response = send_request_post(api_key, secret_key, access_passphrase, "POST", request_path, query_string, body)
    print(response.status_code)
    print(response.text)

if __name__ == '__main__':
    get()
    post()
```

## Request Processing

All requests are based on the HTTPS protocol. The Content-Type in the request headers must be set to 'application/json'.

### Request Flow

1. **Request parameters**: Parameter encapsulation according to endpoint request parameter specification
2. **Submit request**: Submit the encapsulated parameters to the server via GET/POST
3. **Server response**: The server first performs security checks on the request data, and after passing the check, returns the response data to the user in JSON format based on the operation logic
4. **Data processing**: Process the server response data

## Response Codes

### Success

HTTP 200 status code indicates success and may contain content. Response content (if any) will be included in the returned data.

### Common Error Codes

- **400 Bad Request** – Invalid request format
- **401 Unauthorized** – Invalid API Key
- **403 Forbidden** – You do not have access to the requested resource
- **404 Not Found** – No requests found
- **429 Too Many Requests** – Rate limit exceeded
- **500 Internal Server Error** – We had a problem with our server

Failed responses include error descriptions in the body.
