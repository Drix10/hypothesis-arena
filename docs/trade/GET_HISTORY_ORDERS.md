# Get History Orders

## Endpoint

`GET /capi/v2/order/history`

## Weight

**IP**: 10  
**UID**: 10

## Request Parameters

| Parameter  | Type    | Required? | Description                                                                    |
| ---------- | ------- | --------- | ------------------------------------------------------------------------------ |
| symbol     | String  | No        | Trading pair                                                                   |
| pageSize   | Integer | No        | Items per page                                                                 |
| createDate | Long    | No        | Creation time (must be ≤ 90 and cannot be negative) Unix millisecond timestamp |

## Request Example

```bash
curl "https://api-contract.weex.com/capi/v2/order/history?symbol=cmt_bchusdt&pageSize=10&createDate=1742213506548" \
  -H "ACCESS-KEY:*******" \
  -H "ACCESS-SIGN:*******" \
  -H "ACCESS-PASSPHRASE:*****" \
  -H "ACCESS-TIMESTAMP:1659076670000" \
  -H "locale:zh-CN" \
  -H "Content-Type: application/json"
```

## Response Parameters

| Parameter             | Type    | Description                                                                                                                                                                                                             |
| --------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| symbol                | String  | Trading pair                                                                                                                                                                                                            |
| size                  | String  | Order amount                                                                                                                                                                                                            |
| client_oid            | String  | Client identifier                                                                                                                                                                                                       |
| createTime            | String  | Creation time Unix millisecond timestamp                                                                                                                                                                                |
| filled_qty            | String  | Filled quantity                                                                                                                                                                                                         |
| fee                   | String  | Transaction fee                                                                                                                                                                                                         |
| order_id              | String  | Order ID                                                                                                                                                                                                                |
| price                 | String  | Order price                                                                                                                                                                                                             |
| price_avg             | String  | Average filled price                                                                                                                                                                                                    |
| status                | String  | Order status: `pending`, `open`, `filled`, `canceling`, `canceled`, `untriggered`                                                                                                                                       |
| type                  | String  | Order type: `open_long`, `open_short`, `close_long`, `close_short`, `offset_liquidate_long`, `offset_liquidate_short`, `agreement_close_long`, `agreement_close_short`, `burst_liquidate_long`, `burst_liquidate_short` |
| order_type            | String  | Order type: `normal`, `postOnly`, `fok`, `ioc`                                                                                                                                                                          |
| totalProfits          | String  | Total PnL                                                                                                                                                                                                               |
| contracts             | Integer | Order size in contract units                                                                                                                                                                                            |
| filledQtyContracts    | Integer | Filled quantity in contract units                                                                                                                                                                                       |
| presetTakeProfitPrice | String  | Preset take-profit price                                                                                                                                                                                                |
| presetStopLossPrice   | String  | Preset stop-loss price                                                                                                                                                                                                  |

### Order Status Values

- **pending**: The order has been submitted for matching, but the result has not been processed yet.
- **open**: The order has been processed by the matching engine (order placed), and may have been partially filled.
- **filled**: The order has been completely filled [final state].
- **canceling**: The order is being canceled.
- **canceled**: The order has been canceled. It may have been partially filled. [final state].
- **untriggered**: The conditional order has not been triggered yet.

### Order Type Values

- **open_long**: Open long
- **open_short**: Open short
- **close_long**: Close long
- **close_short**: Close short
- **offset_liquidate_long**: Reduce position, close long
- **offset_liquidate_short**: Reduce position, close short
- **agreement_close_long**: Agreement close long
- **agreement_close_short**: Agreement close short
- **burst_liquidate_long**: Liquidation close long
- **burst_liquidate_short**: Liquidation close short

### Order Type (order_type) Values

- **normal**: Regular limit order, valid until canceled.
- **postOnly**: Maker-only order
- **fok**: Fill or kill, must be completely filled or canceled immediately.
- **ioc**: Immediate or cancel, fill as much as possible and cancel the remaining.

## Response Example

```json
[
  {
    "symbol": "cmt_btcusdt",
    "size": "0.010000",
    "client_oid": "1478527825782587",
    "createTime": "1764505776340",
    "filled_qty": "0.010000",
    "fee": "0.54731220",
    "order_id": "689987235725968026",
    "price": "0.0",
    "price_avg": "91218.7",
    "status": "filled",
    "type": "open_long",
    "order_type": "ioc",
    "totalProfits": "0",
    "contracts": 10000,
    "filledQtyContracts": 10000,
    "presetTakeProfitPrice": null,
    "presetStopLossPrice": null
  }
]
```
