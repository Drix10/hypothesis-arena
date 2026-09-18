# Place Trigger Order

## Endpoint

`POST /capi/v2/order/plan_order`

## Weight

**IP**: 2  
**UID**: 5

## Request Parameters

| Parameter     | Type    | Required? | Description                                                                                                                                      |
| ------------- | ------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| symbol        | String  | Yes       | Trading pair                                                                                                                                     |
| client_oid    | String  | Yes       | Custom order ID (≤40 chars, no special characters), must be unique in maker orders. If left empty, the system will automatically assign a value. |
| size          | String  | Yes       | Order quantity in lots (cannot be zero or negative)                                                                                              |
| type          | String  | Yes       | Order type: `1` = Open long, `2` = Open short, `3` = Close long, `4` = Close short                                                               |
| match_type    | String  | Yes       | Price type: `0` = Limit price, `1` = Market price                                                                                                |
| execute_price | String  | Yes       | Execution price                                                                                                                                  |
| trigger_price | String  | Yes       | Trigger price                                                                                                                                    |
| marginMode    | Integer | No        | Margin mode: `1` = Cross Mode, `3` = Isolated Mode. Default is 1 (Cross Mode)                                                                    |

## Request Example

```bash
curl -X POST "https://api-contract.weex.com/capi/v2/order/plan_order" \
  -H "ACCESS-KEY:*******" \
  -H "ACCESS-SIGN:*" \
  -H "ACCESS-PASSPHRASE:*" \
  -H "ACCESS-TIMESTAMP:1659076670000" \
  -H "locale:zh-CN" \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "cmt_bchusdt",
    "client_oid": "11111111111111",
    "size": "1",
    "type": "1",
    "match_type": "1",
    "execute_price": "100",
    "trigger_price": "100"
  }'
```

## Response Parameters

| Parameter  | Type   | Description          |
| ---------- | ------ | -------------------- |
| client_oid | String | Client identifier    |
| order_id   | String | Conditional order ID |

## Response Example

```json
{
  "client_oid": null,
  "order_id": "596480271352594989"
}
```
