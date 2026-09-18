# Get Contract Account Bills

## Endpoint

`POST /capi/v2/account/bills`

## Weight

**IP**: 2  
**UID**: 5

## Request Parameters

| Parameter    | Type    | Required? | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------ | ------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| coin         | String  | No        | Currency name                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| symbol       | String  | No        | Trading pair                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| businessType | String  | No        | Business type: `deposit`, `withdraw`, `transfer_in`, `transfer_out`, `margin_move_in`, `margin_move_out`, `position_open_long`, `position_open_short`, `position_close_long`, `position_close_short`, `position_funding`, `order_fill_fee_income`, `order_liquidate_fee_income`, `start_liquidate`, `finish_liquidate`, `order_fix_margin_amount`, `tracking_follow_pay`, `tracking_system_pre_receive`, `tracking_follow_back`, `tracking_trader_income`, `tracking_third_party_share` |
| startTime    | Long    | No        | Start timestamp Unit: milliseconds                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| endTime      | Long    | No        | End timestamp Unit: milliseconds                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| limit        | Integer | No        | Return record limit, default: 20 Minimum: 1 Maximum: 100                                                                                                                                                                                                                                                                                                                                                                                                                                |

### Business Type Descriptions

- **deposit**: Deposit
- **withdraw**: Withdrawal
- **transfer_in**: Transfer between different accounts (in)
- **transfer_out**: Transfer between different accounts (out)
- **margin_move_in**: Collateral transferred within the same account due to opening/closing positions, manual/auto addition
- **margin_move_out**: Collateral transferred out within the same account due to opening/closing positions, manual/auto addition
- **position_open_long**: Collateral change from opening long positions (buying decreases collateral)
- **position_open_short**: Collateral change from opening short positions (selling increases collateral)
- **position_close_long**: Collateral change from closing long positions (selling increases collateral)
- **position_close_short**: Collateral change from closing short positions (buying decreases collateral)
- **position_funding**: Collateral change from position funding fee settlement
- **order_fill_fee_income**: Order fill fee income (specific to fee account)
- **order_liquidate_fee_income**: Order liquidation fee income (specific to fee account)
- **start_liquidate**: Start liquidation
- **finish_liquidate**: Finish liquidation
- **order_fix_margin_amount**: Compensation for liquidation loss
- **tracking_follow_pay**: Copy trading payment, pre-deducted from followers after position closing if profitable
- **tracking_system_pre_receive**: Pre-received commission, commission system account receives pre-deducted amount from followers
- **tracking_follow_back**: Copy trading commission refund
- **tracking_trader_income**: Lead trader income
- **tracking_third_party_share**: Profit sharing (shared by lead trader with others)

## Request Example

```bash
curl -X POST "https://api-contract.weex.com/capi/v2/account/bills" \
  -H "ACCESS-KEY:*******" \
  -H "ACCESS-SIGN:*******" \
  -H "ACCESS-PASSPHRASE:*****" \
  -H "ACCESS-TIMESTAMP:1659076670000" \
  -H "locale:zh-CN" \
  -H "Content-Type: application/json" \
  -d '{
    "coin": "",
    "symbol": "",
    "businessType": "",
    "startTime": null,
    "endTime": null,
    "limit": 10
  }'
```

## Response Parameters

| Parameter      | Type   | Description                              |
| -------------- | ------ | ---------------------------------------- |
| billId         | String | Bill ID                                  |
| coin           | String | Currency name                            |
| symbol         | String | Trading pair                             |
| amount         | String | Amount                                   |
| businessType   | String | Transaction business type                |
| balance        | String | Balance                                  |
| fillFee        | String | Transaction fee                          |
| transferReason | String | Transfer Reason                          |
| ctime          | String | Creation time Unix millisecond timestamp |

### Transfer Reason Values

- **UNKNOWN_TRANSFER_REASON**: Unknown transfer reason
- **USER_TRANSFER**: User manual transfer
- **INCREASE_CONTRACT_CASH_GIFT**: Increase contract cash gift
- **REDUCE_CONTRACT_CASH_GIFT**: Reduce contract cash gift
- **REFUND_WXB_DISCOUNT_FEE**: Refund WXB discount fee

## Response Example

```json
{
  "hasNextPage": true,
  "items": [
    {
      "billId": 686960019383517338,
      "coin": "USDT",
      "symbol": "cmt_btcusdt",
      "amount": "0.08266646",
      "businessType": "position_funding",
      "balance": "4738.70667369",
      "fillFee": "0",
      "transferReason": "UNKNOWN_TRANSFER_REASON",
      "ctime": 1763784031721
    }
  ]
}
```
