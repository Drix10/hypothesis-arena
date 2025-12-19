/**
 * Stock Header Component - Strategic Arena Theme
 */

import React from "react";
import { motion } from "framer-motion";
import { StockQuote, CompanyProfile } from "../../types/stock";

interface StockHeaderProps {
  quote: StockQuote;
  profile: CompanyProfile;
}

export const StockHeader: React.FC<StockHeaderProps> = ({ quote, profile }) => {
  const isPositive = quote.change >= 0;

  const formatNumber = (num: number): string => {
    if (num >= 1e12) return (num / 1e12).toFixed(2) + "T";
    if (num >= 1e9) return (num / 1e9).toFixed(2) + "B";
    if (num >= 1e6) return (num / 1e6).toFixed(2) + "M";
    return num.toLocaleString();
  };

  const formatVolume = (num: number): string => {
    if (num >= 1e9) return (num / 1e9).toFixed(2) + "B";
    if (num >= 1e6) return (num / 1e6).toFixed(2) + "M";
    if (num >= 1e3) return (num / 1e3).toFixed(1) + "K";
    return num.toLocaleString();
  };

  return (
    <motion.div
      className="glass-card rounded-2xl p-5 sm:p-6 overflow-hidden relative"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
    >
      <div
        className={`absolute top-0 right-0 w-48 h-48 rounded-full blur-[80px] pointer-events-none ${
          isPositive ? "bg-bull/[0.06]" : "bg-bear/[0.06]"
        }`}
      />

      <div className="relative flex flex-col lg:flex-row lg:items-start lg:justify-between gap-5 mb-6">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <motion.h1
              className="text-3xl sm:text-4xl font-bold text-white font-serif"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.1 }}
            >
              {quote.ticker}
            </motion.h1>
            <motion.span
              className="px-2 py-1 text-[10px] font-semibold text-slate-400 bg-white/[0.04] rounded-md border border-white/[0.06]"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.2 }}
            >
              {profile.exchange}
            </motion.span>
          </div>
          <motion.p
            className="text-base text-slate-300 font-medium mb-1.5"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.15 }}
          >
            {profile.name}
          </motion.p>
          {(profile.sector || profile.industry) && (
            <motion.div
              className="flex items-center gap-2 text-xs text-slate-500"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.2 }}
            >
              {profile.sector && (
                <span className="px-1.5 py-0.5 bg-white/[0.03] rounded">
                  {profile.sector}
                </span>
              )}
              {profile.sector && profile.industry && (
                <span className="w-1 h-1 bg-slate-700 rounded-full" />
              )}
              {profile.industry && (
                <span className="px-1.5 py-0.5 bg-white/[0.03] rounded">
                  {profile.industry}
                </span>
              )}
            </motion.div>
          )}
        </div>

        <motion.div
          className="text-left lg:text-right"
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.1 }}
        >
          <div className="text-4xl sm:text-5xl font-bold text-white mb-1.5 font-serif tracking-tight">
            ${quote.price.toFixed(2)}
          </div>
          <div
            className={`flex items-center gap-2 text-lg font-semibold ${
              isPositive ? "text-bull-light" : "text-bear-light"
            }`}
          >
            <motion.div
              className={`flex items-center justify-center w-7 h-7 rounded-lg ${
                isPositive ? "bg-bull/[0.15]" : "bg-bear/[0.15]"
              }`}
              animate={{ y: isPositive ? [0, -2, 0] : [0, 2, 0] }}
              transition={{ duration: 1.5, repeat: Infinity }}
            >
              {isPositive ? (
                <svg
                  className="w-3.5 h-3.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={3}
                    d="M5 15l7-7 7 7"
                  />
                </svg>
              ) : (
                <svg
                  className="w-3.5 h-3.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={3}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              )}
            </motion.div>
            <span>${Math.abs(quote.change).toFixed(2)}</span>
            <span className="text-slate-400 text-base">
              ({isPositive ? "+" : ""}
              {quote.changePercent.toFixed(2)}%)
            </span>
          </div>
        </motion.div>
      </div>

      <motion.div
        className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 sm:gap-3 pt-5 border-t border-white/[0.06]"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
      >
        <StatCard label="Open" value={`${quote.open.toFixed(2)}`} />
        <StatCard
          label="Day High"
          value={`${quote.dayHigh.toFixed(2)}`}
          variant="bull"
        />
        <StatCard
          label="Day Low"
          value={`${quote.dayLow.toFixed(2)}`}
          variant="bear"
        />
        <StatCard label="Volume" value={formatVolume(quote.volume)} />
        <StatCard label="Avg Volume" value={formatVolume(quote.avgVolume)} />
        <StatCard label="Market Cap" value={formatNumber(quote.marketCap)} />
      </motion.div>
    </motion.div>
  );
};

const StatCard: React.FC<{
  label: string;
  value: string;
  variant?: "bull" | "bear";
}> = ({ label, value, variant }) => (
  <div className="p-2.5 sm:p-3 rounded-lg bg-white/[0.02] border border-white/[0.05]">
    <div className="text-[9px] text-slate-500 mb-0.5 font-semibold tracking-wider uppercase">
      {label}
    </div>
    <div
      className={`text-sm sm:text-base font-bold ${
        variant === "bull"
          ? "text-bull-light"
          : variant === "bear"
          ? "text-bear-light"
          : "text-white"
      }`}
    >
      {value}
    </div>
  </div>
);

export default StockHeader;
