/**
 * Market Sidebar - Symbol list with prices
 */

import React from "react";
import { WeexTicker } from "../../services/api/weex";

interface MarketSidebarProps {
  tickers: WeexTicker[];
  loading: boolean;
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
  isOpen: boolean;
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

export const MarketSidebar: React.FC<MarketSidebarProps> = ({
  tickers,
  loading,
  selectedSymbol,
  onSelectSymbol,
  isOpen,
}) => (
  <aside
    className={`${
      isOpen ? "w-64" : "w-0"
    } border-r border-white/10 glass-card flex-shrink-0 overflow-hidden transition-all duration-300 rounded-none`}
  >
    <div className="p-3 border-b border-white/10 flex items-center justify-between">
      <h2 className="text-sm font-semibold text-slate-400">Markets</h2>
      <span className="text-xs text-slate-600">{tickers.length} pairs</span>
    </div>

    <div className="overflow-y-auto h-[calc(100vh-140px)]">
      {loading && tickers.length === 0 ? (
        <div className="p-4 space-y-2">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="h-14 rounded-lg bg-white/5 shimmer" />
          ))}
        </div>
      ) : (
        <div className="p-2 space-y-1">
          {tickers.map((ticker) => {
            const price = parseFloat(ticker.last) || 0;
            const change = ticker.priceChangePercent
              ? parseFloat(ticker.priceChangePercent) * 100
              : 0;
            const isPositive = change >= 0;
            const symbol = ticker.symbol
              .replace("cmt_", "")
              .replace("usdt", "")
              .toUpperCase();
            const isSelected = ticker.symbol === selectedSymbol;

            return (
              <button
                key={ticker.symbol}
                onClick={() => onSelectSymbol(ticker.symbol)}
                className={`w-full p-3 rounded-lg text-left transition-all ${
                  isSelected
                    ? "bg-cyan-400/10 border border-cyan-400/30"
                    : "hover:bg-white/5 border border-transparent"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-semibold text-white">{symbol}</span>
                    <span className="text-[10px] text-slate-500 ml-1">
                      USDT
                    </span>
                  </div>
                  <span
                    className={`badge ${
                      isPositive ? "badge-bull" : "badge-bear"
                    } !py-0.5 !px-1.5 !text-[10px]`}
                  >
                    {isPositive ? "+" : ""}
                    {change.toFixed(2)}%
                  </span>
                </div>
                <p className="font-mono text-sm mt-1">${formatPrice(price)}</p>
              </button>
            );
          })}
        </div>
      )}
    </div>
  </aside>
);
