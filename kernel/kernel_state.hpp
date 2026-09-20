// P3.3 — KernelState: kernel-owned universe + per-symbol epochs.
//
// P3.1 left allowed_symbols/previous_epoch as caller-supplied request
// fields (frozen). P3.3 closes that hole at a NEW layer: production code
// never fills a ValidationRequest by hand. It asks the KernelState, which
// owns the immutable execution universe and the last-accepted epoch per
// symbol, and advances epochs only through accept() AFTER a successful
// validation. This file does not modify jev_validate.hpp.
#pragma once
#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>
#include "jev_validate.hpp"

namespace jev {

class KernelState {
   public:
    // Immutable execution universe (doc 04 §5b). Non-empty; membership is
    // the only gate (P3.1 enforces it) — no invented size cap.
    static KernelState WithUniverse(const std::vector<std::string>& symbols,
                                    std::string& why) {
        KernelState k;
        if (symbols.empty()) {
            why = "kernel-state:empty-universe";
            return k;
        }
        for (auto& s : symbols) {
            if (s.empty() || s.size() > 1024) {
                why = "kernel-state:bad-symbol";
                k.universe_.clear();
                return k;
            }
            k.universe_[s] = false;  // value unused; map = ordered set
        }
        k.ok_ = true;
        why = "ok";
        return k;
    }
    bool ok() const { return ok_; }
    bool is_executable(const std::string& symbol) const {
        return universe_.find(symbol) != universe_.end();
    }
    bool has_epoch(const std::string& symbol) const {
        return epochs_.find(symbol) != epochs_.end();
    }
    int64_t last_epoch(const std::string& symbol) const {
        auto it = epochs_.find(symbol);
        return it == epochs_.end() ? -1 : it->second;
    }
    // Build the validator request SOLELY from kernel-owned state: the
    // caller supplies bytes (artifact, state canon, key, clock, mode) but
    // NEVER universe or epoch values. Non-executable symbols still produce
    // a request — the frozen validator reports the HOLD itself.
    ValidationRequest request_for(
        const std::string& raw_json, const std::array<uint8_t, 32>& key,
        const std::string& state_canon_json, const std::string& symbol,
        double now_unix, Mode mode) const {
        ValidationRequest q;
        q.raw_json = raw_json;
        q.trusted_key = key;
        q.state_canon_json = state_canon_json;
        q.now_unix = now_unix;
        q.mode = mode;
        q.allowed_symbols.reserve(universe_.size());
        for (auto& kv : universe_) q.allowed_symbols.push_back(kv.first);
        auto it = epochs_.find(symbol);
        q.has_previous_epoch = (it != epochs_.end());
        q.previous_epoch = it == epochs_.end() ? 0 : it->second;
        return q;
    }
    // Advance AFTER validate_jev() returns ok. Enforces the same monotonic
    // rule locally (defense in depth): first artifact any epoch >= 0,
    // later strictly greater. False (unchanged) on violation or on
    // non-executable symbols — never advance on a HOLD.
    bool accept(const std::string& symbol, int64_t epoch) {
        if (!is_executable(symbol) || epoch < 0) return false;
        auto it = epochs_.find(symbol);
        if (it != epochs_.end() && epoch <= it->second) return false;
        epochs_[symbol] = epoch;
        return true;
    }

   private:
    KernelState() = default;
    bool ok_ = false;
    std::unordered_map<std::string, bool> universe_;
    std::unordered_map<std::string, int64_t> epochs_;
};

}  // namespace jev
