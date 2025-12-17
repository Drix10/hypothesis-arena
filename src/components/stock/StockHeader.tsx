/**
 * Stock Header Component - Dark Theme
 */

import React from "react";
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
    <div className="bg-surface border border-white/5 rounded-2xl p-6">
      {/* Top Row */}
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-4 mb-2">
            <h1 className="text-4xl font-bold text-white">{quote.ticker}</h1>
            <span className="px-3 py-1 text-xs font-medium text-slate-400 bg-white/5 rounded-full">
              {profile.exchange}
            </span>
          </div>
          <p className="text-lg text-slate-400">{profile.name}</p>
          <div className="flex items-center gap-4 mt-2 text-sm text-slate-500">
            <span>{profile.sector}</span>
            <span className="w-1 h-1 bg-slate-600 rounded-full" />
            <span>{profile.industry}</span>
          </div>
        </div>

        <div className="text-right">
          <div className="text-5xl font-bold text-white mb-1">
            ${quote.price.toFixed(2)}
          </div>
          <div
            className={`flex items-center justify-end gap-2 text-lg font-semibold ${
              isPositive ? "text-emerald-400" : "text-red-400"
            }`}
          >
            <span
              className={`w-0 h-0 border-l-[6px] border-r-[6px] border-transparent ${
                isPositive
                  ? "border-b-[8px] border-b-emerald-400"
                  : "border-t-[8px] border-t-red-400"
              }`}
            />
            <span>${Math.abs(quote.change).toFixed(2)}</span>
            <span className="text-slate-500">
              ({isPositive ? "+" : ""}
              {quote.changePercent.toFixed(2)}%)
            </span>
          </div>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-3 md:grid-cols-6 gap-4 pt-6 border-t border-white/5">
        <StatItem label="Open" value={`$${quote.open.toFixed(2)}`} />
        <StatItem
          label="High"
          value={`$${quote.dayHigh.toFixed(2)}`}
          highlight="emerald"
        />
        <StatItem
          label="Low"
          value={`$${quote.dayLow.toFixed(2)}`}
          highlight="red"
        />
        <StatItem label="Volume" value={formatVolume(quote.volume)} />
        <StatItem label="Avg Vol" value={formatVolume(quote.avgVolume)} />
        <StatItem label="Mkt Cap" value={formatNumber(quote.marketCap)} />
      </div>
    </div>
  );
};

const StatItem: React.FC<{
  label: string;
  value: string;
  highlight?: "emerald" | "red";
}> = ({ label, value, highlight }) => (
  <div>
    <div className="text-xs text-slate-500 mb-1">{label}</div>
    <div
      className={`text-sm font-semibold ${
        highlight === "emerald"
          ? "text-emerald-400"
          : highlight === "red"
          ? "text-red-400"
          : "text-white"
      }`}
    >
      {value}
    </div>
  </div>
);

export default StockHeader;
