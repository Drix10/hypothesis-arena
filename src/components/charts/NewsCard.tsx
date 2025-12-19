/**
 * News Headlines Display - Strategic Arena Theme
 */

import React from "react";
import { motion } from "framer-motion";
import { SentimentAnalysis, NewsItem } from "../../types/stock";

interface NewsCardProps {
  sentiment: SentimentAnalysis;
}

const SentimentBadge: React.FC<{
  sentiment: "positive" | "negative" | "neutral";
}> = ({ sentiment }) => {
  const styles = {
    positive: "bg-bull-muted text-bull-light border-bull/30",
    negative: "bg-bear-muted text-bear-light border-bear/30",
    neutral: "bg-slate-500/20 text-slate-400 border-slate-500/30",
  };
  const icons = { positive: "📈", negative: "📉", neutral: "➡️" };

  return (
    <motion.span
      className={`px-2 py-0.5 text-xs rounded border ${styles[sentiment]}`}
      whileHover={{ scale: 1.05 }}
    >
      {icons[sentiment]} {sentiment}
    </motion.span>
  );
};

const NewsItemRow: React.FC<{ item: NewsItem; index: number }> = ({
  item,
  index,
}) => {
  const timeAgo = (dateStr: string): string => {
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

  return (
    <motion.a
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block p-4 hover:bg-white/[0.02] rounded-xl transition-colors group"
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.05 }}
      whileHover={{ x: 4 }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <h4 className="text-sm text-white font-medium group-hover:text-cyan transition-colors line-clamp-2">
            {item.title}
          </h4>
          {item.summary && (
            <p className="text-xs text-slate-500 mt-1 line-clamp-2">
              {item.summary}
            </p>
          )}
          <div className="flex items-center gap-3 mt-2">
            <span className="text-xs text-slate-600">{item.source}</span>
            <span className="text-xs text-slate-600">•</span>
            <span className="text-xs text-slate-600">
              {timeAgo(item.publishedAt)}
            </span>
          </div>
        </div>
        <SentimentBadge sentiment={item.sentiment} />
      </div>
    </motion.a>
  );
};

export const NewsCard: React.FC<NewsCardProps> = ({ sentiment }) => {
  const sentimentColors = {
    very_bullish: "text-bull-light",
    bullish: "text-bull-light",
    neutral: "text-slate-400",
    bearish: "text-bear-light",
    very_bearish: "text-bear-light",
  };

  const sentimentLabels = {
    very_bullish: "🚀 Very Bullish",
    bullish: "📈 Bullish",
    neutral: "➡️ Neutral",
    bearish: "📉 Bearish",
    very_bearish: "💥 Very Bearish",
  };

  const scoreColor =
    sentiment.overallScore > 0.2
      ? "text-bull-light"
      : sentiment.overallScore < -0.2
      ? "text-bear-light"
      : "text-slate-400";

  return (
    <motion.div
      className="glass-card rounded-2xl overflow-hidden"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
    >
      <div className="px-6 py-4 border-b border-white/5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl">📰</span>
            <h3 className="text-lg font-semibold text-white">
              News & Sentiment
            </h3>
          </div>
          <motion.div
            className={`px-3 py-1 rounded-lg text-sm font-medium ${
              sentimentColors[sentiment.overallSentiment]
            } bg-white/5`}
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.2 }}
          >
            {sentimentLabels[sentiment.overallSentiment]}
          </motion.div>
        </div>
      </div>

      <div className="px-6 py-4 border-b border-white/5 bg-white/[0.01]">
        <div className="grid grid-cols-4 gap-4">
          <motion.div
            className="text-center"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
          >
            <div className="text-xs text-slate-500 mb-1">Score</div>
            <div className={`text-lg font-semibold ${scoreColor}`}>
              {sentiment.overallScore >= 0 ? "+" : ""}
              {sentiment.overallScore.toFixed(2)}
            </div>
          </motion.div>
          <motion.div
            className="text-center"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
          >
            <div className="text-xs text-slate-500 mb-1">Positive</div>
            <div className="text-lg font-semibold text-bull-light">
              {sentiment.positiveCount}
            </div>
          </motion.div>
          <motion.div
            className="text-center"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
          >
            <div className="text-xs text-slate-500 mb-1">Negative</div>
            <div className="text-lg font-semibold text-bear-light">
              {sentiment.negativeCount}
            </div>
          </motion.div>
          <motion.div
            className="text-center"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.25 }}
          >
            <div className="text-xs text-slate-500 mb-1">Neutral</div>
            <div className="text-lg font-semibold text-slate-400">
              {sentiment.neutralCount}
            </div>
          </motion.div>
        </div>

        {/* Enhanced sentiment distribution bar */}
        <div className="mt-4 relative">
          <div className="h-3 bg-gradient-to-r from-arena-deep via-arena-surface to-arena-deep rounded-full overflow-hidden shadow-inner flex">
            {sentiment.newsCount > 0 && (
              <>
                <motion.div
                  className="bg-gradient-to-r from-bull to-bull-light h-full relative"
                  initial={{ width: 0 }}
                  animate={{
                    width: `${
                      (sentiment.positiveCount / sentiment.newsCount) * 100
                    }%`,
                  }}
                  transition={{ duration: 0.6, delay: 0.3, ease: "easeOut" }}
                >
                  <div className="absolute inset-0 bg-bull/30 blur-sm" />
                </motion.div>
                <motion.div
                  className="bg-gradient-to-r from-slate-600 to-slate-500 h-full relative"
                  initial={{ width: 0 }}
                  animate={{
                    width: `${
                      (sentiment.neutralCount / sentiment.newsCount) * 100
                    }%`,
                  }}
                  transition={{ duration: 0.6, delay: 0.35, ease: "easeOut" }}
                >
                  <div className="absolute inset-0 bg-slate-500/20 blur-sm" />
                </motion.div>
                <motion.div
                  className="bg-gradient-to-r from-bear to-bear-light h-full relative"
                  initial={{ width: 0 }}
                  animate={{
                    width: `${
                      (sentiment.negativeCount / sentiment.newsCount) * 100
                    }%`,
                  }}
                  transition={{ duration: 0.6, delay: 0.4, ease: "easeOut" }}
                >
                  <div className="absolute inset-0 bg-bear/30 blur-sm" />
                </motion.div>
              </>
            )}
          </div>
          {/* Subtle glow effect */}
          <div className="absolute inset-0 bg-gradient-to-r from-bull/5 via-transparent to-bear/5 rounded-full blur-md pointer-events-none" />
        </div>
      </div>

      <div className="divide-y divide-white/5 max-h-96 overflow-y-auto scrollbar-thin">
        {sentiment.recentNews.length > 0 ? (
          sentiment.recentNews.map((item, index) => (
            <NewsItemRow key={item.id} item={item} index={index} />
          ))
        ) : (
          <div className="p-8 text-center text-slate-500">
            No recent news available
          </div>
        )}
      </div>
    </motion.div>
  );
};

export default NewsCard;
