/**
 * Live Trade Feed - Real-time trade events with animations
 */

import React from "react";
import { motion, AnimatePresence } from "framer-motion";

const ANALYST_INFO: Record<string, { name: string; emoji: string }> = {
  warren: { name: "Warren", emoji: "🎩" },
  cathie: { name: "Cathie", emoji: "🚀" },
  jim: { name: "Jim", emoji: "📊" },
  ray: { name: "Ray", emoji: "🌍" },
  elon: { name: "Elon", emoji: "📱" },
  karen: { name: "Karen", emoji: "🛡️" },
  quant: { name: "Quant", emoji: "🤖" },
  devil: { name: "Devil", emoji: "😈" },
};

export interface TradeEvent {
  id: string;
  timestamp: number;
  analystId: string;
  symbol: string;
  side: "BUY" | "SELL";
  size: number;
  price: number;
  pnl?: number;
}

interface LiveTradeFeedProps {
  events: TradeEvent[];
  maxItems?: number;
  title?: string;
}

export const LiveTradeFeed: React.FC<LiveTradeFeedProps> = ({
  events,
  maxItems = 10,
  title = "🔴 Live Trades",
}) => {
  const displayEvents = events.slice(0, maxItems);

  if (displayEvents.length === 0) {
    return (
      <div className="glass-card rounded-xl p-6">
        <h3 className="text-lg font-bold mb-4">{title}</h3>
        <div className="text-center py-8 text-slate-500">
          <div className="text-4xl mb-2">⏳</div>
          <p>Waiting for trades...</p>
          <p className="text-xs mt-1">Trades will appear here in real-time</p>
        </div>
      </div>
    );
  }

  return (
    <div className="glass-card rounded-xl p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-bold flex items-center gap-2">
          {title}
          <motion.span
            animate={{ opacity: [1, 0.5, 1] }}
            transition={{ duration: 2, repeat: Infinity }}
            className="w-2 h-2 bg-red-500 rounded-full"
          />
        </h3>
        <span className="text-xs text-slate-500">
          {displayEvents.length < events.length
            ? `${displayEvents.length} of ${events.length} trades`
            : `${events.length} trades`}
        </span>
      </div>

      <div className="space-y-2 max-h-[400px] overflow-y-auto">
        <AnimatePresence mode="popLayout">
          {displayEvents.map((event) => (
            <TradeEventCard key={event.id} event={event} />
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
};

const TradeEventCard: React.FC<{ event: TradeEvent }> = ({ event }) => {
  const info = ANALYST_INFO[event.analystId] || {
    name: event.analystId,
    emoji: "🤖",
  };
  const isLong = event.side === "BUY";
  const timeAgo = getTimeAgo(event.timestamp);
  const symbol = event.symbol?.replace("cmt_", "").toUpperCase() || "BTC";
  // Safe number handling
  const safeSize = Number.isFinite(event.size) ? event.size : 0;
  const safePrice = Number.isFinite(event.price) ? event.price : 0;

  return (
    <motion.div
      initial={{ opacity: 0, x: -20, height: 0 }}
      animate={{ opacity: 1, x: 0, height: "auto" }}
      exit={{ opacity: 0, x: 20, height: 0 }}
      transition={{ duration: 0.3 }}
      className={`
        flex items-center justify-between p-3 rounded-lg
        ${
          isLong
            ? "bg-green-500/10 border border-green-500/20"
            : "bg-red-500/10 border border-red-500/20"
        }
      `}
    >
      <div className="flex items-center gap-3">
        <span className="text-2xl">{info.emoji}</span>
        <div>
          <div className="font-semibold text-sm">{info.name}</div>
          <div className="text-xs text-slate-500">{timeAgo}</div>
        </div>
      </div>

      <div className="flex items-center gap-4 text-sm">
        <div>
          <div className="text-xs text-slate-500">Symbol</div>
          <div className="font-mono font-bold">{symbol}</div>
        </div>
        <div>
          <div className="text-xs text-slate-500">Side</div>
          <div
            className={`font-bold ${
              isLong ? "text-green-400" : "text-red-400"
            }`}
          >
            {isLong ? "📈 LONG" : "📉 SHORT"}
          </div>
        </div>
        <div>
          <div className="text-xs text-slate-500">Size</div>
          <div className="font-mono">{safeSize.toFixed(4)}</div>
        </div>
        <div>
          <div className="text-xs text-slate-500">Price</div>
          <div className="font-mono">${formatPrice(safePrice)}</div>
        </div>
        {event.pnl !== undefined && Number.isFinite(event.pnl) && (
          <div>
            <div className="text-xs text-slate-500">P&L</div>
            <div
              className={`font-mono font-bold ${
                event.pnl >= 0 ? "text-green-400" : "text-red-400"
              }`}
            >
              {event.pnl >= 0 ? "+" : ""}${event.pnl.toFixed(2)}
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
};

function getTimeAgo(timestamp: number): string {
  // Handle invalid timestamps
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "just now";

  const diff = Date.now() - timestamp;
  // Handle future timestamps (clock skew)
  if (diff < 0) return "just now";

  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatPrice(price: number): string {
  if (price === null || price === undefined || !Number.isFinite(price))
    return "0";
  if (price >= 1000)
    return price.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  if (price >= 1) return price.toFixed(2);
  return price.toFixed(4);
}

export default LiveTradeFeed;
