# Automatic Margin Top-Up

## Endpoint

`POST /capi/v2/account/modifyAutoAppendMargin`

## Weight

**IP**: 15  
**UID**: 30

## Request Parameters

| Parameter        | Type    | Required? | Description                             |
| ---------------- | ------- | --------- | --------------------------------------- |
| positionId       | Long    | Yes       | Isolated margin position ID             |
| autoAppendMargin | Boolean | Yes       | Whether to enable automatic margin call |

## Request Example

```bash
curl -X POST "https://api-contract.weex.com/capi/v2/account/modifyAutoAppendMargin" \
  -H "ACCESS-KEY:*******" \
  -H "ACCESS-SIGN:*" \
  -H "ACCESS-PASSPHRASE:*" \
  -H "ACCESS-TIMESTAMP:1659076670000" \
  -H "locale:zh-CN" \
  -H "Content-Type: application/json" \
  -d '{
    "positionId": 1,
    "autoAppendMargin": false
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
