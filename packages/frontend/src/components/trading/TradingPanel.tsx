/**
 * Trading Panel - Order entry form
 */

import React, { useState } from "react";
import { WeexTicker } from "../../services/api/weex";

interface TradingPanelProps {
  symbol: string;
  ticker?: WeexTicker;
  balance: string;
}

const formatPrice = (price: number): string => {
  if (price >= 1000)
    return price.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  if (price >= 1) return price.toFixed(2);
  return price.toFixed(4);
};

export const TradingPanel: React.FC<TradingPanelProps> = ({
  symbol,
  ticker,
  balance,
}) => {
  const [side, setSide] = useState<"long" | "short">("long");
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [amount, setAmount] = useState("");
  const [price, setPrice] = useState("");
  const [leverage, setLeverage] = useState(10);

  const currentPrice = parseFloat(ticker?.last || "0") || 0;
  const availableBalance = parseFloat(balance) || 0;
  const displaySymbol = symbol
    .replace("cmt_", "")
    .replace("usdt", "")
    .toUpperCase();

  const orderPrice =
    orderType === "limit" ? parseFloat(price || "0") || 0 : currentPrice;
  const amountNum = parseFloat(amount || "0") || 0;
  const estimatedValue = Number.isFinite(amountNum * orderPrice)
    ? amountNum * orderPrice
    : 0;
  const requiredMargin =
    leverage > 0 && Number.isFinite(estimatedValue)
      ? estimatedValue / leverage
      : 0;
  const liqPrice =
    currentPrice > 0 && leverage > 0
      ? side === "long"
        ? currentPrice * (1 - 0.9 / leverage)
        : currentPrice * (1 + 0.9 / leverage)
      : 0;

  const calculateMaxAmount = (pct: number) => {
    if (currentPrice <= 0 || leverage <= 0) return "0";
    const maxAmount = (availableBalance * leverage) / currentPrice;
    return ((maxAmount * pct) / 100).toFixed(4);
  };

  return (
    <div className="max-w-xl mx-auto">
      <div className="glass-card rounded-xl p-6">
        <h3 className="text-lg font-semibold mb-4">Trade {displaySymbol}</h3>

        {/* Side Toggle */}
        <div className="grid grid-cols-2 gap-2 mb-4">
          <button
            onClick={() => setSide("long")}
            className={`py-3 rounded-lg font-semibold transition-all ${
              side === "long"
                ? "bg-green-500 text-white"
                : "bg-white/5 text-slate-400 hover:bg-white/10"
            }`}
          >
            Long / Buy
          </button>
          <button
            onClick={() => setSide("short")}
            className={`py-3 rounded-lg font-semibold transition-all ${
              side === "short"
                ? "bg-rose-500 text-white"
                : "bg-white/5 text-slate-400 hover:bg-white/10"
            }`}
          >
            Short / Sell
          </button>
        </div>

        {/* Order Type */}
        <div className="flex gap-2 mb-4">
          {(["market", "limit"] as const).map((type) => (
            <button
              key={type}
              onClick={() => setOrderType(type)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                orderType === type ? "badge-cyan" : "bg-white/5 text-slate-400"
              }`}
            >
              {type.charAt(0).toUpperCase() + type.slice(1)}
            </button>
          ))}
        </div>

        {/* Price Input */}
        {orderType === "limit" && (
          <div className="mb-4">
            <label className="block text-sm text-slate-400 mb-1">
              Price (USDT)
            </label>
            <input
              type="number"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder={currentPrice.toString()}
              className="w-full px-4 py-3 rounded-lg bg-white/5 border border-white/10 text-white font-mono focus:outline-none focus:border-cyan-400/50"
            />
          </div>
        )}

        {/* Amount Input */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1">
            <label className="text-sm text-slate-400">
              Amount ({displaySymbol})
            </label>
            <span className="text-xs text-slate-500">
              Available: ${availableBalance.toFixed(2)}
            </span>
          </div>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="w-full px-4 py-3 rounded-lg bg-white/5 border border-white/10 text-white font-mono focus:outline-none focus:border-cyan-400/50"
          />
          <div className="flex gap-2 mt-2">
            {[25, 50, 75, 100].map((pct) => (
              <button
                key={pct}
                onClick={() => setAmount(calculateMaxAmount(pct))}
                disabled={currentPrice <= 0}
                className="flex-1 py-1 rounded text-xs bg-white/5 hover:bg-white/10 text-slate-400 transition-colors disabled:opacity-50"
              >
                {pct}%
              </button>
            ))}
          </div>
        </div>

        {/* Leverage Slider */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm text-slate-400">Leverage</label>
            <span className="text-cyan-400 font-semibold">{leverage}x</span>
          </div>
          <input
            type="range"
            min="1"
            max="100"
            value={leverage}
            onChange={(e) => setLeverage(parseInt(e.target.value))}
            className="w-full h-2 rounded-full bg-white/10 appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-cyan-400"
          />
          <div className="flex justify-between text-[10px] text-slate-600 mt-1">
            <span>1x</span>
            <span>25x</span>
            <span>50x</span>
            <span>75x</span>
            <span>100x</span>
          </div>
        </div>

        {/* Order Summary */}
        <div className="metric-card mb-4 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-slate-500">Order Value</span>
            <span className="font-mono">${estimatedValue.toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">Required Margin</span>
            <span className="font-mono">${requiredMargin.toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">Est. Liq. Price</span>
            <span className="font-mono text-rose-400">
              {liqPrice > 0 ? formatPrice(liqPrice) : "-"}
            </span>
          </div>
        </div>

        {/* Submit Button */}
        <button
          disabled={
            !amount ||
            parseFloat(amount) <= 0 ||
            requiredMargin > availableBalance
          }
          className={`w-full py-4 rounded-lg font-semibold text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
            side === "long"
              ? "bg-green-500 hover:bg-green-600"
              : "bg-rose-500 hover:bg-rose-600"
          }`}
        >
          {side === "long" ? "Open Long" : "Open Short"} {displaySymbol}
        </button>

        {requiredMargin > availableBalance && amount && (
          <p className="text-xs text-rose-400 text-center mt-2">
            Insufficient margin
          </p>
        )}
      </div>
    </div>
  );
};
