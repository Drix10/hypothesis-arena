/**
 * Watchlist Component - Strategic Arena Theme
 */

import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
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
    if (removeFromWatchlist(ticker)) setItems(getWatchlist());
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
    <motion.div
      className="glass-card rounded-xl overflow-hidden"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
    >
      <motion.button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-white/[0.02] transition-colors"
        whileTap={{ scale: 0.99 }}
        aria-expanded={isExpanded}
        aria-controls="watchlist-items"
      >
        <div className="flex items-center gap-2">
          <span className="text-base" aria-hidden="true">
            ⭐
          </span>
          <h3 className="text-sm font-semibold text-white">Watchlist</h3>
          <motion.span
            className="text-[10px] text-slate-500 bg-white/[0.05] px-1.5 py-0.5 rounded-md"
            key={items.length}
            initial={{ scale: 0.8 }}
            animate={{ scale: 1 }}
          >
            {items.length}
          </motion.span>
        </div>
        <motion.span
          className="text-slate-500 text-xs"
          animate={{ rotate: isExpanded ? 180 : 0 }}
          transition={{ duration: 0.2 }}
        >
          ▼
        </motion.span>
      </motion.button>

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            id="watchlist-items"
            className="border-t border-white/[0.05] divide-y divide-white/[0.04]"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            {items.map((item, index) => (
              <motion.div
                key={item.ticker}
                className={`px-4 py-2.5 hover:bg-white/[0.02] transition-colors cursor-pointer ${
                  currentTicker === item.ticker
                    ? "bg-cyan/[0.06] border-l-2 border-cyan"
                    : ""
                }`}
                onClick={() => onSelectTicker(item.ticker)}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index * 0.04 }}
                whileHover={{ x: 2 }}
              >
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-white font-medium text-sm">
                        {item.ticker}
                      </span>
                      <span className="text-[10px] text-slate-500">
                        {item.name}
                      </span>
                    </div>
                    {item.notes && editingNotes !== item.ticker && (
                      <p className="text-[10px] text-slate-500 mt-0.5 truncate max-w-[200px]">
                        {item.notes}
                      </p>
                    )}
                    {editingNotes === item.ticker && (
                      <motion.div
                        className="mt-1.5 flex gap-1.5"
                        onClick={(e) => e.stopPropagation()}
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                      >
                        <input
                          type="text"
                          value={noteText}
                          onChange={(e) => setNoteText(e.target.value)}
                          placeholder="Add notes..."
                          className="flex-1 px-2 py-1 text-[10px] bg-arena-deep/50 border border-white/[0.08] rounded text-white placeholder-slate-600 focus:outline-none focus:border-cyan/50"
                          autoFocus
                        />
                        <motion.button
                          onClick={() => handleSaveNotes(item.ticker)}
                          className="px-2 py-1 text-[10px] bg-cyan/20 text-cyan rounded hover:bg-cyan/30"
                          whileTap={{ scale: 0.95 }}
                        >
                          Save
                        </motion.button>
                        <motion.button
                          onClick={() => setEditingNotes(null)}
                          className="px-2 py-1 text-[10px] text-slate-500 hover:text-white"
                          whileTap={{ scale: 0.95 }}
                        >
                          Cancel
                        </motion.button>
                      </motion.div>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-slate-600">
                      {formatDate(item.addedAt)}
                    </span>
                    <motion.button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (editingNotes !== item.ticker)
                          setNoteText(item.notes || "");
                        setEditingNotes(item.ticker);
                      }}
                      className="p-1 text-slate-500 hover:text-white transition-colors text-xs"
                      title="Edit notes"
                      aria-label={`Edit notes for ${item.ticker}`}
                      whileTap={{ scale: 0.9 }}
                    >
                      ✏️
                    </motion.button>
                    <motion.button
                      onClick={(e) => handleRemove(item.ticker, e)}
                      className="p-1 text-slate-500 hover:text-bear-light transition-colors text-xs"
                      title="Remove from watchlist"
                      aria-label={`Remove ${item.ticker} from watchlist`}
                      whileTap={{ scale: 0.9 }}
                    >
                      ✕
                    </motion.button>
                  </div>
                </div>
              </motion.div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};

export default Watchlist;
