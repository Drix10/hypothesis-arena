# Modify TP/SL Order

## Endpoint

`POST /capi/v2/order/modifyTpSlOrder`

## Weight

**IP**: 2  
**UID**: 5

## Request Parameters

| Parameter        | Type    | Required? | Description                                                                                              |
| ---------------- | ------- | --------- | -------------------------------------------------------------------------------------------------------- |
| orderId          | Long    | Yes       | Order ID of the TP/SL order to modify                                                                    |
| triggerPrice     | String  | Yes       | New trigger price                                                                                        |
| executePrice     | String  | No        | New execution price. If not provided or set to 0, market price will be used. Value > 0 means limit price |
| triggerPriceType | Integer | No        | Trigger price type: `1` = Last price, `3` = Mark price. Default is 1 (Last price)                        |

## Request Example

```bash
curl -X POST "https://api-contract.weex.com/capi/v2/order/modifyTpSlOrder" \
  -H "ACCESS-KEY:*******" \
  -H "ACCESS-SIGN:*" \
  -H "ACCESS-PASSPHRASE:*" \
  -H "ACCESS-TIMESTAMP:1659076670000" \
  -H "locale:zh-CN" \
  -H "Content-Type: application/json" \
  -d '{
    "orderId": 596471064624628269,
    "triggerPrice": "51000",
    "executePrice": "0",
    "triggerPriceType": 1
  }'
```

## Response Parameters

| Parameter   | Type   | Description                              |
| ----------- | ------ | ---------------------------------------- |
| code        | String | Response code, "00000" indicates success |
| msg         | String | Response message                         |
| requestTime | Long   | Return time Unix millisecond timestamp   |
| data        | Object | Response data (null for this endpoint)   |

## Response Example

```json
{
  "code": "00000",
  "msg": "success",
  "requestTime": 1765956639711,
  "data": ""
}
```
