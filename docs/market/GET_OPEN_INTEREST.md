# Get Open Interest

## Endpoint

`GET /capi/v2/market/open_interest`

## Weight

**IP**: 2

## Request Parameters

| Parameter | Type   | Required? | Description  |
| --------- | ------ | --------- | ------------ |
| symbol    | String | Yes       | Trading pair |

## Request Example

```bash
curl "https://api-contract.weex.com/capi/v2/market/open_interest?symbol=cmt_1000satsusdt"
```

## Response Parameters

| Parameter     | Type   | Description                                        |
| ------------- | ------ | -------------------------------------------------- |
| symbol        | String | Trading pair                                       |
| base_volume   | String | Total open interest of the platform Specific coins |
| target_volume | String | Quote Currency Holdings                            |
| timestamp     | String | Timestamp Unix millisecond timestamp               |

## Response Example

```json
[
  {
    "symbol": "cmt_1000satsusdt",
    "base_volume": "0",
    "target_volume": "0",
    "timestamp": "1716709712753"
  }
]
```
