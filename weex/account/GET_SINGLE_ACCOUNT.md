# Get Single Account

## Endpoint

`GET /capi/v2/account/getAccount`

## Weight

**IP**: 1  
**UID**: 1

## Request Parameters

| Parameter | Type   | Required? | Description |
| --------- | ------ | --------- | ----------- |
| coin      | String | Yes       | Coin name   |

## Request Example

```bash
curl "https://api-contract.weex.com/capi/v2/account/getAccount?coin=USDT" \
  -H "ACCESS-KEY:*******" \
  -H "ACCESS-SIGN:*******" \
  -H "ACCESS-PASSPHRASE:*****" \
  -H "ACCESS-TIMESTAMP:1659076670000" \
  -H "locale:zh-CN" \
  -H "Content-Type: application/json"
```

## Response Parameters

### Account Object

| Parameter                     | Type         | Description                              |
| ----------------------------- | ------------ | ---------------------------------------- |
| defaultFeeSetting             | Object       | Default fee configuration                |
| feeSetting                    | Array Object | Fee settings                             |
| modeSetting                   | Array Object | Mode settings                            |
| leverageSetting               | Array Object | Leverage settings                        |
| createOrderRateLimitPerMinute | Integer      | Order creation rate limit per minute     |
| createOrderDelayMilliseconds  | Integer      | Order creation delay (milliseconds)      |
| createdTime                   | String       | Creation time Unix millisecond timestamp |
| updatedTime                   | String       | Update time Unix millisecond timestamp   |

### Default Fee Setting Object

| Parameter                       | Type    | Description                                                   |
| ------------------------------- | ------- | ------------------------------------------------------------- |
| is_set_fee_rate                 | Boolean | Whether fee rates are set                                     |
| taker_fee_rate                  | String  | Taker fee rate                                                |
| maker_fee_rate                  | String  | Maker fee rate                                                |
| is_set_fee_discount             | Boolean | Whether fee discounts are enabled                             |
| fee_discount                    | String  | Fee rate discount                                             |
| is_set_taker_maker_fee_discount | Boolean | Whether to apply separate fee discounts for takers and makers |
| taker_fee_discount              | String  | Taker fee rate discount                                       |
| maker_fee_discount              | String  | Maker fee rate discount                                       |

### Fee Setting Array Object

| Parameter                       | Type    | Description                                                   |
| ------------------------------- | ------- | ------------------------------------------------------------- |
| symbol                          | String  | Symbol name                                                   |
| is_set_fee_rate                 | Boolean | Whether fee rates are set                                     |
| taker_fee_rate                  | String  | Taker fee rate                                                |
| maker_fee_rate                  | String  | Maker fee rate                                                |
| is_set_fee_discount             | Boolean | Whether fee discounts are enabled                             |
| fee_discount                    | String  | Fee rate discount                                             |
| is_set_taker_maker_fee_discount | Boolean | Whether to apply separate fee discounts for takers and makers |
| taker_fee_discount              | String  | Taker fee rate discount                                       |
| maker_fee_discount              | String  | Maker fee rate discount                                       |

### Mode Setting Array Object

| Parameter      | Type   | Description               |
| -------------- | ------ | ------------------------- |
| symbol         | String | Symbol name               |
| marginMode     | String | Margin mode               |
| separated_mode | String | Position segregation mode |
| position_mode  | String | Position mode             |

### Leverage Setting Array Object

| Parameter               | Type   | Description                      |
| ----------------------- | ------ | -------------------------------- |
| symbol                  | String | Symbol name                      |
| isolated_long_leverage  | String | Isolated long position leverage  |
| isolated_short_leverage | String | Isolated short position leverage |
| cross_leverage          | String | Cross margin leverage            |

### Collateral Array Object

| Parameter                             | Type    | Description                                                                                             |
| ------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------- |
| coin                                  | String  | Currency                                                                                                |
| marginMode                            | String  | Margin mode                                                                                             |
| crossSymbol                           | String  | When marginMode=CROSS, represents the symbol associated with cross margin mode. Null in other cases.    |
| isolatedPositionId                    | String  | When marginMode=ISOLATED, represents the position ID associated with isolated margin. 0 in other cases. |
| amount                                | String  | Collateral amount                                                                                       |
| pending_deposit_amount                | String  | Pending deposit amount                                                                                  |
| pending_withdraw_amount               | String  | Pending withdrawal amount                                                                               |
| pending_transfer_in_amount            | String  | Pending inbound transfer amount                                                                         |
| pending_transfer_out_amount           | String  | Pending outbound transfer amount                                                                        |
| is_liquidating                        | Boolean | Whether liquidation is triggered (in progress)                                                          |
| legacy_amount                         | String  | Legacy balance (display only)                                                                           |
| cum_deposit_amount                    | String  | Accumulated deposit amount                                                                              |
| cum_withdraw_amount                   | String  | Accumulated withdrawal amount                                                                           |
| cum_transfer_in_amount                | String  | Accumulated inbound transfer amount                                                                     |
| cum_transfer_out_amount               | String  | Accumulated outbound transfer amount                                                                    |
| cum_margin_move_in_amount             | String  | Accumulated margin deposit amount                                                                       |
| cum_margin_move_out_amount            | String  | Accumulated margin withdrawal amount                                                                    |
| cum_position_open_long_amount         | String  | Accumulated collateral amount for long position openings                                                |
| cum_position_open_short_amount        | String  | Accumulated collateral amount for short position openings                                               |
| cum_position_close_long_amount        | String  | Accumulated collateral amount for long position closings                                                |
| cum_position_close_short_amount       | String  | Accumulated collateral amount for short position closings                                               |
| cum_position_fill_fee_amount          | String  | Accumulated trading fees for filled orders                                                              |
| cum_position_liquidate_fee_amount     | String  | Accumulated liquidation fees                                                                            |
| cum_position_funding_amount           | String  | Accumulated funding fees                                                                                |
| cum_order_fill_fee_income_amount      | String  | Accumulated order fee income                                                                            |
| cum_order_liquidate_fee_income_amount | String  | Accumulated liquidation fee income                                                                      |
| created_time                          | String  | Creation time Unix millisecond timestamp                                                                |
| updated_time                          | String  | Update time Unix millisecond timestamp                                                                  |
| version                               | String  | Version number                                                                                          |

## Response Example

```json
{
  "account": {
    "defaultFeeSetting": {
      "is_set_fee_rate": true,
      "taker_fee_rate": "0.00072000",
      "maker_fee_rate": "0.00018000",
      "is_set_fee_discount": false,
      "fee_discount": "0",
      "is_set_taker_maker_fee_discount": false,
      "taker_fee_discount": "0",
      "maker_fee_discount": "0"
    },
    "feeSetting": [
      {
        "symbol": "cmt_btcusdt",
        "is_set_fee_rate": false,
        "taker_fee_rate": "0.00078000",
        "maker_fee_rate": "0.00018000",
        "is_set_fee_discount": false,
        "fee_discount": "0",
        "is_set_taker_maker_fee_discount": false,
        "taker_fee_discount": "0",
        "maker_fee_discount": "0"
      }
    ],
    "modeSetting": [
      {
        "symbol": "cmt_btcusdt",
        "marginMode": "SHARED",
        "separatedModeEnum": "COMBINED",
        "positionModeEnum": "HEDGE"
      }
    ],
    "leverageSetting": [
      {
        "symbol": "cmt_btcusdt",
        "isolated_long_leverage": "1",
        "isolated_short_leverage": "100",
        "cross_leverage": "20.00"
      }
    ],
    "createOrderRateLimitPerMinute": 0,
    "createOrderDelayMilliseconds": 0,
    "createdTime": 1728493655673,
    "updatedTime": 1764221456649
  },
  "collateral": [
    {
      "coin": "USDT",
      "marginMode": "SHARED",
      "crossSymbol": null,
      "isolatedPositionId": 0,
      "amount": "4663.20125463",
      "pending_deposit_amount": "0.00000000",
      "pending_withdraw_amount": "0.000000",
      "pending_transfer_in_amount": "0",
      "pending_transfer_out_amount": "0.00000000",
      "is_liquidating": false,
      "legacy_amount": "5662.90202073",
      "cum_deposit_amount": "6860279.70836100",
      "cum_withdraw_amount": "6647240.391794",
      "cum_transfer_in_amount": "452.09021000",
      "cum_transfer_out_amount": "292.75030000",
      "cum_margin_move_in_amount": "10208.01422763",
      "cum_margin_move_out_amount": "12366.05275584",
      "cum_position_open_long_amount": "4672962.7674221",
      "cum_position_open_short_amount": "287777.669958",
      "cum_position_close_long_amount": "4532201.78518940",
      "cum_position_close_short_amount": "287888.538892",
      "cum_position_fill_fee_amount": "0.59982046",
      "cum_position_liquidate_fee_amount": "76.930498",
      "cum_position_funding_amount": "9859.37164167",
      "cum_order_fill_fee_income_amount": "0",
      "cum_order_liquidate_fee_income_amount": "0",
      "created_time": 1728493664997,
      "updated_time": 1764306706243
    }
  ],
  "version": null
}
```
