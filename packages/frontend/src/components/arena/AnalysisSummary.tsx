/**
 * Analysis Summary - Overview with cinematic metrics display
 */

import React, { useMemo } from "react";
import { AIAnalysis } from "./types";
import { CircularMeter } from "../ui";

interface AnalysisSummaryProps {
  analyses: AIAnalysis[];
  symbol: string;
}

export const AnalysisSummary: React.FC<AnalysisSummaryProps> = ({
  analyses,
  symbol,
}) => {
  const summary = useMemo(() => {
    if (!analyses || analyses.length === 0) {
      return {
        bulls: 0,
        bears: 0,
        neutral: 0,
        avgConfidence: 0,
        total: 1,
        bullPercent: 0,
        bearPercent: 0,
      };
    }
    const bulls = analyses.filter((a) =>
      ["strong_buy", "buy"].includes(a.recommendation)
    ).length;
    const bears = analyses.filter((a) =>
      ["strong_sell", "sell"].includes(a.recommendation)
    ).length;
    const total = analyses.length;
    const avgConfidence =
      analyses.reduce((sum, a) => sum + (a.confidence || 0), 0) / total;
    const bullPercent = (bulls / total) * 100;
    const bearPercent = (bears / total) * 100;
    return {
      bulls,
      bears,
      neutral: total - bulls - bears,
      avgConfidence: Number.isFinite(avgConfidence) ? avgConfidence : 0,
      total,
      bullPercent,
      bearPercent,
    };
  }, [analyses]);

  const displaySymbol = symbol
    .replace("cmt_", "")
    .replace("usdt", "")
    .toUpperCase();

  // Determine overall sentiment
  const sentiment =
    summary.bulls > summary.bears
      ? "BULLISH"
      : summary.bears > summary.bulls
      ? "BEARISH"
      : "NEUTRAL";
  const sentimentColor =
    sentiment === "BULLISH"
      ? "#4ADE80"
      : sentiment === "BEARISH"
      ? "#F43F5E"
      : "#FFD54F";

  return (
    <div
      className="relative overflow-hidden rounded-2xl"
      style={{
        background:
          "linear-gradient(165deg, rgba(20,31,50,0.95) 0%, rgba(10,18,32,0.9) 100%)",
        border: "1px solid rgba(255,255,255,0.06)",
        boxShadow:
          "0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.03)",
      }}
    >
      {/* Diagonal accent */}
      <div
        className="absolute top-0 right-0 w-64 h-64 opacity-10 pointer-events-none"
        style={{
          background: `linear-gradient(135deg, ${sentimentColor} 0%, transparent 60%)`,
          clipPath: "polygon(100% 0, 0 0, 100% 100%)",
        }}
      />

      {/* Scanlines */}
      <div
        className="absolute inset-0 opacity-[0.02] pointer-events-none"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.03) 2px, rgba(255,255,255,0.03) 4px)",
        }}
      />

      <div className="relative p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h3 className="text-xl font-bold text-white">Analysis Summary</h3>
            <p className="text-sm text-slate-500">
              {displaySymbol}/USDT • {analyses.length} Analysts
            </p>
          </div>
          <div
            className="px-4 py-2 rounded-lg"
            style={{
              background: `${sentimentColor}15`,
              border: `1px solid ${sentimentColor}40`,
            }}
          >
            <span
              className="text-sm font-black tracking-wider"
              style={{ color: sentimentColor }}
            >
              {sentiment}
            </span>
          </div>
        </div>

        {/* Metrics Row */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-6 mb-6">
          <div className="text-center">
            <CircularMeter
              label="BULLISH"
              value={summary.bullPercent}
              color="#4ADE80"
              size={70}
            />
            <div className="text-2xl font-bold text-green-400 mt-2">
              {summary.bulls}
            </div>
          </div>
          <div className="text-center">
            <CircularMeter
              label="BEARISH"
              value={summary.bearPercent}
              color="#F43F5E"
              size={70}
            />
            <div className="text-2xl font-bold text-rose-400 mt-2">
              {summary.bears}
            </div>
          </div>
          <div className="text-center">
            <CircularMeter
              label="NEUTRAL"
              value={(summary.neutral / summary.total) * 100}
              color="#FFD54F"
              size={70}
            />
            <div className="text-2xl font-bold text-yellow-400 mt-2">
              {summary.neutral}
            </div>
          </div>
          <div className="text-center">
            <CircularMeter
              label="AVG CONFIDENCE"
              value={summary.avgConfidence}
              color="#06B6D4"
              size={70}
            />
            <div className="text-2xl font-bold text-cyan-400 mt-2">
              {summary.avgConfidence.toFixed(0)}%
            </div>
          </div>
        </div>

        {/* Sentiment Bar */}
        <div>
          <div className="flex justify-between text-[10px] text-slate-500 mb-2">
            <span>BULL ({summary.bulls})</span>
            <span>SENTIMENT DISTRIBUTION</span>
            <span>BEAR ({summary.bears})</span>
          </div>
          <div className="h-4 rounded-full overflow-hidden bg-slate-900/50 border border-white/5 flex">
            <div
              className="h-full transition-all duration-500"
              style={{
                width: `${summary.bullPercent}%`,
                background: "linear-gradient(90deg, #22C55E 0%, #4ADE80 100%)",
              }}
            />
            <div
              className="h-full transition-all duration-500 bg-slate-600"
              style={{ width: `${(summary.neutral / summary.total) * 100}%` }}
            />
            <div
              className="h-full transition-all duration-500"
              style={{
                width: `${summary.bearPercent}%`,
                background: "linear-gradient(90deg, #FB7185 0%, #F43F5E 100%)",
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
