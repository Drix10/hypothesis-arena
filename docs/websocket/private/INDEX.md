# Private WebSocket Channels

Real-time account and trading data channels (authentication required).

## Channels

| Channel                                    | Description                    | Update Trigger   |
| ------------------------------------------ | ------------------------------ | ---------------- |
| [ACCOUNT_CHANNEL.md](ACCOUNT_CHANNEL.md)   | Account balance and collateral | Balance changes  |
| [POSITION_CHANNEL.md](POSITION_CHANNEL.md) | Position updates               | Position changes |
| [FILL_CHANNEL.md](FILL_CHANNEL.md)         | Trade execution details        | Order fills      |
| [ORDER_CHANNEL.md](ORDER_CHANNEL.md)       | Order status updates           | Order changes    |

## Connection

- **URL**: `wss://ws-contract.weex.com/v2/ws/private`
- **Authentication**: Required
- **Headers**: ACCESS-KEY, ACCESS-SIGN, ACCESS-TIMESTAMP, ACCESS-PASSPHRASE

## Authentication

### Required Headers

- **User-Agent**: Client identification
- **ACCESS-KEY**: Your API key
- **ACCESS-PASSPHRASE**: Your API passphrase
- **ACCESS-TIMESTAMP**: Unix millisecond timestamp (expires after 30 seconds)
- **ACCESS-SIGN**: HMAC SHA256 signature

### Signature Generation

Message: `timestamp + /v2/ws/private`

```
Signature = hmac_sha256(secretkey, Message)
Signature = base64.encode(Signature)
```

See [../../SIGNATURE.md](../../SIGNATURE.md) for detailed instructions.

## Account Channel

Subscribe to account balance and collateral updates.

```json
{
  "event": "subscribe",
  "channel": "account"
}
```

**Data includes:**

- Collateral amount
- Pending deposits/withdrawals
- Cumulative statistics
- Liquidation status

**Triggers:**

- Deposit/withdrawal
- Margin adjustment
- Position opening/closing
- Funding fee settlement

## Position Channel

Subscribe to position updates.

```json
{
  "event": "subscribe",
  "channel": "positions"
}
```

**Data includes:**

- Position size and direction
- Leverage and margin
- Opening/closing fees
- Funding fees
- Unrealized PnL

**Triggers:**

- Position opened/closed
- Leverage changed
- Margin adjusted
- Funding fee settled

## Fill Channel

Subscribe to trade execution details.

```json
{
  "event": "subscribe",
  "channel": "fill"
}
```

**Data includes:**

- Trade price and quantity
- Trade fees
- Realized PnL
- Execution direction (MAKER/TAKER)

**Triggers:**

- Order partially filled
- Order completely filled
- Liquidation trade

## Order Channel

Subscribe to order status updates.

```json
{
  "event": "subscribe",
  "channel": "orders"
}
```

**Data includes:**

- Order status
- Filled quantity and value
- Order fees
- Trigger information
- Cumulative statistics

**Triggers:**

- Order placed
- Order partially filled
- Order completely filled
- Order canceled
- Trigger order triggered

## Usage Examples

### Subscribe to Account Updates

```json
{
  "event": "subscribe",
  "channel": "account"
}
```

### Subscribe to Position Updates

```json
{
  "event": "subscribe",
  "channel": "positions"
}
```

### Subscribe to Order Updates

```json
{
  "event": "subscribe",
  "channel": "orders"
}
```

### Subscribe to Fill Updates

```json
{
  "event": "subscribe",
  "channel": "fill"
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
  "channel": "account"
}
```

## Response Format

### Subscription Confirmation

```json
{
  "event": "subscribed",
  "channel": "account"
}
```

### Data Push

```json
{
  "type": "trade-event",
  "channel": "account",
  "event": "payload",
  "msg": {
    "msgEvent": "PositionFundingSettle",
    "version": 46571,
    "data": {
      "collateral": []
    },
    "time": 1747188961302
  }
}
```

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
6. **Secure Credentials**: Never expose API keys or secrets

## Error Handling

Refer to [../../ERROR_CODES.md](../../ERROR_CODES.md) for error codes.

Common issues:

- `40001` - Header "ACCESS_KEY" is required
- `40002` - Header "ACCESS_SIGN" is required
- `40012` - Incorrect API key/Passphrase
- Connection timeout
- Rate limit exceeded
- Network disconnection

## Data Consistency

- All updates include version numbers for consistency checking
- Timestamps are in Unix milliseconds
- Data is pushed in real-time as events occur
- Reconnection may require resubscription

## Integration Tips

1. **Combine Channels**: Use multiple channels for complete trading data
2. **Cache Data**: Store latest state locally for quick access
3. **Event Processing**: Process events in order of version numbers
4. **Error Recovery**: Implement retry logic for failed operations
5. **Monitoring**: Log all events for debugging and analysis
