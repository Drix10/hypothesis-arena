# Get Current Orders

## Endpoint

`GET /capi/v2/order/current`

## Weight

**IP**: 2  
**UID**: 2

## Request Parameters

| Parameter | Type    | Required? | Description                                                         |
| --------- | ------- | --------- | ------------------------------------------------------------------- |
| symbol    | String  | No        | Trading pair                                                        |
| orderId   | Long    | No        | Order ID                                                            |
| startTime | Long    | No        | The record start time for the query Unix millisecond timestamp      |
| endTime   | Long    | No        | The end time of the record for the query Unix millisecond timestamp |
| limit     | Integer | No        | Limit number default 100 max 100                                    |
| page      | Integer | No        | Page number default 0                                               |

## Request Example

```bash
curl "https://api-contract.weex.com/capi/v2/order/current?symbol=cmt_bchusdt" \
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
    "client_oid": "175287228528278",
    "createTime": "1764505828770",
    "filled_qty": "0",
    "fee": "0",
    "order_id": "689987455633326746",
    "price": "88888.0",
    "price_avg": "0",
    "status": "open",
    "type": "open_long",
    "order_type": "normal",
    "totalProfits": "0",
    "contracts": 10000,
    "filledQtyContracts": 0,
    "presetTakeProfitPrice": null,
    "presetStopLossPrice": null
  }
]
```
