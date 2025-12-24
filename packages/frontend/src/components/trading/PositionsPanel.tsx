/**
 * Positions Panel - Display open trading positions
 */

import React from "react";
import { WeexPosition } from "../../services/api/weex";

interface PositionsPanelProps {
  positions: WeexPosition[];
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

export const PositionsPanel: React.FC<PositionsPanelProps> = ({
  positions,
}) => (
  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
    {positions.map((pos, i) => {
      const pnl = parseFloat(pos.unrealizePnl || "0") || 0;
      const isProfit = pnl >= 0;
      const symbol = (pos.symbol || "")
        .replace("cmt_", "")
        .replace("usdt", "")
        .toUpperCase();
      const size = parseFloat(pos.size || "0") || 0;
      const openValue = parseFloat(pos.openValue || "0") || 0;
      const entryPrice = size > 0 ? openValue / size : 0;
      // Use symbol + side + size as unique key since positions may not have unique IDs
      const posKey = `${pos.symbol}-${pos.side}-${size}-${i}`;

      return (
        <div key={posKey} className="glass-card rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span
                className={`badge ${
                  pos.side === "long" ? "badge-bull" : "badge-bear"
                }`}
              >
                {pos.side.toUpperCase()}
              </span>
              <span className="font-semibold">{symbol}</span>
            </div>
            <span className="text-xs text-slate-500">{pos.leverage || 1}x</span>
          </div>

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-[10px] text-slate-500 uppercase">Size</p>
              <p className="font-mono">{size.toFixed(4)}</p>
            </div>
            <div>
              <p className="text-[10px] text-slate-500 uppercase">Entry</p>
              <p className="font-mono">{formatPrice(entryPrice)}</p>
            </div>
            <div>
              <p className="text-[10px] text-slate-500 uppercase">Mark Price</p>
              <p className="font-mono">
                {formatPrice(parseFloat(pos.markPrice || "0"))}
              </p>
            </div>
            <div>
              <p className="text-[10px] text-slate-500 uppercase">PnL</p>
              <p
                className={`font-mono font-semibold ${
                  isProfit ? "text-green-400" : "text-rose-400"
                }`}
              >
                {isProfit ? "+" : ""}
                {pnl.toFixed(2)} USDT
              </p>
            </div>
          </div>

          <div className="mt-3 pt-3 border-t border-white/5 flex gap-2">
            <button className="flex-1 py-1.5 rounded-lg text-xs font-medium bg-white/5 hover:bg-white/10 transition-colors">
              Close
            </button>
            <button className="flex-1 py-1.5 rounded-lg text-xs font-medium bg-white/5 hover:bg-white/10 transition-colors">
              TP/SL
            </button>
          </div>
        </div>
      );
    })}
  </div>
);
