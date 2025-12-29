# Get Current Plan Orders

## Endpoint

`GET /capi/v2/order/currentPlan`

## Weight

**IP**: 3  
**UID**: 3

## Request Parameters

| Parameter | Type    | Required? | Description                                                             |
| --------- | ------- | --------- | ----------------------------------------------------------------------- |
| symbol    | String  | No        | Trading pair                                                            |
| orderId   | Long    | No        | Order ID (The filter will be bypassed if invalid characters are input.) |
| startTime | Long    | No        | The record start time for the query Unix millisecond timestamp          |
| endTime   | Long    | No        | The end time of the record for the query Unix millisecond timestamp     |
| limit     | Integer | No        | Limit number default 100 max 100                                        |
| page      | Integer | No        | Page number default 0                                                   |

## Request Example

```bash
curl "https://api-contract.weex.com/capi/v2/order/currentPlan?symbol=cmt_bchusdt" \
  -H "ACCESS-KEY:*******" \
  -H "ACCESS-SIGN:*******" \
  -H "ACCESS-PASSPHRASE:*****" \
  -H "ACCESS-TIMESTAMP:1659076670000" \
  -H "locale:zh-CN" \
  -H "Content-Type: application/json"
```

## Response Parameters

| Parameter             | Type   | Description                                                                                                                                                                                                                                                                            |
| --------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| symbol                | String | Trading pair                                                                                                                                                                                                                                                                           |
| size                  | String | Order amount                                                                                                                                                                                                                                                                           |
| client_oid            | String | Client identifier                                                                                                                                                                                                                                                                      |
| createTime            | String | Creation time Unix millisecond timestamp                                                                                                                                                                                                                                               |
| filled_qty            | String | Filled quantity                                                                                                                                                                                                                                                                        |
| fee                   | String | Transaction fee                                                                                                                                                                                                                                                                        |
| order_id              | String | Order ID                                                                                                                                                                                                                                                                               |
| price                 | String | Order price                                                                                                                                                                                                                                                                            |
| price_avg             | String | Average filled price                                                                                                                                                                                                                                                                   |
| status                | String | Order status: `-1` = Canceled, `0` = Pending, `1` = Partially filled, `2` = Filled                                                                                                                                                                                                     |
| type                  | String | Order Type: `1` = Open long, `2` = Open short, `3` = Close long, `4` = Close short, `5` = Partial close long, `6` = Partial close short, `7` = Auto-deleveraging (close long), `8` = Auto-deleveraging (close short), `9` = Liquidation (close long), `10` = Liquidation (close short) |
| order_type            | String | Order type: `0` = Normal order, `1` = Post-only, `2` = Fill-Or-Kill (FOK) order, `3` = Immediate-Or-Cancel (IOC) order                                                                                                                                                                 |
| totalProfits          | String | Total PnL                                                                                                                                                                                                                                                                              |
| triggerPrice          | String | Trigger price                                                                                                                                                                                                                                                                          |
| triggerPriceType      | String | Trigger price type                                                                                                                                                                                                                                                                     |
| triggerTime           | String | Trigger time Unix millisecond timestamp                                                                                                                                                                                                                                                |
| presetTakeProfitPrice | String | Preset take-profit price                                                                                                                                                                                                                                                               |
| presetStopLossPrice   | String | Preset stop-loss price                                                                                                                                                                                                                                                                 |

## Response Example

```json
[
  {
    "symbol": "cmt_btcusdt",
    "size": "1",
    "client_oid": "1234567890",
    "createTime": "1742213506548",
    "filled_qty": "0.5",
    "fee": "0.01",
    "order_id": "461234125",
    "price": "50000.00",
    "price_avg": "49900.00",
    "status": "1",
    "type": "1",
    "order_type": "0",
    "totalProfits": "200.00",
    "triggerPrice": "48000.00",
    "triggerPriceType": "LIMIT",
    "triggerTime": "1742213506548",
    "presetTakeProfitPrice": null,
    "presetStopLossPrice": null
  }
]
```
