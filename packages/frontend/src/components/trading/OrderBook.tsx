/**
 * Order Book - Live bid/ask depth visualization
 */

import React, { useState, useEffect, useCallback } from "react";
import { weexApi } from "../../services/api/weex";

interface OrderBookProps {
  symbol: string;
}

const formatPrice = (price: number): string => {
  if (price >= 1000)
    return price.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  if (price >= 1) return price.toFixed(2);
  if (price >= 0.01) return price.toFixed(4);
  return price.toFixed(6);
};

export const OrderBook: React.FC<OrderBookProps> = ({ symbol }) => {
  const [depth, setDepth] = useState<{
    bids: [string, string][];
    asks: [string, string][];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDepth = useCallback(async () => {
    try {
      const data = await weexApi.getDepth(symbol, 15);
      setDepth(data);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [symbol]);

  useEffect(() => {
    let cancelled = false;
    const doFetch = async () => {
      if (!cancelled) await fetchDepth();
    };
    doFetch();
    const interval = setInterval(doFetch, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [fetchDepth]);

  if (loading && !depth) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="w-8 h-8 border-2 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin" />
      </div>
    );
  }

  if (error && !depth) {
    return (
      <div className="text-center py-16">
        <p className="text-rose-400 mb-4">{error}</p>
        <button
          onClick={fetchDepth}
          className="btn-primary px-4 py-2 rounded-lg"
        >
          Retry
        </button>
      </div>
    );
  }

  if (!depth) return null;

  const maxBidVol = Math.max(
    ...depth.bids.slice(0, 15).map(([, s]) => parseFloat(s) || 0),
    0.001
  );
  const maxAskVol = Math.max(
    ...depth.asks.slice(0, 15).map(([, s]) => parseFloat(s) || 0),
    0.001
  );

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Bids */}
      <div className="glass-card rounded-xl p-4">
        <h3 className="text-sm font-semibold text-green-400 mb-3 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-green-500" />
          Buy Orders (Bids)
        </h3>
        <div className="space-y-1">
          <div className="flex justify-between text-[10px] text-slate-500 uppercase tracking-wider pb-2 border-b border-white/5">
            <span>Price (USDT)</span>
            <span>Amount</span>
          </div>
          {depth.bids.slice(0, 15).map(([price, size], i) => {
            const vol = parseFloat(size) || 0;
            const pct = (vol / maxBidVol) * 100;
            return (
              <div
                key={i}
                className="relative flex justify-between text-sm font-mono py-1"
              >
                <div
                  className="absolute inset-y-0 left-0 bg-green-500/10 rounded"
                  style={{ width: `${pct}%` }}
                />
                <span className="relative text-green-400">
                  {formatPrice(parseFloat(price))}
                </span>
                <span className="relative text-slate-400">
                  {vol.toFixed(4)}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Asks */}
      <div className="glass-card rounded-xl p-4">
        <h3 className="text-sm font-semibold text-rose-400 mb-3 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-rose-500" />
          Sell Orders (Asks)
        </h3>
        <div className="space-y-1">
          <div className="flex justify-between text-[10px] text-slate-500 uppercase tracking-wider pb-2 border-b border-white/5">
            <span>Price (USDT)</span>
            <span>Amount</span>
          </div>
          {depth.asks.slice(0, 15).map(([price, size], i) => {
            const vol = parseFloat(size) || 0;
            const pct = (vol / maxAskVol) * 100;
            return (
              <div
                key={i}
                className="relative flex justify-between text-sm font-mono py-1"
              >
                <div
                  className="absolute inset-y-0 right-0 bg-rose-500/10 rounded"
                  style={{ width: `${pct}%` }}
                />
                <span className="relative text-rose-400">
                  {formatPrice(parseFloat(price))}
                </span>
                <span className="relative text-slate-400">
                  {vol.toFixed(4)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
