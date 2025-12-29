# Get History Plan Orders

## Endpoint

`GET /capi/v2/order/historyPlan`

## Weight

**IP**: 5  
**UID**: 10

## Request Parameters

| Parameter    | Type    | Required? | Description                                                                        |
| ------------ | ------- | --------- | ---------------------------------------------------------------------------------- |
| symbol       | String  | Yes       | Trading pair                                                                       |
| startTime    | Long    | No        | Start time Unix millisecond timestamp                                              |
| endTime      | Long    | No        | End time Unix millisecond timestamp                                                |
| delegateType | Integer | No        | Order type: `1` = Open long, `2` = Open short, `3` = Close long, `4` = Close short |
| pageSize     | Integer | No        | Items per page, ranging from 1 to 100, default is 100                              |

## Request Example

```bash
curl "https://api-contract.weex.com/capi/v2/order/historyPlan?symbol=cmt_bchusdt&delegateType=2&startTime=1742213127794&endTime=1742213506548" \
  -H "ACCESS-KEY:*******" \
  -H "ACCESS-SIGN:*******" \
  -H "ACCESS-PASSPHRASE:*****" \
  -H "ACCESS-TIMESTAMP:1659076670000" \
  -H "locale:zh-CN" \
  -H "Content-Type: application/json"
```

## Response Parameters

| Parameter                    | Type    | Description                                                                                                                                                                                                                                                                            |
| ---------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| list                         | Array   | List of orders                                                                                                                                                                                                                                                                         |
| list[].symbol                | String  | Trading pair                                                                                                                                                                                                                                                                           |
| list[].size                  | String  | Order quantity                                                                                                                                                                                                                                                                         |
| list[].client_oid            | String  | Client identifier                                                                                                                                                                                                                                                                      |
| list[].createTime            | String  | Creation time Unix millisecond timestamp                                                                                                                                                                                                                                               |
| list[].filled_qty            | String  | Filled quantity                                                                                                                                                                                                                                                                        |
| list[].fee                   | String  | Transaction fee                                                                                                                                                                                                                                                                        |
| list[].order_id              | String  | Order ID                                                                                                                                                                                                                                                                               |
| list[].price                 | String  | Order price                                                                                                                                                                                                                                                                            |
| list[].price_avg             | String  | Average filled price                                                                                                                                                                                                                                                                   |
| list[].status                | String  | Order status: `-1` = Canceled, `0` = Pending, `1` = Partially filled, `2` = Filled                                                                                                                                                                                                     |
| list[].type                  | String  | Order Type: `1` = Open long, `2` = Open short, `3` = Close long, `4` = Close short, `5` = Partial close long, `6` = Partial close short, `7` = Auto-deleveraging (close long), `8` = Auto-deleveraging (close short), `9` = Liquidation (close long), `10` = Liquidation (close short) |
| list[].order_type            | String  | Order type: `0` = Normal order, `1` = Post-only, `2` = Fill-Or-Kill (FOK) order, `3` = Immediate-Or-Cancel (IOC) order                                                                                                                                                                 |
| list[].totalProfits          | String  | Total PnL                                                                                                                                                                                                                                                                              |
| list[].triggerPrice          | String  | Trigger price                                                                                                                                                                                                                                                                          |
| list[].triggerPriceType      | String  | Trigger price type                                                                                                                                                                                                                                                                     |
| list[].triggerTime           | String  | Trigger time Unix millisecond timestamp                                                                                                                                                                                                                                                |
| list[].presetTakeProfitPrice | String  | Preset take-profit price                                                                                                                                                                                                                                                               |
| list[].presetStopLossPrice   | String  | Preset stop-loss price                                                                                                                                                                                                                                                                 |
| nextPage                     | Boolean | Whether there is a next page                                                                                                                                                                                                                                                           |

## Response Example

```json
{
  "list": [
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
      "triggerPriceType": "",
      "triggerTime": "1742213506548",
      "presetTakeProfitPrice": null,
      "presetStopLossPrice": null
    }
  ],
  "nextPage": false
}
```
