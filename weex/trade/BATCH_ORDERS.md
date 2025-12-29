# Batch Orders

## Endpoint

`POST /capi/v2/order/batchOrders`

## Weight

**IP**: 5  
**UID**: 10

## Request Parameters

| Parameter     | Type    | Required? | Description                                                                                          |
| ------------- | ------- | --------- | ---------------------------------------------------------------------------------------------------- |
| symbol        | String  | Yes       | Trading pair                                                                                         |
| marginMode    | Integer | No        | Margin mode: `1` = Cross Mode, `3` = Isolated Mode. Default is 1 (Cross Mode)                        |
| orderDataList | List    | Yes       | Maximum batch processing limit of 20 orders, with the same structure as the futures placing endpoint |

### Order Data Structure

Each item in `orderDataList` should have the following structure:

| Parameter             | Type       | Required? | Description                                                                                                             |
| --------------------- | ---------- | --------- | ----------------------------------------------------------------------------------------------------------------------- |
| client_oid            | String     | Yes       | Custom order ID (no more than 40 characters)                                                                            |
| size                  | String     | Yes       | Order quantity (cannot be zero or negative)                                                                             |
| type                  | String     | Yes       | Order type: `1` = Open long, `2` = Open short, `3` = Close long, `4` = Close short                                      |
| order_type            | String     | Yes       | Order type: `0` = Normal, `1` = Post-Only, `2` = Fill-Or-Kill, `3` = Immediate Or Cancel                                |
| match_price           | String     | Yes       | Price type: `0` = Limit price, `1` = Market price                                                                       |
| price                 | String     | Yes       | Order price (this is required for limit orders, and its accuracy and step size follow the futures information endpoint) |
| presetTakeProfitPrice | BigDecimal | No        | Preset take-profit price                                                                                                |
| presetStopLossPrice   | BigDecimal | No        | Preset stop-loss price                                                                                                  |

## Request Example

```bash
curl -X POST "https://api-contract.weex.com/capi/v2/order/batchOrders" \
  -H "ACCESS-KEY:*******" \
  -H "ACCESS-SIGN:*" \
  -H "ACCESS-PASSPHRASE:*" \
  -H "ACCESS-TIMESTAMP:1659076670000" \
  -H "locale:zh-CN" \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "cmt_bchusdt",
    "orderDataList": [
      {
        "client_oid": "11111122222222",
        "size": "1",
        "type": "1",
        "order_type": "0",
        "match_price": "0",
        "price": "100"
      }
    ]
  }'
```

## Response Parameters

| Parameter                  | Type    | Description                             |
| -------------------------- | ------- | --------------------------------------- |
| order_info                 | List    | Order list                              |
| order_info[].order_id      | String  | Order ID                                |
| order_info[].client_oid    | String  | Customize order ID                      |
| order_info[].result        | Boolean | Order status                            |
| order_info[].error_code    | String  | Error code if order placement failed    |
| order_info[].error_message | String  | Error message if order placement failed |
| result                     | Boolean | Request result                          |

## Response Example

```json
{
  "order_info": [
    {
      "order_id": "596476148997685805",
      "client_oid": "order12346",
      "result": true,
      "error_code": "",
      "error_message": ""
    }
  ],
  "result": true
}
```
