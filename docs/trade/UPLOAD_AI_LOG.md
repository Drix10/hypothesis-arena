# Upload AI Log

## Endpoint

`POST /capi/v2/order/uploadAiLog`

## Weight

**IP**: 1  
**UID**: 1

## Important Rule

BUILDs entering the live trading phase must provide an AI log (ai_log) containing:

- Model version
- Input and output data
- Order execution details

The AI log is required to verify AI involvement and compliance. If you fail to provide valid proof of AI involvement, we will disqualify your team and remove it from the rankings. Only approved UIDs on the official allowlist may submit AI log data.

## Request Parameters

| Parameter   | Type   | Required? | Description                                                                                                                                                             |
| ----------- | ------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| orderId     | Long   | No        | Order ID                                                                                                                                                                |
| stage       | String | Yes       | Stage identifier                                                                                                                                                        |
| model       | String | Yes       | Model name                                                                                                                                                              |
| input       | JSON   | Yes       | Input parameters                                                                                                                                                        |
| output      | JSON   | Yes       | Output results                                                                                                                                                          |
| explanation | String | Yes       | A concise, explanatory summary of AI's behavior. Used to describe the AI's analysis, reasoning, or output in natural language. The content should not exceed 500 words. |

## Request Example 1: Decision Making Stage

```bash
curl -X POST "https://api-contract.weex.com/capi/v2/order/uploadAiLog" \
  -H "ACCESS-KEY:*******" \
  -H "ACCESS-SIGN:*" \
  -H "ACCESS-PASSPHRASE:*" \
  -H "ACCESS-TIMESTAMP:1659076670000" \
  -H "locale:zh-CN" \
  -H "Content-Type: application/json" \
  -d '{
    "orderId": null,
    "stage": "Decision Making",
    "model": "GPT-5-mini",
    "input": {
      "prompt": "Summarize last 6h BTC/ETH correlation and give a directional signal."
    },
    "output": {
      "response": "Sell ETH; correlation weakened, BTC showing dominance."
    },
    "explanation": "Analysis of the past 6 hours of market data indicates a weakening correlation between BTC and ETH. BTC demonstrated relative strength and capital dominance, resulting in a directional signal favoring selling ETH."
  }'
```

## Request Example 2: Strategy Generation Stage

```bash
curl -X POST "https://api-contract.weex.com/capi/v2/order/uploadAiLog" \
  -H "ACCESS-KEY:*******" \
  -H "ACCESS-SIGN:*" \
  -H "ACCESS-PASSPHRASE:*" \
  -H "ACCESS-TIMESTAMP:1659076670000" \
  -H "locale:zh-CN" \
  -H "Content-Type: application/json" \
  -d '{
    "orderId": null,
    "stage": "Strategy Generation",
    "model": "GPT-5-turbo",
    "input": {
      "prompt": "Predict BTC/USDT price trend for the next 3 hours.",
      "data": {
        "RSI_14": 36.8,
        "EMA_20": 68950.4,
        "FundingRate": -0.0021,
        "OpenInterest": 512.3
      }
    },
    "output": {
      "signal": "Buy",
      "confidence": 0.82,
      "target_price": 69300,
      "reason": "Negative funding + rising open interest implies short squeeze potential."
    },
    "explanation": "Low RSI and price near the EMA20 suggest weakening downside momentum. Negative funding with rising open interest points to short-side pressure and potential squeeze risk, indicating a bullish bias for BTC over the next three hours."
  }'
```

## Response Parameters

| Parameter   | Type   | Description                                                          |
| ----------- | ------ | -------------------------------------------------------------------- |
| code        | String | Request status code, "00000" indicates success                       |
| msg         | String | Request result description, "success" indicates success              |
| requestTime | Long   | Request timestamp (milliseconds)                                     |
| data        | String | Returned business data, "upload success" indicates upload successful |

## Response Example

```json
{
  "code": "00000",
  "msg": "success",
  "requestTime": 1763103201300,
  "data": "upload success"
}
```

## AI Log Requirements

### Stage Identifiers

Common stage identifiers for AI logs:

- **Decision Making**: AI analysis and decision-making process
- **Strategy Generation**: AI strategy formulation and planning
- **Risk Assessment**: AI risk evaluation and management
- **Market Analysis**: AI market analysis and predictions
- **Order Execution**: AI order placement and execution logic
- **Portfolio Management**: AI portfolio optimization and rebalancing

### Input Data

Include relevant input parameters used by the AI model:

- Market data (prices, volumes, indicators)
- Technical indicators (RSI, EMA, MACD, etc.)
- Fundamental data (funding rates, open interest)
- Historical data and patterns
- User parameters and constraints

### Output Data

Include the AI model's output and results:

- Trading signals (Buy/Sell/Hold)
- Confidence scores
- Target prices or levels
- Reasoning or justification
- Risk metrics

### Explanation

Provide a clear, concise explanation (max 500 words) of:

- AI's analysis process
- Key factors considered
- Reasoning behind the decision
- Market conditions analyzed
- Expected outcomes

## Compliance Notes

- **Mandatory**: All live trading participants must submit AI logs
- **Verification**: Logs are used to verify genuine AI involvement
- **Disqualification**: Failure to provide valid AI logs results in disqualification
- **Allowlist**: Only approved UIDs can submit AI log data
- **Authenticity**: Logs must accurately represent AI decision-making

## Best Practices

1. **Detailed Logging**: Include comprehensive input and output data
2. **Clear Explanations**: Write clear, understandable explanations
3. **Consistent Format**: Use consistent JSON structure for logs
4. **Timestamp Accuracy**: Ensure timestamps match order execution times
5. **Model Identification**: Clearly identify the AI model used
6. **Stage Clarity**: Clearly identify the trading stage
7. **Regular Submission**: Submit logs regularly during live trading

## Error Handling

Refer to [../ERROR_CODES.md](../ERROR_CODES.md) for error codes.

Common errors:

- `40001` - Header "ACCESS_KEY" is required
- `40002` - Header "ACCESS_SIGN" is required
- `40012` - Incorrect API key/Passphrase
- `40019` - Parameter cannot be empty
- `40020` - Parameter is invalid
