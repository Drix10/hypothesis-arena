# WebSocket API

Real-time data streaming for market and account information.

## Overview

WebSocket enables full-duplex communication between client and server for rapid bidirectional data transmission. The server actively pushes information to clients based on subscriptions.

### Advantages

- Small header size (~2 bytes) during data transmission
- Both client and server can actively send data
- Eliminates repeated TCP connection setup/teardown
- Ideal for market data, order book depth, and real-time updates

## Connection Information

### Domains

- **Public**: `wss://ws-contract.weex.com/v2/ws/public`
- **Private**: `wss://ws-contract.weex.com/v2/ws/private`

### Connection Limits

- 300 connection requests/IP/5 minutes
- Maximum 100 concurrent connections per IP
- 240 operations/hour/connection
- Maximum 100 channels per connection

## Channels

### Public Channels - [public/INDEX.md](public/INDEX.md)

No authentication required. Real-time market data.

| Channel                                                | Description                         |
| ------------------------------------------------------ | ----------------------------------- |
| [Market Channel](public/MARKET_CHANNEL.md)             | Real-time ticker data               |
| [Candlestick Channel](public/CANDLESTICK_CHANNEL.md)   | K-line data with multiple intervals |
| [Depth Channel](public/DEPTH_CHANNEL.md)               | Order book depth updates            |
| [Public Trade Channel](public/PUBLIC_TRADE_CHANNEL.md) | Platform trade information          |

### Private Channels - [private/INDEX.md](private/INDEX.md)

Authentication required. Real-time account and trading data.

| Channel                                         | Description                            |
| ----------------------------------------------- | -------------------------------------- |
| [Account Channel](private/ACCOUNT_CHANNEL.md)   | Account balance and collateral updates |
| [Position Channel](private/POSITION_CHANNEL.md) | Position updates and changes           |
| [Fill Channel](private/FILL_CHANNEL.md)         | Trade execution details                |
| [Order Channel](private/ORDER_CHANNEL.md)       | Order status and updates               |

## Connection Management

### Ping/Pong

The server sends periodic Ping messages:

```json
{
  "event": "ping",
  "time": "1693208170000"
}
```

Respond with Pong:

```json
{
  "event": "pong",
  "time": "1693208170000"
}
```

Connections that fail to respond more than 5 times will be terminated.

## Subscription Management

### Subscribe

```json
{
  "event": "subscribe",
  "channel": "channel_name"
}
```

### Unsubscribe

```json
{
  "event": "unsubscribe",
  "channel": "channel_name"
}
```

## Authentication (Private Channels)

### Required Headers

- **User-Agent**: Client identification
- **ACCESS-KEY**: API key
- **ACCESS-PASSPHRASE**: API passphrase
- **ACCESS-TIMESTAMP**: Unix millisecond timestamp (expires after 30 seconds)
- **ACCESS-SIGN**: HMAC SHA256 signature

### Signature Generation

Message format: `timestamp + requestPath`

Where `requestPath` is `/v2/ws/private`

```
Signature = hmac_sha256(secretkey, Message)
Signature = base64.encode(Signature)
```

See [../SIGNATURE.md](../SIGNATURE.md) for detailed signature generation.

## Response Format

### Subscription Confirmation

```json
{
  "event": "subscribed",
  "channel": "channel_name"
}
```

### Data Push

```json
{
  "event": "payload",
  "channel": "channel_name",
  "data": []
}
```

## Usage Examples

### Subscribe to Market Ticker

```json
{
  "event": "subscribe",
  "channel": "ticker.cmt_btcusdt"
}
```

### Subscribe to K-line Data

```json
{
  "event": "subscribe",
  "channel": "kline.LAST_PRICE.cmt_btcusdt.MINUTE_1"
}
```

### Subscribe to Order Book Depth

```json
{
  "event": "subscribe",
  "channel": "depth.cmt_btcusdt.15"
}
```

### Subscribe to Account Updates (Private)

```json
{
  "event": "subscribe",
  "channel": "account"
}
```

### Subscribe to Position Updates (Private)

```json
{
  "event": "subscribe",
  "channel": "positions"
}
```

## Error Handling

Refer to [../ERROR_CODES.md](../ERROR_CODES.md) for error codes.

Common WebSocket errors:

- Connection timeout
- Invalid channel name
- Authentication failure
- Rate limit exceeded

## Best Practices

1. **Maintain Connection**: Respond to Ping messages promptly
2. **Batch Subscriptions**: Subscribe to multiple channels efficiently
3. **Handle Reconnection**: Implement reconnection logic with exponential backoff
4. **Monitor Heartbeat**: Track Ping/Pong to detect connection issues
5. **Validate Data**: Verify data integrity and timestamps
6. **Error Recovery**: Implement proper error handling and logging

## Channel-Specific Information

For detailed information about each channel, see:

- [public/INDEX.md](public/INDEX.md) - Public channel details
- [private/INDEX.md](private/INDEX.md) - Private channel details
- [INFO.md](INFO.md) - General WebSocket information
