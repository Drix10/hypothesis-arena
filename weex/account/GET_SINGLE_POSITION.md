# Get Single Position

## Endpoint

`GET /capi/v2/account/position/singlePosition`

## Weight

**IP**: 2  
**UID**: 3

## Request Parameters

| Parameter | Type   | Required? | Description  |
| --------- | ------ | --------- | ------------ |
| symbol    | String | Yes       | Trading pair |

## Request Example

```bash
curl "https://api-contract.weex.com/capi/v2/account/position/singlePosition?symbol=cmt_bchusdt" \
  -H "ACCESS-KEY:*******" \
  -H "ACCESS-SIGN:*******" \
  -H "ACCESS-PASSPHRASE:*****" \
  -H "ACCESS-TIMESTAMP:1659076670000" \
  -H "locale:zh-CN" \
  -H "Content-Type: application/json"
```

## Response Parameters

| Parameter                      | Type    | Description                                                                                                                        |
| ------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| id                             | Long    | Position ID                                                                                                                        |
| account_id                     | Long    | Associated account ID                                                                                                              |
| coin_id                        | Integer | Associated collateral currency ID                                                                                                  |
| contract_id                    | Long    | Associated futures ID                                                                                                              |
| symbol                         | String  | Trading pair                                                                                                                       |
| side                           | String  | Position direction such as LONG or SHORT                                                                                           |
| margin_mode                    | String  | Margin mode of current position: `SHARED` = Cross Mode, `ISOLATED` = Isolated Mode                                                 |
| separated_mode                 | String  | Current position's separated mode: `COMBINED` = Combined mode, `SEPARATED` = Separated mode                                        |
| separated_open_order_id        | Long    | Opening order ID of separated position                                                                                             |
| leverage                       | String  | Position leverage                                                                                                                  |
| size                           | String  | Current position size                                                                                                              |
| open_value                     | String  | Initial value at position opening                                                                                                  |
| open_fee                       | String  | Opening fee                                                                                                                        |
| funding_fee                    | String  | Funding fee                                                                                                                        |
| marginSize                     | String  | Margin amount (margin coin)                                                                                                        |
| isolated_margin                | String  | Isolated margin                                                                                                                    |
| is_auto_append_isolated_margin | Boolean | Whether the auto-adding of funds for the isolated margin is enabled (only for isolated mode)                                       |
| cum_open_size                  | String  | Accumulated opened positions                                                                                                       |
| cum_open_value                 | String  | Accumulated value of opened positions                                                                                              |
| cum_open_fee                   | String  | Accumulated fees paid for opened positions                                                                                         |
| cum_close_size                 | String  | Accumulated closed positions                                                                                                       |
| cum_close_value                | String  | Accumulated value of closed positions                                                                                              |
| cum_close_fee                  | String  | Accumulated fees paid for closing positions                                                                                        |
| cum_funding_fee                | String  | Accumulated settled funding fees                                                                                                   |
| cum_liquidate_fee              | String  | Accumulated liquidation fees                                                                                                       |
| created_match_sequence_id      | Long    | Matching engine sequence ID at creation                                                                                            |
| updated_match_sequence_id      | Long    | Matching engine sequence ID at last update                                                                                         |
| created_time                   | Long    | Creation time Unix millisecond timestamp                                                                                           |
| updated_time                   | Long    | Update time Unix millisecond timestamp                                                                                             |
| contractVal                    | String  | Futures face value                                                                                                                 |
| unrealizePnl                   | String  | Unrealized PnL                                                                                                                     |
| liquidatePrice                 | String  | Estimated liquidation price. If the value = 0, it means the position is at low risk and there is no liquidation price at this time |

## Response Example

```json
[
  {
    "id": 689987235755328154,
    "account_id": 538941453963887258,
    "coin_id": 2,
    "contract_id": 10000001,
    "symbol": "cmt_btcusdt",
    "side": "LONG",
    "margin_mode": "SHARED",
    "separated_mode": "COMBINED",
    "separated_open_order_id": 0,
    "leverage": "100",
    "size": "0.020000",
    "open_value": "1801.0670000",
    "open_fee": "0.70731060",
    "funding_fee": "1.22618160",
    "marginSize": "17.154980",
    "isolated_margin": "0",
    "is_auto_append_isolated_margin": false,
    "cum_open_size": "0.020000",
    "cum_open_value": "1801.0670000",
    "cum_open_fee": "0.70731060",
    "cum_close_size": "0",
    "cum_close_value": "0",
    "cum_close_fee": "0",
    "cum_funding_fee": "1.22618160",
    "cum_liquidate_fee": "0",
    "created_match_sequence_id": 7027745116,
    "updated_match_sequence_id": 7040274110,
    "created_time": 1764505776347,
    "updated_time": 1764588886461,
    "contractVal": "0.000001",
    "unrealizePnl": "-85.5690000",
    "liquidatePrice": "0"
  }
]
```
