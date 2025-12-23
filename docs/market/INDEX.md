# Market API Endpoints

Public market data endpoints (no authentication required). All endpoints use IP-based rate limiting.

## Endpoints

| Endpoint                                                           | Method | Weight | Description                         |
| ------------------------------------------------------------------ | ------ | ------ | ----------------------------------- |
| [GET_SERVER_TIME.md](GET_SERVER_TIME.md)                           | GET    | 1      | Get current server time             |
| [GET_FUTURES_INFORMATION.md](GET_FUTURES_INFORMATION.md)           | GET    | 10     | Get futures contract specifications |
| [GET_ORDERBOOK_DEPTH.md](GET_ORDERBOOK_DEPTH.md)                   | GET    | 1      | Get order book depth data           |
| [GET_ALL_TICKER.md](GET_ALL_TICKER.md)                             | GET    | 40     | Get all trading pairs ticker data   |
| [GET_SINGLE_TICKER.md](GET_SINGLE_TICKER.md)                       | GET    | 1      | Get single trading pair ticker      |
| [GET_TRADES.md](GET_TRADES.md)                                     | GET    | 5      | Get recent trades                   |
| [GET_HISTORICAL_CANDLESTICK.md](GET_HISTORICAL_CANDLESTICK.md)     | GET    | 5      | Get historical K-line data          |
| [GET_CANDLESTICK_DATA.md](GET_CANDLESTICK_DATA.md)                 | GET    | 1      | Get current K-line data             |
| [GET_CRYPTOCURRENCY_INDEX.md](GET_CRYPTOCURRENCY_INDEX.md)         | GET    | 1      | Get cryptocurrency index            |
| [GET_OPEN_INTEREST.md](GET_OPEN_INTEREST.md)                       | GET    | 2      | Get open interest data              |
| [GET_NEXT_FUNDING_TIME.md](GET_NEXT_FUNDING_TIME.md)               | GET    | 1      | Get next funding settlement time    |
| [GET_HISTORICAL_FUNDING_RATES.md](GET_HISTORICAL_FUNDING_RATES.md) | GET    | 5      | Get historical funding rates        |
| [GET_CURRENT_FUNDING_RATE.md](GET_CURRENT_FUNDING_RATE.md)         | GET    | 1      | Get current funding rate            |

## Quick Links

- **Base URL**: `https://api-contract.weex.com/`
- **Rate Limit**: 1000 requests per 10 seconds per IP
- **Authentication**: Not required

## Common Parameters

### Trading Pair Format

- Format: `cmt_{symbol}usdt`
- Examples: `cmt_btcusdt`, `cmt_ethusdt`, `cmt_solusdt`

### Candlestick Intervals

- `1m`, `5m`, `15m`, `30m`, `1h`, `4h`, `12h`, `1d`, `1w`

### Price Types

- `LAST` - Latest market price
- `MARK` - Mark price
- `INDEX` - Index price

## Usage Examples

### Get Server Time

```bash
curl "https://api-contract.weex.com/capi/v2/market/time"
```

### Get Ticker Data

```bash
curl "https://api-contract.weex.com/capi/v2/market/ticker?symbol=cmt_btcusdt"
```

### Get K-line Data

```bash
curl "https://api-contract.weex.com/capi/v2/market/candles?symbol=cmt_btcusdt&granularity=1h"
```

### Get Order Book Depth

```bash
curl "https://api-contract.weex.com/capi/v2/market/depth?symbol=cmt_btcusdt&limit=15"
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

- `40020` - Parameter is invalid
- `40019` - Parameter cannot be empty
- `50005` - Order does not exist
