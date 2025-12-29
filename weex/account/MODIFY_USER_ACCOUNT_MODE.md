# Modify User Account Mode

## Endpoint

`POST /capi/v2/account/position/changeHoldModel`

## Weight

**IP**: 20  
**UID**: 50

## Request Parameters

| Parameter     | Type    | Required? | Description                                                                                               |
| ------------- | ------- | --------- | --------------------------------------------------------------------------------------------------------- |
| symbol        | String  | Yes       | Trading pair                                                                                              |
| marginMode    | Integer | Yes       | Margin mode: `1` = Cross Mode, `3` = Isolated Mode                                                        |
| separatedMode | Integer | No        | Position segregation mode: `1` = Combined mode. System will automatically set to Combined mode by default |

## Request Example

```bash
curl -X POST "https://api-contract.weex.com/capi/v2/account/position/changeHoldModel" \
  -H "ACCESS-KEY:*******" \
  -H "ACCESS-SIGN:*" \
  -H "ACCESS-PASSPHRASE:*" \
  -H "ACCESS-TIMESTAMP:1659076670000" \
  -H "locale:zh-CN" \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "cmt_bchusdt",
    "marginMode": 1
  }'
```

## Response Parameters

| Parameter   | Type   | Description                          |
| ----------- | ------ | ------------------------------------ |
| msg         | String | Response message                     |
| requestTime | String | Timestamp Unix millisecond timestamp |
| code        | String | Response code                        |

## Response Example

```json
{
  "msg": "success",
  "requestTime": 1713339011237,
  "code": "200"
}
```
