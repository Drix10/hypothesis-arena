# Get Next Funding Time

## Endpoint

`GET /capi/v2/market/funding_time`

## Weight

**IP**: 1

## Request Parameters

| Parameter | Type   | Required? | Description  |
| --------- | ------ | --------- | ------------ |
| symbol    | String | Yes       | Trading pair |

## Request Example

```bash
curl "https://api-contract.weex.com/capi/v2/market/funding_time?symbol=cmt_bchusdt"
```

## Response Parameters

| Parameter   | Type   | Description                                |
| ----------- | ------ | ------------------------------------------ |
| symbol      | String | Trading pair                               |
| fundingTime | Long   | Settlement time Unix millisecond timestamp |

## Response Example

```json
{
  "symbol": "cmt_btcusdt",
  "fundingTime": 1716595200000
}
```
