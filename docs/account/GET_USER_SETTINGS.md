# Get User Settings Of One Single Futures

## Endpoint

`GET /capi/v2/account/settings`

## Required Permission

Futures account read permissions

## Weight

**IP**: 1  
**UID**: 1

## Request Parameters

| Parameter | Type   | Required? | Description                                                      |
| --------- | ------ | --------- | ---------------------------------------------------------------- |
| symbol    | String | No        | Trading pair. If not filled in, all will be returned by default. |

## Request Example

```bash
curl "https://api-contract.weex.com/capi/v2/account/settings?symbol=cmt_bchusdt" \
  -H "ACCESS-KEY:*******" \
  -H "ACCESS-SIGN:*******" \
  -H "ACCESS-PASSPHRASE:*****" \
  -H "ACCESS-TIMESTAMP:1659076670000" \
  -H "locale:zh-CN" \
  -H "Content-Type: application/json"
```

## Response Parameters

| Parameter               | Type   | Description                      |
| ----------------------- | ------ | -------------------------------- |
| symbol                  | Object | Trading pair                     |
| isolated_long_leverage  | String | Isolated long position leverage  |
| isolated_short_leverage | String | Isolated short position leverage |
| cross_leverage          | String | Cross margin leverage            |

## Response Example

```json
{
  "cmt_ethusdt": {
    "isolated_long_leverage": "20.00",
    "isolated_short_leverage": "20.00",
    "cross_leverage": "20.00"
  }
}
```
