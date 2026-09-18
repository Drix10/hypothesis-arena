# Get Futures Information

## Endpoint

`GET /capi/v2/market/contracts`

## Weight

**IP**: 10

## Request Parameters

| Parameter | Type   | Required? | Description  |
| --------- | ------ | --------- | ------------ |
| symbol    | String | No        | Trading pair |

## Request Example

```bash
curl "https://api-contract.weex.com/capi/v2/market/contracts?symbol=cmt_btcusdt"
```

## Response Parameters

| Parameter           | Type       | Description                                                |
| ------------------- | ---------- | ---------------------------------------------------------- |
| symbol              | String     | Trading pair                                               |
| underlying_index    | String     | Futures crypto                                             |
| quote_currency      | String     | Quote currency                                             |
| coin                | String     | Margin token                                               |
| contract_val        | String     | Futures face value                                         |
| delivery            | Array      | Settlement times                                           |
| size_increment      | String     | Decimal places of the quantity                             |
| tick_size           | String     | Decimal places of the price                                |
| forwardContractFlag | Boolean    | Whether it is USDT-M futures                               |
| priceEndStep        | BigDecimal | Step size of the last decimal digit in the price           |
| minLeverage         | Integer    | Minimum leverage (default: 1)                              |
| maxLeverage         | Integer    | Maximum leverage (default: 100)                            |
| buyLimitPriceRatio  | String     | Ratio of bid price to limit prices                         |
| sellLimitPriceRatio | String     | Ratio of ask price to limit price                          |
| makerFeeRate        | String     | Maker rate                                                 |
| takerFeeRate        | String     | Taker rate                                                 |
| minOrderSize        | String     | Minimum order size (base currency)                         |
| maxOrderSize        | String     | Maximum order size (base currency)                         |
| maxPositionSize     | String     | Maximum position size (base currency)                      |
| marketOpenLimitSize | String     | Market Order Opening Position Single Limit (base currency) |

## Response Example

```json
[
  {
    "symbol": "cmt_btcusdt",
    "underlying_index": "BTC",
    "quote_currency": "USDT",
    "coin": "USDT",
    "contract_val": "0",
    "delivery": ["00:00:00", "08:00:00", "16:00:00"],
    "size_increment": "5",
    "tick_size": "1",
    "forwardContractFlag": true,
    "priceEndStep": 1,
    "minLeverage": 1,
    "maxLeverage": 500,
    "buyLimitPriceRatio": "0.015",
    "sellLimitPriceRatio": "0.015",
    "makerFeeRate": "0.0002",
    "takerFeeRate": "0.0006",
    "minOrderSize": "0.0001",
    "maxOrderSize": "100000",
    "maxPositionSize": "1000000"
  }
]
```
