# Place Order

## Endpoint

`POST /capi/v2/order/placeOrder`

## Weight

**IP**: 2  
**UID**: 5

## Request Parameters

| Parameter             | Type       | Required? | Description                                                                                                             |
| --------------------- | ---------- | --------- | ----------------------------------------------------------------------------------------------------------------------- |
| symbol                | String     | Yes       | Trading pair                                                                                                            |
| client_oid            | String     | Yes       | Custom order ID (no more than 40 characters)                                                                            |
| size                  | String     | Yes       | Order quantity (cannot be zero or negative)                                                                             |
| type                  | String     | Yes       | Order type: `1` = Open long, `2` = Open short, `3` = Close long, `4` = Close short                                      |
| order_type            | String     | Yes       | Order type: `0` = Normal, `1` = Post-Only, `2` = Fill-Or-Kill, `3` = Immediate Or Cancel                                |
| match_price           | String     | Yes       | Price type: `0` = Limit price, `1` = Market price                                                                       |
| price                 | String     | Yes       | Order price (this is required for limit orders, and its accuracy and step size follow the futures information endpoint) |
| presetTakeProfitPrice | BigDecimal | No        | Preset take-profit price                                                                                                |
| presetStopLossPrice   | BigDecimal | No        | Preset stop-loss price                                                                                                  |
| marginMode            | Integer    | No        | Margin mode: `1` = Cross Mode, `3` = Isolated Mode. Default is 1 (Cross Mode)                                           |

## Request Example

```bash
curl -X POST "https://api-contract.weex.com/capi/v2/order/placeOrder" \
  -H "ACCESS-KEY:*******" \
  -H "ACCESS-SIGN:*" \
  -H "ACCESS-PASSPHRASE:*" \
  -H "ACCESS-TIMESTAMP:1659076670000" \
  -H "locale:zh-CN" \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "cmt_bchusdt",
    "client_oid": "111111111222222",
    "size": "1",
    "type": "1",
    "order_type": "0",
    "match_price": "0",
    "price": "100",
    "presetTakeProfitPrice": "105",
    "presetStopLossPrice": "95"
  }'
```

## Response Parameters

| Parameter  | Type   | Description                       |
| ---------- | ------ | --------------------------------- |
| client_oid | String | Client-generated order identifier |
| order_id   | String | Order ID                          |

## Response Example

```json
{
  "client_oid": null,
  "order_id": "596471064624628269"
}
```
