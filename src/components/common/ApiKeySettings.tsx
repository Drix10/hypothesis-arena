/**
 * API Key Settings Modal
 * Allows users to view, update, and delete their saved API keys
 */

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  getApiKey,
  getFmpApiKey,
  setApiKey,
  setFmpApiKey,
  clearGeminiKey,
  clearFmpKey,
  getMaskedApiKey,
  getMaskedFmpApiKey,
  isPersistenceEnabled,
  setPersistenceEnabled,
  testApiKey,
} from "../../services/apiKeyManager";

interface ApiKeySettingsProps {
  isOpen: boolean;
  onClose: () => void;
  onKeysCleared: () => void;
}

export const ApiKeySettings: React.FC<ApiKeySettingsProps> = ({
  isOpen,
  onClose,
  onKeysCleared,
}) => {
  const [persistKeys, setPersistKeys] = useState(isPersistenceEnabled());
  const [showGeminiInput, setShowGeminiInput] = useState(false);
  const [showFmpInput, setShowFmpInput] = useState(false);
  const [newGeminiKey, setNewGeminiKey] = useState("");
  const [newFmpKey, setNewFmpKey] = useState("");
  const [showNewGeminiKey, setShowNewGeminiKey] = useState(false);
  const [showNewFmpKey, setShowNewFmpKey] = useState(false);
  const [isTestingGemini, setIsTestingGemini] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  // Force re-render after key operations
  const [keyVersion, setKeyVersion] = useState(0);

  // Refs for cleanup
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);

  // Compute key states fresh when keyVersion changes (after key operations)
  const { maskedGemini, maskedFmp, hasGemini, hasFmp } = useMemo(
    () => ({
      maskedGemini: getMaskedApiKey(),
      maskedFmp: getMaskedFmpApiKey(),
      hasGemini: !!getApiKey(),
      hasFmp: !!getFmpApiKey(),
    }),
    [keyVersion]
  );

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (successTimeoutRef.current) {
        clearTimeout(successTimeoutRef.current);
      }
    };
  }, []);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setPersistKeys(isPersistenceEnabled());
      setShowGeminiInput(false);
      setShowFmpInput(false);
      setNewGeminiKey("");
      setNewFmpKey("");
      setError(null);
      setSuccess(null);
      setKeyVersion((v) => v + 1); // Force refresh of key states
    }
  }, [isOpen]);

  // Handle Escape key to close modal
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // Safe success message setter with cleanup
  const showSuccessMessage = useCallback((message: string) => {
    if (successTimeoutRef.current) {
      clearTimeout(successTimeoutRef.current);
    }
    setSuccess(message);
    successTimeoutRef.current = setTimeout(() => {
      if (isMountedRef.current) {
        setSuccess(null);
      }
    }, 3000);
  }, []);

  const handlePersistToggle = useCallback(() => {
    const newValue = !persistKeys;
    setPersistKeys(newValue);
    setPersistenceEnabled(newValue);
    showSuccessMessage(
      newValue
        ? "Keys will be saved for future sessions"
        : "Keys will only be stored for this session"
    );
  }, [persistKeys, showSuccessMessage]);

  const handleUpdateGeminiKey = async () => {
    if (!newGeminiKey.trim() || isTestingGemini) return;

    setIsTestingGemini(true);
    setError(null);

    try {
      await testApiKey(newGeminiKey.trim());
      setApiKey(newGeminiKey.trim());
      setShowGeminiInput(false);
      setNewGeminiKey("");
      setKeyVersion((v) => v + 1); // Force refresh
      showSuccessMessage("Gemini API key updated successfully");
    } catch (err) {
      if (isMountedRef.current) {
        setError(err instanceof Error ? err.message : "Failed to validate key");
      }
    } finally {
      if (isMountedRef.current) {
        setIsTestingGemini(false);
      }
    }
  };

  const handleUpdateFmpKey = () => {
    if (!newFmpKey.trim()) return;
    setFmpApiKey(newFmpKey.trim());
    setShowFmpInput(false);
    setNewFmpKey("");
    setKeyVersion((v) => v + 1); // Force refresh
    showSuccessMessage("FMP API key updated successfully");
  };

  const handleDeleteGeminiKey = () => {
    if (
      confirm(
        "Delete Gemini API key? You'll need to re-enter it to use the app."
      )
    ) {
      clearGeminiKey();
      setKeyVersion((v) => v + 1); // Force refresh before callback
      onKeysCleared();
    }
  };

  const handleDeleteFmpKey = () => {
    if (confirm("Delete FMP API key?")) {
      clearFmpKey();
      setKeyVersion((v) => v + 1); // Force refresh to update UI
      showSuccessMessage("FMP API key deleted");
    }
  };

  const handleDeleteAllKeys = () => {
    if (
      confirm(
        "Delete all API keys? You'll need to re-enter them to use the app."
      )
    ) {
      clearGeminiKey();
      clearFmpKey();
      setKeyVersion((v) => v + 1); // Force refresh before callback
      onKeysCleared();
    }
  };

  // Handle keyboard for toggle switch
  const handleToggleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handlePersistToggle();
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="api-key-settings-title"
            className="glass-card rounded-2xl p-6 max-w-lg w-full max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
              <h2
                id="api-key-settings-title"
                className="text-xl font-serif font-bold text-white flex items-center gap-2"
              >
                <span className="text-2xl">🔑</span>
                API Key Settings
              </h2>
              <button
                onClick={onClose}
                aria-label="Close settings"
                className="text-slate-400 hover:text-white transition-colors text-xl p-1"
              >
                ✕
              </button>
            </div>

            {/* Success/Error Messages */}
            <AnimatePresence>
              {success && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="mb-4 p-3 rounded-lg bg-bull/10 border border-bull/20 text-bull-light text-sm"
                >
                  ✓ {success}
                </motion.div>
              )}
              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="mb-4 p-3 rounded-lg bg-bear/10 border border-bear/20 text-bear-light text-sm"
                >
                  ⚠ {error}
                </motion.div>
              )}
            </AnimatePresence>

            {/* Persistence Toggle */}
            <div className="mb-6 p-4 rounded-xl bg-white/[0.02] border border-white/[0.06]">
              <label className="flex items-center justify-between cursor-pointer">
                <div>
                  <div className="text-sm font-medium text-white">
                    Remember API Keys
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    Save keys in browser for future sessions
                  </div>
                </div>
                <div
                  role="switch"
                  aria-checked={persistKeys}
                  tabIndex={0}
                  onKeyDown={handleToggleKeyDown}
                  className={`relative w-11 h-6 rounded-full transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-cyan/50 ${
                    persistKeys ? "bg-cyan" : "bg-slate-600"
                  }`}
                  onClick={handlePersistToggle}
                >
                  <div
                    className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                      persistKeys ? "translate-x-5" : ""
                    }`}
                  />
                </div>
              </label>
            </div>

            {/* Gemini API Key */}
            <div className="mb-4 p-4 rounded-xl bg-white/[0.02] border border-white/[0.06]">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-cyan">🤖</span>
                  <span className="text-sm font-medium text-white">
                    Gemini API Key
                  </span>
                  <span className="text-bear-light text-xs">*Required</span>
                </div>
                {hasGemini && !showGeminiInput && (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setShowGeminiInput(true)}
                      className="text-xs text-cyan hover:text-cyan-light transition-colors"
                    >
                      Update
                    </button>
                    <button
                      onClick={handleDeleteGeminiKey}
                      className="text-xs text-bear-light hover:text-bear transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>

              {showGeminiInput ? (
                <div className="space-y-2">
                  <div className="relative">
                    <input
                      type={showNewGeminiKey ? "text" : "password"}
                      value={newGeminiKey}
                      onChange={(e) => setNewGeminiKey(e.target.value)}
                      placeholder="Enter new Gemini API key"
                      className="w-full px-3 py-2 pr-10 bg-arena-deep border border-white/[0.08] rounded-lg text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan/50"
                    />
                    <button
                      type="button"
                      onClick={() => setShowNewGeminiKey(!showNewGeminiKey)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                    >
                      {showNewGeminiKey ? "🙈" : "👁️"}
                    </button>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={handleUpdateGeminiKey}
                      disabled={!newGeminiKey.trim() || isTestingGemini}
                      className="flex-1 px-3 py-1.5 bg-cyan/20 hover:bg-cyan/30 border border-cyan/30 rounded-lg text-cyan text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isTestingGemini ? "Verifying..." : "Save"}
                    </button>
                    <button
                      onClick={() => {
                        setShowGeminiInput(false);
                        setNewGeminiKey("");
                      }}
                      className="px-3 py-1.5 bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.08] rounded-lg text-slate-400 text-xs"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="text-sm text-slate-400 font-mono">
                  {hasGemini ? maskedGemini : "Not set"}
                </div>
              )}
            </div>

            {/* FMP API Key */}
            <div className="mb-6 p-4 rounded-xl bg-white/[0.02] border border-white/[0.06]">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-gold">📊</span>
                  <span className="text-sm font-medium text-white">
                    FMP API Key
                  </span>
                  <span className="text-slate-500 text-xs">Optional</span>
                </div>
                {hasFmp && !showFmpInput && (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setShowFmpInput(true)}
                      className="text-xs text-cyan hover:text-cyan-light transition-colors"
                    >
                      Update
                    </button>
                    <button
                      onClick={handleDeleteFmpKey}
                      className="text-xs text-bear-light hover:text-bear transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                )}
                {!hasFmp && !showFmpInput && (
                  <button
                    onClick={() => setShowFmpInput(true)}
                    className="text-xs text-cyan hover:text-cyan-light transition-colors"
                  >
                    Add
                  </button>
                )}
              </div>

              {showFmpInput ? (
                <div className="space-y-2">
                  <div className="relative">
                    <input
                      type={showNewFmpKey ? "text" : "password"}
                      value={newFmpKey}
                      onChange={(e) => setNewFmpKey(e.target.value)}
                      placeholder="Enter FMP API key"
                      className="w-full px-3 py-2 pr-10 bg-arena-deep border border-white/[0.08] rounded-lg text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-gold/50"
                    />
                    <button
                      type="button"
                      onClick={() => setShowNewFmpKey(!showNewFmpKey)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                    >
                      {showNewFmpKey ? "🙈" : "👁️"}
                    </button>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={handleUpdateFmpKey}
                      disabled={!newFmpKey.trim()}
                      className="flex-1 px-3 py-1.5 bg-gold/20 hover:bg-gold/30 border border-gold/30 rounded-lg text-gold text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => {
                        setShowFmpInput(false);
                        setNewFmpKey("");
                      }}
                      className="px-3 py-1.5 bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.08] rounded-lg text-slate-400 text-xs"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="text-sm text-slate-400 font-mono">
                  {hasFmp ? maskedFmp : "Not set (using demo)"}
                </div>
              )}
            </div>

            {/* Delete All */}
            <div className="pt-4 border-t border-white/[0.06]">
              <button
                onClick={handleDeleteAllKeys}
                className="w-full px-4 py-2.5 bg-bear/10 hover:bg-bear/20 border border-bear/20 rounded-lg text-bear-light text-sm font-medium transition-colors"
              >
                🗑️ Delete All Keys & Sign Out
              </button>
              <p className="text-[10px] text-slate-600 text-center mt-2">
                This will remove all saved keys and return to the login screen
              </p>
            </div>

            {/* Help Links */}
            <div className="mt-4 pt-4 border-t border-white/[0.06] text-center space-y-1">
              <p className="text-xs text-slate-500">
                Get your free Gemini key from{" "}
                <a
                  href="https://aistudio.google.com/app/apikey"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-cyan hover:text-cyan-light"
                >
                  Google AI Studio →
                </a>
              </p>
              <p className="text-xs text-slate-500">
                Get FMP key from{" "}
                <a
                  href="https://financialmodelingprep.com/developer/docs"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-gold hover:text-gold-light"
                >
                  Financial Modeling Prep →
                </a>
              </p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default ApiKeySettings;
