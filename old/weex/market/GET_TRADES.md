# Get Trades

## Endpoint

`GET /capi/v2/market/trades`

## Weight

**IP**: 5

## Request Parameters

| Parameter | Type    | Required? | Description                                                       |
| --------- | ------- | --------- | ----------------------------------------------------------------- |
| symbol    | String  | Yes       | Trading pair                                                      |
| limit     | Integer | No        | The size of the data ranges from 1 to 1000, with a default of 100 |

## Request Example

```bash
curl "https://api-contract.weex.com/capi/v2/market/trades?symbol=cmt_btcusdt&limit=100"
```

## Response Parameters

| Parameter    | Type    | Description                                                       |
| ------------ | ------- | ----------------------------------------------------------------- |
| ticketId     | String  | Filled order ID                                                   |
| time         | Long    | The time at which the order was filled Unix millisecond timestamp |
| price        | String  | The price at which the order was filled                           |
| size         | String  | The quantity that was filled (base currency)                      |
| value        | String  | Filled amount (quote currency)                                    |
| symbol       | String  | Trading pair                                                      |
| isBestMatch  | Boolean | Was the trade the best price match?                               |
| isBuyerMaker | Boolean | Was the buyer the maker?                                          |
| contractVal  | String  | Futures face value (unit: contracts)                              |

## Response Example

```json
[
  {
    "ticketId": "124b129e-3999-4d14-a4b5-9bdda68e5e26",
    "time": 1716604853286,
    "price": "68734.8",
    "size": "0.001",
    "value": "68.7348",
    "symbol": "cmt_btcusdt",
    "isBestMatch": true,
    "isBuyerMaker": true,
    "contractVal": "0.000001"
  }
]
```
