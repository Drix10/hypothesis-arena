/**
 * Compare Stocks Component - Strategic Arena Theme
 * Side-by-side comparison of multiple stock analyses
 */

import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { SavedAnalysis, getSavedAnalyses } from "../../services/storageService";

interface CompareStocksProps {
  onClose: () => void;
}

const MetricRow: React.FC<{
  label: string;
  values: (string | number | null)[];
  format?: "number" | "percent" | "currency";
  highlight?: "high" | "low";
  index?: number;
}> = ({ label, values, format = "number", highlight, index = 0 }) => {
  const formatValue = (v: string | number | null): string => {
    if (v === null || v === undefined) return "—";
    if (typeof v === "string") return v;
    switch (format) {
      case "percent":
        return `${v.toFixed(1)}%`;
      case "currency":
        return `$${v.toFixed(2)}`;
      default:
        return v.toFixed(2);
    }
  };

  const numericValues = values.map((v) => (typeof v === "number" ? v : null));
  const validValues = numericValues.filter((v): v is number => v !== null);
  // Guard against empty array (Math.max/min returns Infinity/-Infinity)
  const best =
    validValues.length > 0
      ? highlight === "high"
        ? Math.max(...validValues)
        : Math.min(...validValues)
      : null;

  return (
    <motion.div
      className="grid grid-cols-[200px_repeat(auto-fill,minmax(150px,1fr))] gap-4 py-2 border-b border-white/5"
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.02 }}
    >
      <span className="text-sm text-slate-400">{label}</span>
      {values.map((v, i) => {
        const isBest =
          highlight &&
          best !== null &&
          typeof v === "number" &&
          v === best &&
          validValues.length > 1;
        return (
          <motion.span
            key={i}
            className={`text-sm font-medium ${
              isBest ? "text-cyan" : "text-white"
            }`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: index * 0.02 + i * 0.05 }}
          >
            {formatValue(v)}
            {isBest && <span className="text-gold ml-1">★</span>}
          </motion.span>
        );
      })}
    </motion.div>
  );
};

export const CompareStocks: React.FC<CompareStocksProps> = ({ onClose }) => {
  const [savedAnalyses] = useState<SavedAnalysis[]>(getSavedAnalyses());
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const modalRef = React.useRef<HTMLDivElement>(null);
  const closeButtonRef = React.useRef<HTMLButtonElement>(null);

  // Handle escape key and focus trap
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      // Focus trap
      if (e.key === "Tab" && modalRef.current) {
        const focusableElements =
          modalRef.current.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
          );
        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        if (e.shiftKey && document.activeElement === firstElement) {
          e.preventDefault();
          lastElement?.focus();
        } else if (!e.shiftKey && document.activeElement === lastElement) {
          e.preventDefault();
          firstElement?.focus();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    // Focus close button on mount
    closeButtonRef.current?.focus();
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const selectedAnalyses = savedAnalyses.filter((a) =>
    selectedIds.includes(a.id)
  );

  const toggleSelection = (id: string) => {
    if (selectedIds.includes(id)) {
      setSelectedIds(selectedIds.filter((i) => i !== id));
    } else if (selectedIds.length < 4) {
      setSelectedIds([...selectedIds, id]);
    }
  };

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 bg-arena-deep/90 backdrop-blur-sm z-50 flex items-center justify-center p-6"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        <motion.div
          ref={modalRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="compare-modal-title"
          className="glass-card border border-white/10 rounded-2xl max-w-6xl w-full max-h-[90vh] overflow-hidden flex flex-col"
          initial={{ scale: 0.9, opacity: 0, y: 20 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.9, opacity: 0, y: 20 }}
          transition={{ type: "spring", damping: 25 }}
        >
          {/* Header */}
          <div className="px-6 py-4 border-b border-white/5 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-2xl" aria-hidden="true">
                ⚖️
              </span>
              <h2
                id="compare-modal-title"
                className="text-xl font-semibold text-white"
              >
                Compare Stocks
              </h2>
              <span className="text-xs text-slate-500 bg-white/5 px-2 py-1 rounded-full">
                Select up to 4 analyses
              </span>
            </div>
            <motion.button
              ref={closeButtonRef}
              onClick={onClose}
              className="p-2 text-slate-500 hover:text-white transition-colors"
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.9 }}
              aria-label="Close comparison modal"
            >
              ✕
            </motion.button>
          </div>

          <div className="flex-1 overflow-auto p-6 scrollbar-thin">
            {savedAnalyses.length === 0 ? (
              <motion.div
                className="text-center py-12 text-slate-500"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
              >
                No saved analyses to compare. Save some analyses first!
              </motion.div>
            ) : (
              <>
                {/* Selection */}
                <motion.div
                  className="mb-6"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                >
                  <h3 className="text-sm font-medium text-slate-400 mb-3">
                    Select analyses to compare:
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {savedAnalyses.map((analysis, index) => (
                      <motion.button
                        key={analysis.id}
                        onClick={() => toggleSelection(analysis.id)}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                          selectedIds.includes(analysis.id)
                            ? "bg-cyan/20 text-cyan border border-cyan/30 shadow-glow-cyan"
                            : "bg-white/5 text-slate-400 border border-white/10 hover:border-white/20"
                        }`}
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ delay: index * 0.03 }}
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                      >
                        {analysis.ticker}
                      </motion.button>
                    ))}
                  </div>
                </motion.div>

                {/* Comparison Table */}
                {selectedAnalyses.length >= 2 && (
                  <motion.div
                    className="space-y-6"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.2 }}
                  >
                    {/* Header Row */}
                    <motion.div
                      className="grid grid-cols-[200px_repeat(auto-fill,minmax(150px,1fr))] gap-4 pb-4 border-b border-white/10"
                      initial={{ opacity: 0, y: -10 }}
                      animate={{ opacity: 1, y: 0 }}
                    >
                      <span className="text-sm font-medium text-slate-500">
                        Metric
                      </span>
                      {selectedAnalyses.map((a, i) => (
                        <motion.div
                          key={a.id}
                          className="text-center"
                          initial={{ opacity: 0, y: -10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: i * 0.1 }}
                        >
                          <div className="text-lg font-semibold text-white">
                            {a.ticker}
                          </div>
                          <div className="text-xs text-slate-500">
                            {a.companyName}
                          </div>
                        </motion.div>
                      ))}
                    </motion.div>

                    {/* Recommendation */}
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.1 }}
                    >
                      <h4 className="text-sm font-medium text-slate-300 mb-3">
                        Recommendation
                      </h4>
                      <MetricRow
                        label="Verdict"
                        values={selectedAnalyses.map((a) =>
                          a.recommendation.recommendation
                            .replace("_", " ")
                            .toUpperCase()
                        )}
                        index={0}
                      />
                      <MetricRow
                        label="Confidence"
                        values={selectedAnalyses.map(
                          (a) => a.recommendation.confidence
                        )}
                        format="percent"
                        highlight="high"
                        index={1}
                      />
                      <MetricRow
                        label="Upside"
                        values={selectedAnalyses.map(
                          (a) => a.recommendation.upside
                        )}
                        format="percent"
                        highlight="high"
                        index={2}
                      />
                      <MetricRow
                        label="Current Price"
                        values={selectedAnalyses.map(
                          (a) => a.recommendation.currentPrice
                        )}
                        format="currency"
                        index={3}
                      />
                      <MetricRow
                        label="Target Price"
                        values={selectedAnalyses.map(
                          (a) => a.recommendation.priceTarget.base
                        )}
                        format="currency"
                        index={4}
                      />
                    </motion.div>

                    {/* Valuation */}
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.2 }}
                    >
                      <h4 className="text-sm font-medium text-slate-300 mb-3">
                        Valuation
                      </h4>
                      <MetricRow
                        label="P/E Ratio"
                        values={selectedAnalyses.map(
                          (a) => a.stockData.fundamentals.peRatio
                        )}
                        highlight="low"
                        index={5}
                      />
                      <MetricRow
                        label="PEG Ratio"
                        values={selectedAnalyses.map(
                          (a) => a.stockData.fundamentals.pegRatio
                        )}
                        highlight="low"
                        index={6}
                      />
                      <MetricRow
                        label="Price/Book"
                        values={selectedAnalyses.map(
                          (a) => a.stockData.fundamentals.priceToBook
                        )}
                        highlight="low"
                        index={7}
                      />
                    </motion.div>

                    {/* Profitability */}
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.3 }}
                    >
                      <h4 className="text-sm font-medium text-slate-300 mb-3">
                        Profitability
                      </h4>
                      <MetricRow
                        label="Profit Margin"
                        values={selectedAnalyses.map((a) =>
                          a.stockData.fundamentals.profitMargin
                            ? a.stockData.fundamentals.profitMargin * 100
                            : null
                        )}
                        format="percent"
                        highlight="high"
                        index={8}
                      />
                      <MetricRow
                        label="ROE"
                        values={selectedAnalyses.map((a) =>
                          a.stockData.fundamentals.returnOnEquity
                            ? a.stockData.fundamentals.returnOnEquity * 100
                            : null
                        )}
                        format="percent"
                        highlight="high"
                        index={9}
                      />
                      <MetricRow
                        label="Revenue Growth"
                        values={selectedAnalyses.map((a) =>
                          a.stockData.fundamentals.revenueGrowth
                            ? a.stockData.fundamentals.revenueGrowth * 100
                            : null
                        )}
                        format="percent"
                        highlight="high"
                        index={10}
                      />
                    </motion.div>

                    {/* Technical */}
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.4 }}
                    >
                      <h4 className="text-sm font-medium text-slate-300 mb-3">
                        Technical
                      </h4>
                      <MetricRow
                        label="RSI (14)"
                        values={selectedAnalyses.map(
                          (a) => a.stockData.technicals.rsi14
                        )}
                        index={11}
                      />
                      <MetricRow
                        label="Volatility"
                        values={selectedAnalyses.map(
                          (a) => a.stockData.technicals.volatility
                        )}
                        format="percent"
                        highlight="low"
                        index={12}
                      />
                      <MetricRow
                        label="Trend"
                        values={selectedAnalyses.map((a) =>
                          a.stockData.technicals.trend.replace("_", " ")
                        )}
                        index={13}
                      />
                    </motion.div>

                    {/* Risk */}
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.5 }}
                    >
                      <h4 className="text-sm font-medium text-slate-300 mb-3">
                        Risk
                      </h4>
                      <MetricRow
                        label="Risk Level"
                        values={selectedAnalyses.map((a) =>
                          a.recommendation.riskLevel.replace("_", " ")
                        )}
                        index={14}
                      />
                      <MetricRow
                        label="Debt/Equity"
                        values={selectedAnalyses.map(
                          (a) => a.stockData.fundamentals.debtToEquity
                        )}
                        highlight="low"
                        index={15}
                      />
                      <MetricRow
                        label="Suggested Allocation"
                        values={selectedAnalyses.map(
                          (a) => a.recommendation.suggestedAllocation
                        )}
                        format="percent"
                        index={16}
                      />
                    </motion.div>
                  </motion.div>
                )}

                {selectedAnalyses.length < 2 && selectedAnalyses.length > 0 && (
                  <motion.div
                    className="text-center py-8 text-slate-500"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                  >
                    Select at least 2 analyses to compare
                  </motion.div>
                )}
              </>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};

export default CompareStocks;
