/**
 * Header - Main navigation bar
 */

import React from "react";
import { WeexAssets } from "../../services/api/weex";

interface HeaderProps {
  wsConnected: boolean;
  isAuthenticated: boolean;
  assets: WeexAssets | null;
  onLogin: () => void;
  onLogout: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  wsConnected,
  isAuthenticated,
  assets,
  onLogin,
  onLogout,
}) => (
  <header className="border-b border-white/10 glass-card sticky top-0 z-50 rounded-none">
    <div className="px-4 py-3 flex items-center justify-between">
      <div className="flex items-center gap-4">
        {/* Logo */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-400/30 to-purple-500/20 border border-cyan-400/40 flex items-center justify-center shadow-lg shadow-cyan-400/20">
            <span className="text-xl">⚔️</span>
          </div>
          <div>
            <h1 className="font-serif text-lg font-bold text-gradient-cyan">
              Hypothesis Arena
            </h1>
            <p className="text-[10px] text-slate-500">WEEX Hackathon 2025</p>
          </div>
        </div>

        {/* Connection Status */}
        <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 border border-white/10">
          <div
            className={`w-2 h-2 rounded-full ${
              wsConnected ? "bg-green-400 animate-pulse" : "bg-amber-500"
            }`}
          />
          <span className="text-xs text-slate-400">
            {wsConnected ? "Live" : "Polling"}
          </span>
        </div>
      </div>

      {/* Right side */}
      <div className="flex items-center gap-3">
        {isAuthenticated && assets && (
          <div className="hidden md:flex items-center gap-4 px-4 py-2 rounded-xl bg-white/5 border border-white/10">
            <div>
              <p className="text-[10px] text-slate-500 uppercase tracking-wider">
                Equity
              </p>
              <p className="font-mono font-bold text-green-400">
                $
                {(Number(assets.equity) || 0).toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </p>
            </div>
            <div className="w-px h-8 bg-white/10" />
            <div>
              <p className="text-[10px] text-slate-500 uppercase tracking-wider">
                Available
              </p>
              <p className="font-mono text-sm text-white">
                $
                {(Number(assets.available) || 0).toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </p>
            </div>
          </div>
        )}

        {isAuthenticated ? (
          <button
            onClick={onLogout}
            className="px-3 py-2 rounded-lg text-xs font-medium bg-white/5 text-slate-400 border border-white/10 hover:bg-white/10 hover:text-white transition-all"
          >
            Logout
          </button>
        ) : (
          <button
            onClick={onLogin}
            className="btn-primary btn-lift px-4 py-2 rounded-lg text-sm font-semibold"
          >
            Connect
          </button>
        )}
      </div>
    </div>
  </header>
);
