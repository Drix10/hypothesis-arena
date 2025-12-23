/**
 * Watchlist Component - Cinematic Command Center
 * Bold asymmetric design with dramatic lighting effects
 */

import React, { useState, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  WatchlistItem,
  getWatchlist,
  removeFromWatchlist,
  updateWatchlistItem,
} from "../../services/storageService";

interface WatchlistProps {
  onSelectTicker: (ticker: string) => void;
  currentTicker?: string;
}

export const Watchlist: React.FC<WatchlistProps> = ({
  onSelectTicker,
  currentTicker,
}) => {
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [isExpanded, setIsExpanded] = useState(false);
  const [editingNotes, setEditingNotes] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");

  useEffect(() => {
    setItems(getWatchlist());
  }, []);

  const handleRemove = (ticker: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (removeFromWatchlist(ticker)) {
      setItems(getWatchlist());
      if (editingNotes === ticker) {
        setEditingNotes(null);
        setNoteText("");
      }
    }
  };

  const handleSaveNotes = (ticker: string) => {
    updateWatchlistItem(ticker, { notes: noteText });
    setItems(getWatchlist());
    setEditingNotes(null);
    setNoteText("");
  };

  const formatDate = (timestamp: number): string => {
    return new Date(timestamp).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  };

  if (items.length === 0) return null;

  return (
    <div
      className="relative overflow-hidden rounded-xl"
      style={{
        background: "linear-gradient(165deg, #0d1117 0%, #080b0f 100%)",
        border: "1px solid rgba(255,255,255,0.06)",
        boxShadow:
          "0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.03)",
      }}
    >
      {/* Diagonal accent */}
      <div
        className="absolute top-0 right-0 w-20 h-20 opacity-20"
        style={{
          background: "linear-gradient(135deg, #ffd700 0%, transparent 60%)",
          clipPath: "polygon(100% 0, 0 0, 100% 100%)",
        }}
      />
      {/* Scanlines */}
      <div
        className="absolute inset-0 opacity-[0.03] pointer-events-none"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.03) 2px, rgba(255,255,255,0.03) 4px)",
        }}
      />

      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-4 py-3.5 flex items-center justify-between transition-colors relative z-10 hover:bg-white/[0.02] active:scale-[0.99]"
        aria-expanded={isExpanded}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center text-lg"
            style={{
              background:
                "linear-gradient(145deg, rgba(255,215,0,0.15) 0%, rgba(255,215,0,0.05) 100%)",
              border: "1px solid rgba(255,215,0,0.3)",
            }}
          >
            ⭐
          </div>
          <h3
            className="text-sm font-black text-white"
            style={{ fontFamily: "'Space Grotesk', sans-serif" }}
          >
            Watchlist
          </h3>
          <span
            className="text-[10px] font-bold px-2 py-0.5 rounded-md"
            style={{
              background: "rgba(255,215,0,0.1)",
              color: "#ffd700",
              border: "1px solid rgba(255,215,0,0.2)",
            }}
          >
            {items.length}
          </span>
        </div>
        <span
          className="text-slate-500 text-xs transition-transform duration-200"
          style={{ transform: isExpanded ? "rotate(180deg)" : "rotate(0deg)" }}
        >
          ▼
        </span>
      </button>

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            className="border-t border-white/[0.06] relative z-10"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            {items.map((item) => (
              <div
                key={item.ticker}
                className="px-4 py-3 transition-all cursor-pointer relative overflow-hidden group hover:translate-x-1 hover:bg-white/[0.02] focus-within:ring-2 focus-within:ring-cyan/50"
                style={{
                  borderBottom: "1px solid rgba(255,255,255,0.04)",
                  background:
                    currentTicker === item.ticker
                      ? "rgba(0,240,255,0.06)"
                      : "transparent",
                  borderLeft:
                    currentTicker === item.ticker
                      ? "2px solid #00f0ff"
                      : "2px solid transparent",
                }}
                onClick={() => onSelectTicker(item.ticker)}
              >
                {/* Hover glow */}
                <div
                  className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity"
                  style={{
                    background:
                      "linear-gradient(90deg, rgba(0,240,255,0.03) 0%, transparent 60%)",
                  }}
                />

                <div className="flex items-center justify-between relative z-10">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-white font-bold text-sm">
                        {item.ticker}
                      </span>
                      <span className="text-[10px] text-slate-500 truncate max-w-[100px]">
                        {item.name}
                      </span>
                    </div>
                    {item.notes && editingNotes !== item.ticker && (
                      <p className="text-[10px] text-slate-500 mt-0.5 truncate max-w-[200px] italic">
                        "{item.notes}"
                      </p>
                    )}
                    {editingNotes === item.ticker && (
                      <div
                        className="mt-2 flex gap-1.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="text"
                          value={noteText}
                          onChange={(e) => setNoteText(e.target.value)}
                          placeholder="Add notes..."
                          className="flex-1 px-2 py-1 text-[10px] rounded text-white placeholder-slate-600 focus:outline-none"
                          style={{
                            background: "rgba(0,0,0,0.3)",
                            border: "1px solid rgba(0,240,255,0.3)",
                          }}
                          autoFocus
                        />
                        <button
                          onClick={() => handleSaveNotes(item.ticker)}
                          className="px-2 py-1 text-[10px] rounded font-bold active:scale-95"
                          style={{
                            background: "rgba(0,240,255,0.2)",
                            color: "#00f0ff",
                            border: "1px solid rgba(0,240,255,0.3)",
                          }}
                        >
                          Save
                        </button>
                        <button
                          onClick={() => setEditingNotes(null)}
                          className="px-2 py-1 text-[10px] text-slate-500 hover:text-white active:scale-95"
                        >
                          ✕
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-slate-600 font-mono">
                      {formatDate(item.addedAt)}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (editingNotes !== item.ticker)
                          setNoteText(item.notes || "");
                        setEditingNotes(item.ticker);
                      }}
                      className="p-1.5 text-slate-500 hover:text-cyan transition-colors text-xs active:scale-90"
                    >
                      ✏️
                    </button>
                    <button
                      onClick={(e) => handleRemove(item.ticker, e)}
                      className="p-1.5 text-slate-500 hover:text-red-400 transition-colors text-xs active:scale-90"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default Watchlist;
