# WebSocket API

## Overview

WebSocket is a new protocol in HTML5 that enables full-duplex communication between clients and servers, allowing rapid bidirectional data transmission. Through a simple handshake, a connection can be established between client and server, enabling the server to actively push information to the client based on business rules.

### Advantages

- Small header size (~2 bytes) during data transmission between client and server
- Both client and server can actively send data
- Eliminates the need for repeated TCP connection setup/teardown, conserving bandwidth and server resources
- Strongly recommended for developers to obtain market data, order book depth, and other information

## Domain

| WebSocket API                              | Recommended Use                  |
| ------------------------------------------ | -------------------------------- |
| `wss://ws-contract.weex.com/v2/ws/public`  | Primary domain, public channels  |
| `wss://ws-contract.weex.com/v2/ws/private` | Primary domain, private channels |

## Connection

### Connection Specifications

- Connection limit: 300 connection requests/IP/5 minutes, maximum 100 concurrent connections per IP
- Subscription limit: 240 operations/hour/connection, maximum 100 channels per connection

### Recommendations

To maintain stable and effective connections, we recommend:

After successful WebSocket connection establishment, the server will periodically send Ping messages to the client in the format:

```json
{
  "event": "ping",
  "time": "1693208170000"
}
```

Where "time" represents the server's timestamp. Upon receiving this message, the client should respond with a Pong message:

```json
{
  "event": "pong",
  "time": "1693208170000"
}
```

The server will actively terminate connections that fail to respond more than 5 times.

## Header Authentication for Private Channels

### Required Headers

- **User-Agent**: Client identification
- **ACCESS-KEY**: Unique identifier for API user authentication (requires application)
- **ACCESS-PASSPHRASE**: Password for the API Key
- **ACCESS-TIMESTAMP**: Unix Epoch timestamp in milliseconds (expires after 30 seconds, must match signature timestamp)
- **ACCESS-SIGN**: Signature string generated as follows

### Signature Generation

The message (string to be signed) consists of: `timestamp + requestPath`

Example timestamp (in milliseconds):

```javascript
const timestamp = "" + Date.now();
```

Where `requestPath` is `/v2/ws/private`

### Signature Generation Process

1. Encrypt the message string using HMAC SHA256 with the secret key:

   ```
   Signature = hmac_sha256(secretkey, Message)
   ```

2. Encode the Signature using Base64:
   ```
   Signature = base64.encode(Signature)
   ```

## Subscription

### Subscription Specification

```json
{
  "event": "subscribe",
  "channel": "channel_name"
}
```

## Unsubscription

### Unsubscription Specification

```json
{
  "event": "unsubscribe",
  "channel": "channel_name"
}
```
