/**
 * Saved Analyses Component - Strategic Arena Theme
 */

import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  SavedAnalysis,
  getSavedAnalyses,
  deleteSavedAnalysis,
  downloadAnalysisJSON,
} from "../../services/storageService";

interface SavedAnalysesProps {
  onLoadAnalysis: (analysis: SavedAnalysis) => void;
}

export const SavedAnalyses: React.FC<SavedAnalysesProps> = ({
  onLoadAnalysis,
}) => {
  const [analyses, setAnalyses] = useState<SavedAnalysis[]>([]);
  const [isExpanded, setIsExpanded] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    setAnalyses(getSavedAnalyses());
  }, []);

  const handleDeleteClick = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDeleteId(id);
  };
  const handleConfirmDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (deleteSavedAnalysis(id)) setAnalyses(getSavedAnalyses());
    setConfirmDeleteId(null);
  };
  const handleCancelDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDeleteId(null);
  };
  const handleDownload = (analysis: SavedAnalysis, e: React.MouseEvent) => {
    e.stopPropagation();
    downloadAnalysisJSON(analysis);
  };

  const formatDate = (timestamp: number): string =>
    new Date(timestamp).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  const getRecommendationColor = (rec: string): string => {
    switch (rec) {
      case "strong_buy":
        return "text-bull-light bg-bull/[0.12] border border-bull/25";
      case "buy":
        return "text-bull-light bg-bull/[0.10] border border-bull/20";
      case "hold":
        return "text-gold-light bg-gold/[0.10] border border-gold/20";
      case "sell":
        return "text-bear-light bg-bear/[0.10] border border-bear/20";
      case "strong_sell":
        return "text-bear-light bg-bear/[0.12] border border-bear/25";
      default:
        return "text-slate-400 bg-slate-500/15 border border-slate-500/20";
    }
  };

  if (analyses.length === 0) return null;

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
        aria-controls="saved-analyses-list"
      >
        <div className="flex items-center gap-2">
          <span className="text-base" aria-hidden="true">
            💾
          </span>
          <h3 className="text-sm font-semibold text-white">Saved Analyses</h3>
          <motion.span
            className="text-[10px] text-slate-500 bg-white/[0.05] px-1.5 py-0.5 rounded-md"
            key={analyses.length}
            initial={{ scale: 0.8 }}
            animate={{ scale: 1 }}
          >
            {analyses.length}
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
            id="saved-analyses-list"
            className="border-t border-white/[0.05] divide-y divide-white/[0.04] max-h-72 overflow-y-auto"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            {analyses.map((analysis, index) => (
              <motion.div
                key={analysis.id}
                className="px-4 py-3 hover:bg-white/[0.02] transition-colors cursor-pointer"
                onClick={() => onLoadAnalysis(analysis)}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: index * 0.04 }}
                whileHover={{ x: 2 }}
              >
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-white font-semibold text-sm">
                        {analysis.ticker}
                      </span>
                      <motion.span
                        className={`px-1.5 py-0.5 text-[9px] rounded ${getRecommendationColor(
                          analysis.recommendation.recommendation
                        )}`}
                      >
                        {analysis.recommendation.recommendation
                          .replace("_", " ")
                          .toUpperCase()}
                      </motion.span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] text-slate-500">
                        {analysis.companyName}
                      </span>
                      <span className="text-[10px] text-slate-600">•</span>
                      <span className="text-[10px] text-slate-600">
                        {formatDate(analysis.savedAt)}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 mt-1.5 text-[10px] text-slate-500">
                      <span>
                        Price: $
                        {analysis.recommendation.currentPrice.toFixed(2)}
                      </span>
                      <span>
                        Target: $
                        {analysis.recommendation.priceTarget.base.toFixed(2)}
                      </span>
                      <span
                        className={
                          analysis.recommendation.upside >= 0
                            ? "text-bull-light"
                            : "text-bear-light"
                        }
                      >
                        {analysis.recommendation.upside >= 0 ? "+" : ""}
                        {analysis.recommendation.upside.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    {confirmDeleteId === analysis.id ? (
                      <motion.div
                        className="flex items-center gap-1"
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                      >
                        <span className="text-[10px] text-slate-400 mr-1">
                          Delete?
                        </span>
                        <motion.button
                          onClick={(e) => handleConfirmDelete(analysis.id, e)}
                          className="px-1.5 py-0.5 text-[10px] bg-bear/20 text-bear-light rounded hover:bg-bear/30"
                          whileTap={{ scale: 0.95 }}
                          aria-label="Confirm delete"
                        >
                          Yes
                        </motion.button>
                        <motion.button
                          onClick={handleCancelDelete}
                          className="px-1.5 py-0.5 text-[10px] text-slate-400 hover:text-white"
                          whileTap={{ scale: 0.95 }}
                          aria-label="Cancel delete"
                        >
                          No
                        </motion.button>
                      </motion.div>
                    ) : (
                      <>
                        <motion.button
                          onClick={(e) => handleDownload(analysis, e)}
                          className="p-1.5 text-slate-500 hover:text-cyan transition-colors text-xs"
                          title="Download JSON"
                          aria-label={`Download ${analysis.ticker} analysis as JSON`}
                          whileTap={{ scale: 0.9 }}
                        >
                          📥
                        </motion.button>
                        <motion.button
                          onClick={(e) => handleDeleteClick(analysis.id, e)}
                          className="p-1.5 text-slate-500 hover:text-bear-light transition-colors text-xs"
                          title="Delete"
                          aria-label={`Delete ${analysis.ticker} analysis`}
                          whileTap={{ scale: 0.9 }}
                        >
                          🗑️
                        </motion.button>
                      </>
                    )}
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

export default SavedAnalyses;
