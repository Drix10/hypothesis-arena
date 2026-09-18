# Get Single Ticker

## Endpoint

`GET /capi/v2/market/ticker`

## Weight

**IP**: 1

## Request Parameters

| Parameter | Type   | Required? | Description  |
| --------- | ------ | --------- | ------------ |
| symbol    | String | Yes       | Trading pair |

## Request Example

```bash
curl "https://api-contract.weex.com/capi/v2/market/ticker?symbol=cmt_btcusdt"
```

## Response Parameters

| Parameter          | Type   | Description                                 |
| ------------------ | ------ | ------------------------------------------- |
| symbol             | String | Trading pair                                |
| last               | String | Latest execution price                      |
| best_ask           | String | Ask price                                   |
| best_bid           | String | Bid price                                   |
| high_24h           | String | Highest price in the last 24 hours          |
| low_24h            | String | Lowest price in the last 24 hours           |
| volume_24h         | String | Trading volume of quote currency            |
| timestamp          | String | System timestamp Unix millisecond timestamp |
| priceChangePercent | String | Price increase or decrease (24 hours)       |
| base_volume        | String | Trading volume of quote currency            |
| markPrice          | String | Mark price                                  |
| indexPrice         | String | Index price                                 |

## Response Example

```json
{
  "symbol": "cmt_btcusdt",
  "last": "90755.3",
  "best_ask": "90755.4",
  "best_bid": "90755.3",
  "high_24h": "91130.0",
  "low_24h": "90097.3",
  "volume_24h": "2321170547.37995",
  "timestamp": "1764482511864",
  "priceChangePercent": "0.000474",
  "base_volume": "25615.0755",
  "markPrice": "90755.2",
  "indexPrice": "90797.161"
}
```
