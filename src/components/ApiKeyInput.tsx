import React, { useState } from "react";
import Icon from "./Icon";
import {
  setApiKey,
  validateApiKeyFormat,
  getMaskedApiKey,
  clearApiKey,
} from "../services/apiKeyManager";

interface Props {
  onKeySet: () => void;
}

const ApiKeyInput: React.FC<Props> = ({ onKeySet }) => {
  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedKey = keyInput.trim();

    if (!trimmedKey) {
      setError("Please enter your API key");
      return;
    }

    if (!validateApiKeyFormat(trimmedKey)) {
      setError("Invalid API key format. Please check your key.");
      return;
    }

    const success = setApiKey(trimmedKey);
    if (success) {
      setKeyInput("");
      setIsExpanded(false);
      onKeySet();
    } else {
      setError("Failed to set API key. Please try again.");
    }
  };

  const handleClear = () => {
    clearApiKey();
    setKeyInput("");
    setError(null);
    setIsExpanded(true);
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
    <div className="w-full max-w-md">
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="relative">
          <div className="flex items-center gap-2 bg-slate-900/90 border border-slate-700 rounded-lg p-3">
            <Icon
              icon="solar:key-bold-duotone"
              width="18"
              className="text-slate-400"
            />
            <input
              type={showKey ? "text" : "password"}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="Enter your Gemini API key"
              className="flex-1 bg-transparent text-sm text-slate-200 placeholder-slate-500 focus:outline-none font-mono"
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              onClick={() => setShowKey(!showKey)}
              className="text-slate-400 hover:text-slate-200 transition-colors"
              title={showKey ? "Hide key" : "Show key"}
            >
              <Icon
                icon={showKey ? "solar:eye-closed-bold" : "solar:eye-bold"}
                width="18"
              />
            </button>
          </div>

          {error && (
            <div className="absolute -bottom-6 left-0 text-xs text-red-400 font-mono">
              {error}
            </div>
          )}
        </div>

        <button
          type="submit"
          className="w-full py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold rounded-lg transition-colors flex items-center justify-center gap-2"
        >
          <Icon icon="solar:check-circle-bold" width="16" />
          Set API Key
        </button>

        <div className="text-xs text-slate-400 space-y-1">
          <p className="flex items-start gap-2">
            <Icon
              icon="solar:info-circle-bold"
              width="14"
              className="mt-0.5 flex-shrink-0"
            />
            <span>
              Your API key is stored in memory only and never saved to disk
            </span>
          </p>
          <p className="flex items-start gap-2">
            <Icon
              icon="solar:shield-check-bold"
              width="14"
              className="mt-0.5 flex-shrink-0"
            />
            <span>
              Get your free API key at{" "}
              <a
                href="https://ai.google.dev/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-400 hover:underline"
              >
                ai.google.dev
              </a>
            </span>
          </p>
        </div>
      </form>
    </div>
  );
};

export default ApiKeyInput;
