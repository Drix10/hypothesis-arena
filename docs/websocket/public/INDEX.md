# Public WebSocket Channels

Real-time market data channels (no authentication required).

## Channels

| Channel                                            | Description           | Update Frequency |
| -------------------------------------------------- | --------------------- | ---------------- |
| [MARKET_CHANNEL.md](MARKET_CHANNEL.md)             | Real-time ticker data | 100-300ms        |
| [CANDLESTICK_CHANNEL.md](CANDLESTICK_CHANNEL.md)   | K-line data           | Per candle close |
| [DEPTH_CHANNEL.md](DEPTH_CHANNEL.md)               | Order book depth      | Real-time        |
| [PUBLIC_TRADE_CHANNEL.md](PUBLIC_TRADE_CHANNEL.md) | Platform trades       | Real-time        |

## Connection

- **URL**: `wss://ws-contract.weex.com/v2/ws/public`
- **Authentication**: Not required
- **Header**: User-Agent recommended

## Market Channel

Subscribe to real-time ticker data for a trading pair.

```json
{
  "event": "subscribe",
  "channel": "ticker.cmt_btcusdt"
}
```

**Data includes:**

- Latest price
- 24h price change
- 24h trading volume
- Best bid/ask prices
- Mark price

## Candlestick Channel

Subscribe to K-line data with configurable intervals.

```json
{
  "event": "subscribe",
  "channel": "kline.LAST_PRICE.cmt_btcusdt.MINUTE_1"
}
```

**Intervals:**

- `MINUTE_1`, `MINUTE_5`, `MINUTE_15`, `MINUTE_30`
- `HOUR_1`, `HOUR_2`, `HOUR_4`, `HOUR_6`, `HOUR_8`, `HOUR_12`
- `DAY_1`, `WEEK_1`, `MONTH_1`

**Price Types:**

- `LAST_PRICE` - Latest market price
- `MARK_PRICE` - Mark price

## Depth Channel

Subscribe to order book depth updates.

```json
{
  "event": "subscribe",
  "channel": "depth.cmt_btcusdt.15"
}
```

**Depth Levels:**

- `15` - 15 levels
- `200` - 200 levels

**Data includes:**

- Bid/ask prices and quantities
- Order book version
- Depth type (SNAPSHOT or CHANGED)

## Public Trade Channel

Subscribe to platform trade information.

```json
{
  "event": "subscribe",
  "channel": "trades.cmt_btcusdt"
}
```

**Data includes:**

- Trade price
- Trade quantity
- Trade amount
- Buyer/seller information
- Trade time

## Usage Examples

### Subscribe to Multiple Channels

```json
{
  "event": "subscribe",
  "channel": "ticker.cmt_btcusdt"
}
```

Then:

```json
{
  "event": "subscribe",
  "channel": "kline.LAST_PRICE.cmt_btcusdt.MINUTE_5"
}
```

### Handle Ping/Pong

Receive:

```json
{
  "event": "ping",
  "time": "1693208170000"
}
```

Send:

```json
{
  "event": "pong",
  "time": "1693208170000"
}
```

### Unsubscribe

```json
{
  "event": "unsubscribe",
  "channel": "ticker.cmt_btcusdt"
}
```

## Response Format

### Subscription Confirmation

```json
{
  "event": "subscribed",
  "channel": "ticker.cmt_btcusdt"
}
```

### Data Push

```json
{
  "event": "payload",
  "channel": "ticker.cmt_btcusdt",
  "data": [
    {
      "symbol": "cmt_btcusdt",
      "lastPrice": "102623.9",
      "markPrice": "102623.9",
      "priceChange": "-2055.6",
      "priceChangePercent": "-0.019637",
      "trades": "28941",
      "size": "176145.66489",
      "value": "18115688543.1",
      "high": "104692.2",
      "low": "100709.6"
    }
  ]
}
```

## Supported Trading Pairs

- `cmt_btcusdt`
- `cmt_ethusdt`
- `cmt_solusdt`
- `cmt_dogeusdt`
- `cmt_xrpusdt`
- `cmt_adausdt`
- `cmt_bnbusdt`
- `cmt_ltcusdt`

## Connection Limits

- 300 connection requests/IP/5 minutes
- Maximum 100 concurrent connections per IP
- 240 operations/hour/connection
- Maximum 100 channels per connection

## Best Practices

1. **Maintain Connection**: Respond to Ping messages within 5 seconds
2. **Batch Subscriptions**: Subscribe to multiple channels in one connection
3. **Handle Reconnection**: Implement exponential backoff for reconnection
4. **Monitor Heartbeat**: Track Ping/Pong to detect connection issues
5. **Validate Data**: Verify data integrity and timestamps

## Error Handling

Refer to [../../ERROR_CODES.md](../../ERROR_CODES.md) for error codes.

Common issues:

- Invalid channel name
- Connection timeout
- Rate limit exceeded
- Network disconnection
