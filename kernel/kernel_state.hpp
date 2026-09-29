// KernelState: kernel-owned universe and per-symbol epochs (P3.3).
//
// Production code never fills a ValidationRequest by hand: it asks the
// KernelState, which owns the immutable execution universe and the
// last-accepted epoch per symbol, and advances epochs only through
// try_accept() after a successful validation. Uses the validator's
// expected_symbol binding (#6) and universe membership (P3.1).
//
// Hardening (#5, #7):
//   non-copyable (two epoch stores would fork the state machine);
//   mutex-guarded epochs (concurrent per-symbol paths linearize);
//   try_accept() is the sole compare-and-advance gate: it succeeds only when
//     the caller presents the previous epoch it was admitted with, so two
//     racing validations on one symbol admit exactly one;
//   universe capped at EXEC_UNIVERSE_MAX = 5 (manifest universe.execution_max),
//     duplicates rejected, symbols validated (non-empty, <= 1024, valid
//     UTF-8). Invalid construction fails closed via the out-param factory.
#pragma once
#include <cstdint>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>
#include "jev_state.hpp"  // DecodeUtf8 for symbol validation

namespace jev {

// Manifest universe.execution_max (plan/system-manifest.yaml): larger is a
// construction failure.
static const size_t EXEC_UNIVERSE_MAX = 5;

class KernelState {
   public:
    KernelState(const KernelState&) = delete;
    KernelState& operator=(const KernelState&) = delete;
    KernelState(KernelState&&) = delete;
    KernelState& operator=(KernelState&&) = delete;
    // Default-constructed states are not-ok and admit nothing until Create()
    // succeeds into them.
    KernelState() = default;

    // Closed factory: true + why=="ok" on success; false + reason with `out`
    // left not-ok otherwise.
    static bool Create(const std::vector<std::string>& symbols,
                       std::string& why, KernelState& out) {
        if (symbols.empty()) {
            why = "kernel-state:empty-universe";
            return false;
        }
        if (symbols.size() > EXEC_UNIVERSE_MAX) {
            why = "kernel-state:universe-too-large";
            return false;
        }
        std::unordered_map<std::string, bool> uni;
        for (auto& s : symbols) {
            if (s.empty() || s.size() > 1024) {
                why = "kernel-state:bad-symbol";
                return false;
            }
            std::u32string u;
            std::string uw;
            if (!DecodeUtf8(s, u, uw)) {
                why = "kernel-state:bad-symbol-utf8";
                return false;
            }
            if (!uni.insert({s, true}).second) {
                why = "kernel-state:duplicate-symbol";
                return false;
            }
        }
        out.universe_ = std::move(uni);
        out.ok_ = true;
        why = "ok";
        return true;
    }
    bool ok() const { return ok_; }
    bool is_executable(const std::string& symbol) const {
        return universe_.find(symbol) != universe_.end();
    }
    bool has_epoch(const std::string& symbol) const {
        std::lock_guard<std::mutex> lock(mu_);
        return epochs_.find(symbol) != epochs_.end();
    }
    int64_t last_epoch(const std::string& symbol) const {
        std::lock_guard<std::mutex> lock(mu_);
        auto it = epochs_.find(symbol);
        return it == epochs_.end() ? -1 : it->second;
    }
    // Build the validator request solely from kernel-owned state: the caller
    // supplies bytes (artifact, state canon, key, clock, mode) but never
    // universe, symbol binding or epoch values. Non-executable symbols still
    // produce a request; the validator reports the HOLD. The request binds
    // expected_symbol (#6) so the artifact cannot borrow another symbol's
    // epoch. The only construction path for ValidationRequest.
    ValidationRequest request_for(
        const std::string& raw_json, const std::array<uint8_t, 32>& key,
        const std::string& state_canon_json, const std::string& symbol,
        double now_unix, Mode mode) const {
        std::vector<std::string> syms;
        syms.reserve(universe_.size());
        for (auto& kv : universe_) syms.push_back(kv.first);
        std::lock_guard<std::mutex> lock(mu_);
        auto it = epochs_.find(symbol);
        bool has_prev = (it != epochs_.end());
        int64_t prev = it == epochs_.end() ? 0 : it->second;
        return ValidationRequest(raw_json, key, state_canon_json,
                                 std::move(syms), has_prev, prev, now_unix,
                                 mode, symbol);
    }
    // Admission gate (#5): compare-and-advance under the epoch lock.
    // expected_prev is the epoch the request was admitted with (-1 for a first
    // artifact). Returns true and advances to `next` for exactly one winner;
    // any other outcome (wrong prev, non-monotonic next, non-executable
    // symbol) returns false with state unchanged. Call only with a validated
    // (epoch, symbol) pair, never on a HOLD.
    bool try_accept(const std::string& symbol, int64_t expected_prev,
                    int64_t next) {
        if (!is_executable(symbol) || next < 0) return false;
        std::lock_guard<std::mutex> lock(mu_);
        auto it = epochs_.find(symbol);
        int64_t cur = (it == epochs_.end()) ? -1 : it->second;
        if (cur != expected_prev) return false;
        if (next <= cur) return false;
        epochs_[symbol] = next;
        return true;
    }

   private:
    bool ok_ = false;
    std::unordered_map<std::string, bool> universe_;
    std::unordered_map<std::string, int64_t> epochs_;
    mutable std::mutex mu_;
};

}  // namespace jev
