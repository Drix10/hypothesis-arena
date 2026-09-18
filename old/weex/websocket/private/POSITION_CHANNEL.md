# Position Channel

## Description

Subscribe to position channel

## Request Parameters

| Parameter | Type   | Required | Description                           |
| --------- | ------ | -------- | ------------------------------------- |
| event     | String | Yes      | Operation: `subscribe`, `unsubscribe` |
| channel   | String | Yes      | Channel name                          |

## Request Example

```json
{
  "event": "subscribe",
  "channel": "positions"
}
```

## Response Parameters

| Field   | Type   | Description                             |
| ------- | ------ | --------------------------------------- |
| event   | String | Operation: `subscribed`, `unsubscribed` |
| channel | String | Channel name                            |

## Subscription Response Example

```json
{
  "event": "subscribed",
  "channel": "positions"
}
```

## Push Data Parameters

| Field                      | Type   | Description                             |
| -------------------------- | ------ | --------------------------------------- |
| id                         | String | Position ID                             |
| coinId                     | String | Collateral currency ID                  |
| contractId                 | String | Contract ID                             |
| side                       | String | Position direction (LONG/SHORT)         |
| marginMode                 | String | Margin mode for current position        |
| separatedMode              | String | Position separation mode                |
| separatedOpenOrderId       | String | Separated position opening order ID     |
| leverage                   | String | Position leverage                       |
| size                       | String | Position size                           |
| openValue                  | String | Opening value                           |
| openFee                    | String | Opening fee                             |
| fundingFee                 | String | Funding fee                             |
| isolatedMargin             | String | Isolated margin                         |
| isAutoAppendIsolatedMargin | String | Whether auto-append isolated margin     |
| cumOpenSize                | String | Cumulative opening size                 |
| cumOpenValue               | String | Cumulative opening value                |
| cumOpenFee                 | String | Cumulative opening fees                 |
| cumCloseSize               | String | Cumulative closing size                 |
| cumCloseValue              | String | Cumulative closing value                |
| cumCloseFee                | String | Cumulative closing fees                 |
| cumFundingFee              | String | Cumulative settled funding fees         |
| cumLiquidateFee            | String | Cumulative liquidation fees             |
| createdMatchSequenceId     | String | Matching engine sequence ID at creation |
| updatedMatchSequenceId     | String | Matching engine sequence ID at update   |
| createdTime                | String | Creation timestamp                      |
| updatedTime                | String | Update timestamp                        |

## Push Response Example

```json
{
  "type": "trade-event",
  "channel": "positions",
  "event": "payload",
  "msg": {
    "msgEvent": "PositionFundingSettle",
    "version": 46571,
    "data": {
      "position": [
        {
          "id": "615193369903104410",
          "coinId": "USDT",
          "contractId": "cmt_btcusdt",
          "side": "LONG",
          "marginMode": "SHARED",
          "separatedMode": "COMBINED",
          "separatedOpenOrderId": "0",
          "leverage": "20",
          "size": "0.01000",
          "openValue": "992.405443",
          "openFee": "0.595443",
          "fundingFee": "157.475456",
          "isolatedMargin": "0",
          "cumOpenSize": "0.55061",
          "cumOpenValue": "54642.836110",
          "cumOpenFee": "32.785700",
          "cumCloseSize": "0.54061",
          "cumCloseValue": "53666.138456",
          "cumCloseFee": "32.199683",
          "cumFundingFee": "163.232384",
          "cumLiquidateFee": "0",
          "createdMatchSequenceId": "3647905144",
          "updatedMatchSequenceId": "3656434385",
          "createdTime": "1746673529125",
          "updatedTime": "1747188961302",
          "autoAppendIsolatedMargin": false
        }
      ]
    },
    "time": 1747188961302
  }
}
```
