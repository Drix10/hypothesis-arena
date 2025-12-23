# Account Channel

## Description

Subscribe to the account channel

## Request Parameters

| Parameter | Type   | Required | Description                           |
| --------- | ------ | -------- | ------------------------------------- |
| event     | String | Yes      | Operation: `subscribe`, `unsubscribe` |
| channel   | String | Yes      | Channel name                          |

## Request Example

```json
{
  "event": "subscribe",
  "channel": "account"
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
  "channel": "account"
}
```

## Push Data Parameters

| Field                            | Type   | Description                                                                                                  |
| -------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| coinId                           | String | Currency ID                                                                                                  |
| marginMode                       | String | Margin mode                                                                                                  |
| crossContractId                  | String | When marginMode=CROSS, represents the associated contract ID in cross margin mode. Otherwise, it is 0.       |
| isolatedPositionId               | String | When marginMode=ISOLATED, represents the associated position ID in isolated margin mode. Otherwise, it is 0. |
| amount                           | String | Collateral amount                                                                                            |
| pendingDepositAmount             | String | Pending deposit amount                                                                                       |
| pendingWithdrawAmount            | String | Pending withdrawal amount                                                                                    |
| pendingTransferInAmount          | String | Pending transfer-in amount                                                                                   |
| pendingTransferOutAmount         | String | Pending transfer-out amount                                                                                  |
| isLiquidating                    | String | Whether liquidation is triggered (under forced liquidation)                                                  |
| legacyAmount                     | String | Balance field (display only, not used in calculations)                                                       |
| cumDepositAmount                 | String | Cumulative deposit amount                                                                                    |
| cumWithdrawAmount                | String | Cumulative withdrawal amount                                                                                 |
| cumTransferInAmount              | String | Cumulative transfer-in amount                                                                                |
| cumTransferOutAmount             | String | Cumulative transfer-out amount                                                                               |
| cumMarginMoveInAmount            | String | Cumulative margin transfer-in amount                                                                         |
| cumMarginMoveOutAmount           | String | Cumulative margin transfer-out amount                                                                        |
| cumPositionOpenLongAmount        | String | Cumulative collateral amount for opening long positions                                                      |
| cumPositionOpenShortAmount       | String | Cumulative collateral amount for opening short positions                                                     |
| cumPositionCloseLongAmount       | String | Cumulative collateral amount for closing long positions                                                      |
| cumPositionCloseShortAmount      | String | Cumulative collateral amount for closing short positions                                                     |
| cumPositionFillFeeAmount         | String | Cumulative trade fee amount                                                                                  |
| cumPositionLiquidateFeeAmount    | String | Cumulative liquidation fee amount                                                                            |
| cumPositionFundingAmount         | String | Cumulative funding fee amount                                                                                |
| cumOrderFillFeeIncomeAmount      | String | Cumulative order fee income amount                                                                           |
| cumOrderLiquidateFeeIncomeAmount | String | Cumulative liquidation fee income amount                                                                     |
| createdTime                      | String | Creation time                                                                                                |
| updatedTime                      | String | Update time                                                                                                  |

## Push Response Example

```json
{
  "type": "trade-event",
  "channel": "account",
  "event": "payload",
  "msg": {
    "msgEvent": "PositionFundingSettle",
    "version": 46571,
    "data": {
      "collateral": [
        {
          "coinId": "USDT",
          "marginMode": "SHARED",
          "crossContractId": "0",
          "isolatedPositionId": "0",
          "amount": "6625267.708162",
          "pendingDepositAmount": "0.000000",
          "pendingWithdrawAmount": "0.000000",
          "pendingTransferInAmount": "0",
          "pendingTransferOutAmount": "0",
          "legacyAmount": "6628108.535375",
          "cumDepositAmount": "6850179.708361",
          "cumWithdrawAmount": "118.284985",
          "cumTransferInAmount": "151.912400",
          "cumTransferOutAmount": "0",
          "cumMarginMoveInAmount": "0",
          "cumMarginMoveOutAmount": "114.587618",
          "cumPositionOpenLongAmount": "3551408.796139",
          "cumPositionOpenShortAmount": "287685.101200",
          "cumPositionCloseLongAmount": "3406364.752975",
          "cumPositionCloseShortAmount": "287789.808420",
          "cumPositionFillFeeAmount": "32.199683",
          "cumPositionLiquidateFeeAmount": "76.930498",
          "cumPositionFundingAmount": "-5778.744009",
          "cumOrderFillFeeIncomeAmount": "0",
          "cumOrderLiquidateFeeIncomeAmount": "0",
          "createdTime": "1728493664997",
          "updatedTime": "1747188961302",
          "liquidating": false
        }
      ]
    },
    "time": 1747188961302
  }
}
```
