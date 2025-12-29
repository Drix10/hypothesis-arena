# Trading API Endpoints

Private trading endpoints for order management and execution (authentication required). All endpoints use both IP and UID-based rate limiting.

## Endpoints

| Endpoint                                                 | Method | Weight (IP/UID) | Description                       |
| -------------------------------------------------------- | ------ | --------------- | --------------------------------- |
| [PLACE_ORDER.md](PLACE_ORDER.md)                         | POST   | 2/5             | Place a single order              |
| [BATCH_ORDERS.md](BATCH_ORDERS.md)                       | POST   | 5/10            | Place up to 20 orders in batch    |
| [CANCEL_ORDER.md](CANCEL_ORDER.md)                       | POST   | 2/3             | Cancel a single order             |
| [BATCH_CANCEL_ORDERS.md](BATCH_CANCEL_ORDERS.md)         | POST   | 5/10            | Cancel multiple orders in batch   |
| [GET_ORDER_INFO.md](GET_ORDER_INFO.md)                   | GET    | 2/2             | Get order details by ID           |
| [GET_HISTORY_ORDERS.md](GET_HISTORY_ORDERS.md)           | GET    | 10/10           | Get historical orders             |
| [GET_CURRENT_ORDERS.md](GET_CURRENT_ORDERS.md)           | GET    | 2/2             | Get current open orders           |
| [GET_FILLS.md](GET_FILLS.md)                             | GET    | 5/5             | Get trade fills/executions        |
| [PLACE_TRIGGER_ORDER.md](PLACE_TRIGGER_ORDER.md)         | POST   | 2/5             | Place conditional/trigger order   |
| [CANCEL_TRIGGER_ORDER.md](CANCEL_TRIGGER_ORDER.md)       | POST   | 2/3             | Cancel trigger order              |
| [GET_CURRENT_PLAN_ORDERS.md](GET_CURRENT_PLAN_ORDERS.md) | GET    | 3/3             | Get current trigger orders        |
| [GET_HISTORY_PLAN_ORDERS.md](GET_HISTORY_PLAN_ORDERS.md) | GET    | 5/10            | Get historical trigger orders     |
| [CLOSE_ALL_POSITIONS.md](CLOSE_ALL_POSITIONS.md)         | POST   | 40/50           | Close all positions at market     |
| [CANCEL_ALL_ORDERS.md](CANCEL_ALL_ORDERS.md)             | POST   | 40/50           | Cancel all orders                 |
| [PLACE_TP_SL_ORDER.md](PLACE_TP_SL_ORDER.md)             | POST   | 2/5             | Place take-profit/stop-loss order |
| [MODIFY_TP_SL_ORDER.md](MODIFY_TP_SL_ORDER.md)           | POST   | 2/5             | Modify TP/SL order                |
| [UPLOAD_AI_LOG.md](UPLOAD_AI_LOG.md)                     | POST   | 1/1             | Upload AI log for compliance      |

## Quick Links

- **Base URL**: `https://api-contract.weex.com/`
- **Rate Limit**: 1000 requests per 10 seconds (IP), 1000 per 10 seconds (UID)
- **Special Limit**: Place/Cancel Order endpoints limited to 10 requests per second
- **Authentication**: Required (API Key, Signature, Timestamp, Passphrase)

## Authentication

All trading endpoints require the following headers:

- `ACCESS-KEY`: Your API key
- `ACCESS-SIGN`: HMAC SHA256 signature
- `ACCESS-TIMESTAMP`: Unix millisecond timestamp
- `ACCESS-PASSPHRASE`: Your API passphrase

See [../SIGNATURE.md](../SIGNATURE.md) for signature generation details.

## Common Parameters

### Order Types

- `1` - Open long
- `2` - Open short
- `3` - Close long
- `4` - Close short

### Order Execution Types

- `0` - Normal (limit order)
- `1` - Post-Only (maker-only)
- `2` - Fill-Or-Kill (FOK)
- `3` - Immediate-Or-Cancel (IOC)

### Price Types

- `0` - Limit price
- `1` - Market price

### Order Status

- `pending` - Submitted for matching
- `open` - Placed, may be partially filled
- `filled` - Completely filled [final]
- `canceling` - Being canceled
- `canceled` - Canceled, may be partially filled [final]
- `untriggered` - Conditional order not triggered

### Margin Modes

- `1` - Cross Mode
- `3` - Isolated Mode

## Usage Examples

### Place Order

```bash
curl -X POST "https://api-contract.weex.com/capi/v2/order/placeOrder" \
  -H "ACCESS-KEY: your_key" \
  -H "ACCESS-SIGN: signature" \
  -H "ACCESS-TIMESTAMP: timestamp" \
  -H "ACCESS-PASSPHRASE: passphrase" \
  -d '{
    "symbol": "cmt_btcusdt",
    "client_oid": "order123",
    "size": "0.01",
    "type": "1",
    "order_type": "0",
    "match_price": "0",
    "price": "50000"
  }'
```

### Cancel Order

```bash
curl -X POST "https://api-contract.weex.com/capi/v2/order/cancel_order" \
  -H "ACCESS-KEY: your_key" \
  -H "ACCESS-SIGN: signature" \
  -H "ACCESS-TIMESTAMP: timestamp" \
  -H "ACCESS-PASSPHRASE: passphrase" \
  -d '{"orderId":"596471064624628269"}'
```

### Get Current Orders

```bash
curl "https://api-contract.weex.com/capi/v2/order/current?symbol=cmt_btcusdt" \
  -H "ACCESS-KEY: your_key" \
  -H "ACCESS-SIGN: signature" \
  -H "ACCESS-TIMESTAMP: timestamp" \
  -H "ACCESS-PASSPHRASE: passphrase"
```

### Place TP/SL Order

```bash
curl -X POST "https://api-contract.weex.com/capi/v2/order/placeTpSlOrder" \
  -H "ACCESS-KEY: your_key" \
  -H "ACCESS-SIGN: signature" \
  -H "ACCESS-TIMESTAMP: timestamp" \
  -H "ACCESS-PASSPHRASE: passphrase" \
  -d '{
    "symbol": "cmt_btcusdt",
    "clientOrderId": "tp_sl_123",
    "planType": "profit_plan",
    "triggerPrice": "55000",
    "executePrice": "0",
    "size": "0.01",
    "positionSide": "long"
  }'
```

## Response Format

All endpoints return JSON responses with the following structure:

```json
{
  "data": {},
  "code": "00000",
  "msg": "success"
}
```

## Error Handling

Refer to [../ERROR_CODES.md](../ERROR_CODES.md) for complete error code reference.

Common errors:

- `40001` - Header "ACCESS_KEY" is required
- `40002` - Header "ACCESS_SIGN" is required
- `40012` - Incorrect API key/Passphrase
- `40022` - Insufficient permissions for this operation
- `50005` - Order does not exist
- `50007` - Leverage cannot exceed the limit

## Order Management

### Batch Operations

- Batch Orders: Up to 20 orders per request
- Batch Cancel: Multiple orders by ID or client OID
- Close All Positions: Close all positions at market price
- Cancel All Orders: Cancel all orders (normal or trigger)

### Conditional Orders

- Trigger Orders: Execute when price reaches trigger level
- TP/SL Orders: Take-profit and stop-loss orders
- Modifiable: Update trigger price and execution price

### Order Tracking

- Client OID: Custom order identifier for idempotency
- Order ID: System-generated unique order identifier
- Status Tracking: Monitor order lifecycle from placement to completion
