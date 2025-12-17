/**
 * Ticker Input Component - Dark Theme
 */

import React, { useState, useCallback, useRef, useEffect } from "react";
import { searchTickers, validateTicker } from "../../services/stock";

interface TickerInputProps {
  onSelect: (ticker: string) => void;
  disabled?: boolean;
}

interface SearchResult {
  symbol: string;
  name: string;
  exchange: string;
}

export const TickerInput: React.FC<TickerInputProps> = ({
  onSelect,
  disabled = false,
}) => {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
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
      setResults(searchResults);
      setShowDropdown(searchResults.length > 0);
      setSelectedIndex(-1);
    } catch {
      setResults([]);
    } finally {
      setIsSearching(false);
    }
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.toUpperCase();
    setQuery(value);
    setError(null);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => handleSearch(value), 300);
  };

  const handleSelectTicker = async (ticker: string) => {
    setQuery(ticker);
    setShowDropdown(false);
    setIsValidating(true);
    setError(null);
    try {
      const isValid = await validateTicker(ticker);
      if (isValid) {
        onSelect(ticker);
      } else {
        setError(`Invalid ticker: ${ticker}`);
      }
    } catch {
      setError("Failed to validate ticker");
    } finally {
      setIsValidating(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) handleSelectTicker(query.trim());
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
          {/* Glow effect */}
          <div className="absolute -inset-1 bg-gradient-to-r from-electric-cyan/20 to-acid-purple/20 rounded-2xl blur-lg opacity-50" />

          <div className="relative flex gap-3 p-2 bg-surface border border-white/10 rounded-xl">
            <div className="flex-1 relative">
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                onFocus={() => results.length > 0 && setShowDropdown(true)}
                placeholder="Search ticker or company..."
                disabled={disabled || isValidating}
                className="w-full px-4 py-4 bg-transparent text-white text-lg placeholder-slate-600 focus:outline-none disabled:opacity-50"
              />
              {isSearching && (
                <div className="absolute right-4 top-1/2 -translate-y-1/2">
                  <div className="w-5 h-5 border-2 border-slate-600 border-t-electric-cyan rounded-full animate-spin" />
                </div>
              )}
            </div>
            <button
              type="submit"
              disabled={disabled || isValidating || !query.trim()}
              className="px-8 py-4 rounded-lg font-semibold text-void bg-gradient-to-r from-electric-cyan to-cyan-400 hover:from-cyan-400 hover:to-electric-cyan disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-300"
            >
              {isValidating ? (
                <div className="w-5 h-5 border-2 border-void/30 border-t-void rounded-full animate-spin" />
              ) : (
                "Analyze"
              )}
            </button>
          </div>
        </div>
      </form>

      {/* Dropdown */}
      {showDropdown && results.length > 0 && (
        <div
          ref={dropdownRef}
          className="absolute z-50 w-full mt-2 bg-surface border border-white/10 rounded-xl overflow-hidden shadow-2xl shadow-black/50"
        >
          {results.map((result, index) => (
            <div
              key={result.symbol}
              onClick={() => handleSelectTicker(result.symbol)}
              className={`px-4 py-3 cursor-pointer transition-colors ${
                index === selectedIndex
                  ? "bg-electric-cyan/10"
                  : "hover:bg-white/5"
              }`}
            >
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-semibold text-white">
                    {result.symbol}
                  </span>
                  <span className="ml-3 text-slate-500 text-sm">
                    {result.name}
                  </span>
                </div>
                <span className="text-xs text-slate-600 px-2 py-1 bg-white/5 rounded">
                  {result.exchange}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="mt-3 text-red-400 text-sm text-center">{error}</div>
      )}
    </div>
  );
};

export default TickerInput;
