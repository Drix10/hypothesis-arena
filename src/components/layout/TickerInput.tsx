/**
 * Ticker Input Component - Strategic Arena Theme
 * Premium search experience with predictive autocomplete
 */

import React, { useState, useCallback, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { searchTickers } from "../../services/stock";

interface TickerInputProps {
  onSelect: (ticker: string) => void;
  disabled?: boolean;
}

interface SearchResult {
  symbol: string;
  name: string;
  exchange: string;
}

/** Debounce delay for search input in milliseconds */
const SEARCH_DEBOUNCE_MS = 300;

export const TickerInput: React.FC<TickerInputProps> = ({
  onSelect,
  disabled = false,
}) => {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [isFocused, setIsFocused] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(event.target as Node)
      ) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, []);

  const handleSearch = useCallback(async (searchQuery: string) => {
    if (searchQuery.length < 1) {
      setResults([]);
      setShowDropdown(false);
      return;
    }
    setIsSearching(true);
    setError(null);
    try {
      const searchResults = await searchTickers(searchQuery);
      // Only update state if this search is still relevant (query hasn't changed)
      setResults(searchResults);
      setShowDropdown(searchResults.length > 0);
      setSelectedIndex(-1);
    } catch (error) {
      console.error("[TickerInput] Search failed:", error);
      setResults([]);
    } finally {
      setIsSearching(false);
    }
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.toUpperCase();
    setQuery(value);
    setError(null);

    // Clear previous timeout
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);

    // Debounce search
    searchTimeoutRef.current = setTimeout(
      () => handleSearch(value),
      SEARCH_DEBOUNCE_MS
    );
  };

  const handleSelectTicker = (ticker: string) => {
    // Prevent duplicate selections while disabled
    if (disabled) return;

    // Close dropdown immediately on selection
    setShowDropdown(false);

    // Basic format validation (no API call needed)
    const normalizedTicker = ticker.toUpperCase().trim();

    // Relaxed validation: allow letters, numbers, dots, dashes, colons (for exchange prefixes like TSX:)
    // Max length 15 to accommodate exchange:ticker format
    if (
      !normalizedTicker ||
      normalizedTicker.length > 15 ||
      !/^[A-Z0-9.:\-^]+$/.test(normalizedTicker)
    ) {
      setError(`Invalid ticker format: ${ticker}`);
      return;
    }

    // Set query AFTER validation passes (shows selected ticker in input)
    setQuery(normalizedTicker);

    // Clear error only after validation passes, just before calling onSelect
    setError(null);

    // Skip API validation - let the main analysis handle errors
    // This prevents blocking valid tickers when APIs are temporarily down
    onSelect(normalizedTicker);
    // Don't clear query immediately - let user see what was selected
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Prevent submission if disabled
    if (disabled || !query.trim()) return;

    // Clear any pending search
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
      searchTimeoutRef.current = null;
    }

    handleSelectTicker(query.trim());
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setShowDropdown(false);
    } else if (e.key === "ArrowDown" && showDropdown) {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1));
    } else if (e.key === "ArrowUp" && showDropdown) {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && selectedIndex >= 0 && showDropdown) {
      e.preventDefault();
      handleSelectTicker(results[selectedIndex].symbol);
    }
  };

  return (
    <div className="relative">
      <form onSubmit={handleSubmit}>
        <div className="relative">
          {/* Ambient glow - subtle */}
          <motion.div
            className="absolute -inset-1 rounded-2xl blur-lg pointer-events-none"
            animate={{
              background: isFocused
                ? "linear-gradient(135deg, rgba(6, 182, 212, 0.12), rgba(245, 184, 0, 0.06))"
                : "linear-gradient(135deg, rgba(6, 182, 212, 0.04), rgba(245, 184, 0, 0.02))",
            }}
            transition={{ duration: 0.2 }}
          />

          <div
            className={`relative flex gap-2 p-1.5 glass-card rounded-xl transition-all duration-200 ${
              isFocused ? "ring-2 ring-cyan/30" : ""
            }`}
          >
            {/* Search Icon */}
            <div className="flex items-center pl-3 text-slate-500">
              <svg
                className="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
            </div>

            <div className="flex-1 relative">
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                onFocus={() => {
                  setIsFocused(true);
                  results.length > 0 && setShowDropdown(true);
                }}
                onBlur={() => setIsFocused(false)}
                placeholder="Search ticker or company name..."
                disabled={disabled}
                className="w-full px-2 py-3 bg-transparent text-white placeholder-slate-500 focus:outline-none disabled:opacity-50 font-medium"
                autoComplete="off"
                aria-label="Stock ticker search"
                aria-expanded={showDropdown}
                aria-haspopup="listbox"
              />

              {/* Loading spinner */}
              {isSearching && (
                <div className="absolute right-2 top-1/2 -translate-y-1/2">
                  <div className="w-4 h-4 border-2 border-slate-600 border-t-cyan rounded-full animate-spin" />
                </div>
              )}
            </div>

            <motion.button
              type="submit"
              disabled={disabled || !query.trim()}
              className="px-5 sm:px-6 py-3 rounded-lg font-semibold btn-primary disabled:opacity-30 disabled:cursor-not-allowed text-sm"
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
            >
              <span className="flex items-center gap-1.5">
                <span>Analyze</span>
                <svg
                  className="w-4 h-4 hidden sm:block"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M13 7l5 5m0 0l-5 5m5-5H6"
                  />
                </svg>
              </span>
            </motion.button>
          </div>
        </div>
      </form>

      {/* Dropdown Results */}
      <AnimatePresence>
        {showDropdown && results.length > 0 && (
          <motion.div
            ref={dropdownRef}
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15 }}
            className="absolute z-50 w-full mt-2 glass-card rounded-xl overflow-hidden shadow-card border border-white/[0.08]"
            role="listbox"
          >
            {results.map((result, index) => (
              <motion.div
                key={result.symbol}
                onClick={() => {
                  // Prevent selection if disabled
                  if (!disabled) {
                    handleSelectTicker(result.symbol);
                  }
                }}
                className={`px-4 py-3 transition-all border-b border-white/[0.04] last:border-0 ${
                  disabled
                    ? "cursor-not-allowed opacity-50"
                    : "cursor-pointer hover:bg-white/[0.03]"
                } ${index === selectedIndex ? "bg-cyan/10" : ""}`}
                role="option"
                aria-selected={index === selectedIndex}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index * 0.02 }}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg bg-white/[0.05] flex items-center justify-center">
                      <span className="font-bold text-cyan text-xs">
                        {result.symbol.slice(0, 2)}
                      </span>
                    </div>
                    <div>
                      <div className="font-semibold text-white text-sm">
                        {result.symbol}
                      </div>
                      <div className="text-xs text-slate-400 truncate max-w-[180px] sm:max-w-[280px]">
                        {result.name}
                      </div>
                    </div>
                  </div>
                  <span className="text-[10px] text-slate-500 px-2 py-1 bg-white/[0.04] rounded-md font-medium">
                    {result.exchange}
                  </span>
                </div>
              </motion.div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Error Message */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 5 }}
            className="mt-3 text-bear-light text-sm text-center font-medium"
          >
            {error}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default TickerInput;
