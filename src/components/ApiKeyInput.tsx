import React, { useState } from "react";
import Icon from "./Icon";
import {
  setApiKey,
  validateApiKeyFormat,
  getMaskedApiKey,
  clearApiKey,
  testApiKey,
} from "../services/apiKeyManager";

interface Props {
  onKeySet: () => void;
  onKeyCleared?: () => void;
}

const ApiKeyInput: React.FC<Props> = ({ onKeySet, onKeyCleared }) => {
  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsValidating(true);

    try {
      const trimmedKey = keyInput.trim();

      if (!trimmedKey) {
        setError("Please enter your API key");
        return;
      }

      if (!validateApiKeyFormat(trimmedKey)) {
        setError("Invalid API key format. Please check your key.");
        return;
      }

      // Validate key with API call
      await testApiKey(trimmedKey);

      // Key is valid, set it
      const success = setApiKey(trimmedKey);
      if (success) {
        setKeyInput("");
        setIsExpanded(false);
        onKeySet();
      } else {
        setError("Failed to set API key. Please try again.");
      }
    } catch (err: any) {
      setError(err.message || "Invalid API key. Please check and try again.");
    } finally {
      // Always reset validation state in finally block
      setIsValidating(false);
    }
  };

  const handleClear = () => {
    // Clear from manager (which overwrites memory)
    clearApiKey();

    // Clear local state
    setKeyInput("");
    setError(null);
    setIsExpanded(true);

    // Notify parent that key was cleared
    if (onKeyCleared) {
      onKeyCleared();
    }
  };

  const maskedKey = getMaskedApiKey();

  if (maskedKey && !isExpanded) {
    return (
      <div className="flex items-center gap-3 px-4 py-2 bg-emerald-950/40 border border-emerald-500/40 rounded-full">
        <Icon
          icon="solar:key-bold-duotone"
          width="16"
          className="text-emerald-400"
        />
        <span className="text-xs font-mono text-emerald-400">{maskedKey}</span>
        <button
          onClick={handleClear}
          className="text-emerald-400/60 hover:text-red-400 transition-colors"
          title="Clear API key"
        >
          <Icon icon="solar:close-circle-bold" width="16" />
        </button>
      </div>
    );
  }

  return (
    <div className="w-full max-w-2xl mx-auto animate-in fade-in slide-in-from-bottom-4 duration-700">
      <form onSubmit={handleSubmit} className="relative">
        {/* Error Message */}
        {error && (
          <div className="absolute -top-14 left-0 right-0 z-30 flex justify-center animate-in slide-in-from-bottom-2 fade-in duration-300">
            <div
              role="alert"
              aria-live="polite"
              className="bg-red-950/90 backdrop-blur-md text-red-200 px-4 py-2 rounded-full text-xs font-mono border border-red-500/50 shadow-lg flex items-center gap-2"
            >
              <Icon icon="solar:danger-triangle-bold" width="14" />
              {error}
            </div>
          </div>
        )}

        <div className="group relative">
          {/* Hover Glow Effect */}
          <div
            className={`absolute -inset-[1px] rounded-2xl bg-gradient-to-r from-transparent via-electric-cyan/60 to-transparent transition-opacity duration-700 ${
              isHovered ? "opacity-100" : "opacity-0"
            }`}
          ></div>

          {/* Main Container */}
          <div className="relative bg-black/90 backdrop-blur-xl rounded-2xl border border-white/10 shadow-2xl ring-1 ring-white/5 transition-all duration-300">
            <div className="p-8">
              {/* Input Bar with Inline Button */}
              <div className="flex items-stretch gap-3">
                {/* Input Field */}
                <div
                  className={`flex-1 flex items-center gap-3 bg-slate-900/50 border rounded-xl px-4 py-3 transition-all duration-300 ${
                    isHovered
                      ? "border-electric-cyan/40 shadow-[0_0_20px_rgba(0,240,255,0.1)]"
                      : "border-slate-700/50"
                  }`}
                >
                  <Icon
                    icon="solar:key-bold-duotone"
                    width="20"
                    className={`flex-shrink-0 transition-colors duration-300 ${
                      isHovered ? "text-electric-cyan" : "text-slate-400"
                    }`}
                  />
                  <input
                    type={showKey ? "text" : "password"}
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    onFocus={() => setIsHovered(true)}
                    onBlur={() => setIsHovered(false)}
                    placeholder="Paste your Gemini API key..."
                    className="flex-1 bg-transparent text-base text-slate-100 placeholder-slate-600 focus:outline-none font-mono selection:bg-electric-cyan/30"
                    autoComplete="off"
                    spellCheck={false}
                    aria-label="API key input"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey(!showKey)}
                    className="text-slate-400 hover:text-electric-cyan transition-colors flex-shrink-0"
                    title={showKey ? "Hide key" : "Show key"}
                  >
                    <Icon
                      icon={
                        showKey ? "solar:eye-closed-bold" : "solar:eye-bold"
                      }
                      width="20"
                    />
                  </button>
                </div>

                {/* Submit Button - Compact */}
                <button
                  type="submit"
                  disabled={isValidating || !keyInput.trim()}
                  className={`relative overflow-hidden bg-slate-100 text-black px-6 py-3 rounded-xl font-bold text-xs uppercase tracking-widest transition-all shadow-[0_0_20px_rgba(255,255,255,0.1)] flex-shrink-0 ${
                    isValidating || !keyInput.trim()
                      ? "cursor-not-allowed opacity-50"
                      : "hover:shadow-[0_0_30px_rgba(255,255,255,0.3)] hover:scale-[1.02] active:scale-[0.98]"
                  }`}
                >
                  {isValidating && (
                    <div className="absolute inset-0 bg-gradient-to-r from-transparent via-electric-cyan/20 to-transparent animate-beam"></div>
                  )}

                  <span className="relative z-10 flex items-center justify-center gap-2 whitespace-nowrap">
                    {isValidating ? (
                      <>
                        <Icon
                          icon="solar:refresh-circle-broken"
                          width="16"
                          className="animate-spin text-slate-700"
                        />
                        <span className="text-slate-800">Checking</span>
                      </>
                    ) : (
                      <>
                        <Icon icon="solar:login-3-bold" width="16" />
                        Unlock
                      </>
                    )}
                  </span>
                </button>
              </div>

              {/* Info Section */}
              <div className="mt-6 pt-6 border-t border-white/5">
                <div className="text-xs text-slate-400 space-y-3">
                  <div className="flex items-start gap-3">
                    <Icon
                      icon="solar:shield-check-bold"
                      width="16"
                      className="mt-0.5 flex-shrink-0 text-emerald-400/60"
                    />
                    <div className="space-y-1">
                      <p className="text-slate-300 font-medium">
                        Secure & Temporary
                      </p>
                      <p className="text-slate-500">
                        Your key is stored in memory only and cleared when you
                        refresh or close the page
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Icon
                      icon="solar:star-bold-duotone"
                      width="16"
                      className="mt-0.5 flex-shrink-0 text-electric-cyan/60"
                    />
                    <div className="space-y-1">
                      <p className="text-slate-300 font-medium">
                        Get Your Free Key
                      </p>
                      <p className="text-slate-500">
                        Visit{" "}
                        <a
                          href="https://aistudio.google.com/apikey"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-electric-cyan hover:underline font-mono"
                        >
                          Get API Key
                        </a>{" "}
                        to generate your API key in seconds
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
};

export default ApiKeyInput;
