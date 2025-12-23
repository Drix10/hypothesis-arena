/**
 * News Headlines Display - Cinematic Command Center
 * Bold asymmetric design with dramatic lighting effects
 */

import React, { useMemo } from "react";
import { SentimentAnalysis, NewsItem } from "../../types/stock";

interface NewsCardProps {
  sentiment: SentimentAnalysis;
}

// Move config outside component for type safety and performance
const SENTIMENT_BADGE_CONFIG = {
  positive: {
    bg: "rgba(0,255,136,0.12)",
    border: "rgba(0,255,136,0.3)",
    text: "#00ff88",
    icon: "▲",
  },
  negative: {
    bg: "rgba(239,68,68,0.12)",
    border: "rgba(239,68,68,0.3)",
    text: "#ef4444",
    icon: "▼",
  },
  neutral: {
    bg: "rgba(255,215,0,0.12)",
    border: "rgba(255,215,0,0.3)",
    text: "#ffd700",
    icon: "◆",
  },
} as const;

const SentimentBadge: React.FC<{
  sentiment: "positive" | "negative" | "neutral";
}> = ({ sentiment }) => {
  const c = SENTIMENT_BADGE_CONFIG[sentiment];

  return (
    <span
      className="px-2.5 py-1 text-[10px] font-black tracking-wider rounded-md uppercase hover:scale-105 transition-transform"
      style={{
        background: c.bg,
        border: `1px solid ${c.border}`,
        color: c.text,
        textShadow: `0 0 10px ${c.text}40`,
      }}
    >
      {c.icon} {sentiment}
    </span>
  );
};

const getTimeAgo = (dateStr: string): string => {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return "Unknown";
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  if (diffMs < 0) return "Just now";
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays > 0) return `${diffDays}d ago`;
  if (diffHours > 0) return `${diffHours}h ago`;
  return "Just now";
};

const NewsItemRow: React.FC<{ item: NewsItem }> = ({ item }) => {
  const timeAgo = useMemo(
    () => getTimeAgo(item.publishedAt),
    [item.publishedAt]
  );

  return (
    <a
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${item.title} (opens in new tab)`}
      className="block p-4 transition-all group relative overflow-hidden hover:translate-x-1.5"
      style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
    >
      {/* Hover glow */}
      <div
        className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
        style={{
          background:
            "linear-gradient(90deg, rgba(0,240,255,0.05) 0%, transparent 60%)",
        }}
      />

      <div className="flex items-start justify-between gap-4 relative z-10">
        <div className="flex-1 min-w-0">
          <h4
            className="text-sm text-white font-semibold group-hover:text-cyan transition-colors line-clamp-2"
            style={{ fontFamily: "'Space Grotesk', sans-serif" }}
          >
            {item.title}
          </h4>
          {item.summary && (
            <p className="text-xs text-slate-500 mt-1.5 line-clamp-2 leading-relaxed">
              {item.summary}
            </p>
          )}
          <div className="flex items-center gap-3 mt-2.5">
            <span className="text-[10px] text-slate-600 font-medium uppercase tracking-wider">
              {item.source}
            </span>
            <span className="text-slate-700">•</span>
            <span className="text-[10px] text-slate-600 font-mono">
              {timeAgo}
            </span>
          </div>
        </div>
        <SentimentBadge sentiment={item.sentiment} />
      </div>
    </a>
  );
};

// Move sentiment config outside component for type safety
const OVERALL_SENTIMENT_CONFIG = {
  very_bullish: {
    color: "#00ff88",
    glow: "0 0 30px rgba(0,255,136,0.3)",
    label: "VERY BULLISH",
    icon: "⚡",
  },
  bullish: {
    color: "#22c55e",
    glow: "0 0 20px rgba(34,197,94,0.3)",
    label: "BULLISH",
    icon: "↗",
  },
  neutral: {
    color: "#ffd700",
    glow: "0 0 20px rgba(255,215,0,0.3)",
    label: "NEUTRAL",
    icon: "◆",
  },
  bearish: {
    color: "#ef4444",
    glow: "0 0 20px rgba(239,68,68,0.3)",
    label: "BEARISH",
    icon: "↘",
  },
  very_bearish: {
    color: "#dc2626",
    glow: "0 0 30px rgba(220,38,38,0.4)",
    label: "VERY BEARISH",
    icon: "⚠",
  },
} as const;

export const NewsCard: React.FC<NewsCardProps> = ({ sentiment }) => {
  const config = OVERALL_SENTIMENT_CONFIG[sentiment.overallSentiment];
  const scoreColor =
    sentiment.overallScore > 0.2
      ? "#00ff88"
      : sentiment.overallScore < -0.2
      ? "#ef4444"
      : "#ffd700";

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
      {/* Diagonal accent stripe */}
      <div
        className="absolute top-0 right-0 w-32 h-32 opacity-30"
        style={{
          background: `linear-gradient(135deg, ${config.color} 0%, transparent 60%)`,
          clipPath: "polygon(100% 0, 0 0, 100% 100%)",
        }}
      />

      {/* Scanline texture */}
      <div
        className="absolute inset-0 opacity-[0.03] pointer-events-none"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.03) 2px, rgba(255,255,255,0.03) 4px)",
        }}
      />

      {/* Header */}
      <div className="px-6 py-5 border-b border-white/[0.06] relative z-10">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className="w-11 h-11 rounded-xl flex items-center justify-center text-xl"
              style={{
                background:
                  "linear-gradient(145deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.02) 100%)",
                border: "1px solid rgba(255,255,255,0.1)",
                boxShadow: "inset 0 1px 0 rgba(255,255,255,0.1)",
              }}
            >
              📰
            </div>
            <div>
              <h3
                className="text-lg font-bold text-white tracking-tight"
                style={{ fontFamily: "'Space Grotesk', sans-serif" }}
              >
                News & Sentiment
              </h3>
              <p className="text-[10px] text-slate-500 uppercase tracking-wider mt-0.5">
                {sentiment.newsCount} articles analyzed
              </p>
            </div>
          </div>
          <div
            className="px-3 py-1.5 rounded-lg text-[10px] font-black tracking-widest"
            style={{
              background: `${config.color}15`,
              border: `1px solid ${config.color}40`,
              color: config.color,
              boxShadow: config.glow,
            }}
          >
            {config.icon} {config.label}
          </div>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="px-6 py-5 border-b border-white/[0.06] relative z-10">
        <div className="grid grid-cols-4 gap-3">
          {[
            {
              label: "SCORE",
              value: `${
                sentiment.overallScore >= 0 ? "+" : ""
              }${sentiment.overallScore.toFixed(2)}`,
              color: scoreColor,
            },
            {
              label: "POSITIVE",
              value: sentiment.positiveCount.toString(),
              color: "#00ff88",
            },
            {
              label: "NEGATIVE",
              value: sentiment.negativeCount.toString(),
              color: "#ef4444",
            },
            {
              label: "NEUTRAL",
              value: sentiment.neutralCount.toString(),
              color: "#ffd700",
            },
          ].map((stat) => (
            <div
              key={stat.label}
              className="text-center p-3 rounded-lg"
              style={{
                background: "rgba(255,255,255,0.02)",
                border: "1px solid rgba(255,255,255,0.05)",
              }}
            >
              <div className="text-[8px] text-slate-500 uppercase tracking-widest mb-1.5 font-semibold">
                {stat.label}
              </div>
              <div
                className="text-xl font-black"
                style={{
                  color: stat.color,
                  fontFamily: "'Space Grotesk', sans-serif",
                  textShadow: `0 0 20px ${stat.color}40`,
                }}
              >
                {stat.value}
              </div>
            </div>
          ))}
        </div>

        {/* Sentiment Distribution Bar */}
        <div className="mt-5 relative">
          <div className="flex justify-between text-[9px] mb-2">
            <span className="text-green-400 font-mono font-bold">BULLISH</span>
            <span className="text-slate-600 uppercase tracking-wider">
              Distribution
            </span>
            <span className="text-red-400 font-mono font-bold">BEARISH</span>
          </div>
          <div
            className="h-3 rounded-full overflow-hidden flex"
            style={{
              background: "rgba(0,0,0,0.4)",
              border: "1px solid rgba(255,255,255,0.05)",
            }}
          >
            {sentiment.newsCount > 0 && (
              <>
                <div
                  className="h-full relative transition-all duration-500"
                  style={{
                    background:
                      "linear-gradient(90deg, #00ff88 0%, #22c55e 100%)",
                    width: `${
                      (sentiment.positiveCount / sentiment.newsCount) * 100
                    }%`,
                  }}
                />
                <div
                  className="h-full relative transition-all duration-500"
                  style={{
                    background:
                      "linear-gradient(90deg, #ffd700 0%, #f59e0b 100%)",
                    width: `${
                      (sentiment.neutralCount / sentiment.newsCount) * 100
                    }%`,
                  }}
                />
                <div
                  className="h-full relative transition-all duration-500"
                  style={{
                    background:
                      "linear-gradient(90deg, #ef4444 0%, #dc2626 100%)",
                    width: `${
                      (sentiment.negativeCount / sentiment.newsCount) * 100
                    }%`,
                  }}
                />
              </>
            )}
          </div>
        </div>
      </div>

      {/* News List */}
      <div className="max-h-96 overflow-y-auto scrollbar-thin relative z-10">
        {sentiment.recentNews.length > 0 ? (
          sentiment.recentNews.map((item) => (
            <NewsItemRow key={item.id} item={item} />
          ))
        ) : (
          <div className="p-12 text-center">
            <div className="text-4xl mb-3 opacity-30">📭</div>
            <p className="text-slate-500 text-sm">No recent news available</p>
          </div>
        )}
      </div>

      {/* Bottom accent line */}
      <div
        className="absolute bottom-0 left-0 right-0 h-[2px]"
        style={{
          background: `linear-gradient(90deg, transparent, ${config.color}, transparent)`,
        }}
      />
    </div>
  );
};

export default NewsCard;
