# Get Server Time

## Endpoint

`GET /capi/v2/market/time`

## Weight

**IP**: 1

## Request Parameters

NONE

## Request Example

```bash
curl "https://api-contract.weex.com/capi/v2/market/time"
```

## Response Parameters

| Parameter | Type   | Description                                                                 |
| --------- | ------ | --------------------------------------------------------------------------- |
| epoch     | String | Unix timestamp in UTC time zone, represented as a decimal number of seconds |
| iso       | String | ISO 8601 standard time format                                               |
| timestamp | Long   | Server time Unix millisecond timestamp                                      |

## Response Example

```json
{
  "epoch": "1716710918.113",
  "iso": "2024-05-26T08:08:38.113Z",
  "timestamp": 1716710918113
}
```
