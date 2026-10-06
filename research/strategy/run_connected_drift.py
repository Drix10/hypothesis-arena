"""Real-data runner for connected_drift (plan/validation.md, plan/strategies.md).
The default is a dry run: data coverage, the component correlation matrix and
the effective signal count on the evaluation window before the holdout, and no
trial. --register is the only path to the ledger and fails closed. Reads only
the data directory; nothing here touches the network.

Data directory: SIP split-adjusted daily bars (bar_loader) for every symbol in
reference.json plus SPY, IEF and BIL; link_store.jsonl (engine.link_store,
YYYYMMDD times); and four JSON datasets {"through": ISO date, "data": ...}:
reference.json {ciks, industry, market_cap, beta}, filing_scores.json
{symbol: [text_change.score]}, form4_events.json (form4.build_events rows) and
vetoes.json {veto name: {symbol: bool}}, used only by --register."""
import argparse
import datetime
import json
import os
import re
import sys
from bisect import bisect_right

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.engine import link_store
from research.strategy import backtest, bar_loader, composite, etf_trend
from research.strategy import ledger as ledger_mod
from research.strategy import margin, prereg, tranches

ROOT = os.path.join(os.path.dirname(__file__), "..")
DATA = os.path.join(ROOT, "data")
LEDGER = os.path.join(ROOT, "ledger", "trials.jsonl")
PREREG = os.path.join(ROOT, "prereg", "connected_drift.json")
ROADMAP = os.path.join(ROOT, "..", "plan", "roadmap.md")
EVAL_START = "2016-01-01"
NAMES = ("link", "filing", "insider")
N_SIDE = 20
GROSS = 1.5
RETURN_SESSIONS = 21
STALE_DAYS = 7
SUPPORT = ("SPY", "IEF", "BIL")


class RunnerError(Exception):
    pass


def _day(text):
    return datetime.date.fromisoformat(text)


def read_dataset(data_dir, name, need_through):
    """The `data` of a JSON dataset; a missing file or a `through` date before
    `need_through` (less STALE_DAYS) is refused."""
    path = os.path.join(data_dir, name)
    try:
        with open(path, encoding="utf-8") as f:
            ds = json.load(f)
        through = _day(ds["through"])
    except FileNotFoundError:
        raise RunnerError("dataset-missing:" + name) from None
    except (ValueError, KeyError, TypeError):
        raise RunnerError("dataset-malformed:" + name) from None
    if through < _day(need_through) - datetime.timedelta(days=STALE_DAYS):
        raise RunnerError("dataset-stale:" + name)
    return ds["data"]


def load_bars(data_dir, symbols, start, end):
    """(bars, missing symbols). A hash or manifest mismatch propagates."""
    bars, missing = {}, []
    for s in symbols:
        try:
            bars.update(bar_loader.load_prices(data_dir, [s], start, end))
        except FileNotFoundError:
            missing.append(s)
    return bars, missing


def _month_ends(sessions, start, end):
    return [a for a, b in zip(sessions, sessions[1:])
            if a[:7] != b[:7] and start <= a <= end]


class Inputs:
    """as-of data dict for composite from the on-disk datasets; `vetoes` is
    None on a dry run, which never reads them."""

    def __init__(self, bars, ref, store, filings, events, vetoes=None):
        self.ref, self.filings, self.events = ref, filings, events
        self.store = store
        self.days = {s: sorted(b) for s, b in bars.items()}
        self.bars = bars
        self.vetoes = None if vetoes is None else {
            n: (lambda s, m=m: m.get(s, True)) for n, m in vetoes.items()}

    def _ret(self, sym, date):
        days = self.days.get(sym)
        if not days:
            return None
        i = bisect_right(days, date) - 1
        if i < RETURN_SESSIONS or days[i] != date:
            return None
        series = self.bars[sym]
        return series[date][1] / series[days[i - RETURN_SESSIONS]][1] - 1.0

    def __call__(self, date):
        syms = sorted(self.ref["market_cap"])
        returns = {s: r for s in syms if (r := self._ret(s, date)) is not None}
        market = self._ret("SPY", date)
        by_ind = {}
        for s, r in returns.items():
            by_ind.setdefault(self.ref["industry"].get(s), []).append(r)
        asof = int(date.replace("-", ""))
        data = {"market_cap": self.ref["market_cap"],
                "beta": self.ref["beta"], "returns": returns,
                "industry": self.ref["industry"], "market_return": market,
                "industry_returns": {k: sum(v) / len(v)
                                     for k, v in by_ind.items()},
                "ciks": self.ref["ciks"],
                "edges": self.store.edges(asof, asof),
                "filings": self.filings, "events": self.events}
        if self.vetoes is not None:
            data["vetoes"] = self.vetoes
        return data


def correlation(inputs, months):
    """(corr, effective signal count) of the component z over `months`, every
    symbol and month a row; a component with no score there is None."""
    cols = {n: [] for n in NAMES}
    for d in months:
        data = inputs(d)
        comps = composite.components(data, d)
        for s in sorted(data["market_cap"]):
            for n in NAMES:
                cols[n].append(comps[n].get(s))
    corr = composite.component_correlation([cols[n] for n in NAMES])
    return corr, composite.effective_signal_count(corr)


def format_report(coverage, corr, eff):
    lines = ["coverage"]
    lines += ["  %-18s %s" % (k, v) for k, v in coverage.items()]
    lines.append("component correlation (%s)" % ", ".join(NAMES))
    lines += ["  %-7s %s" % (n, " ".join("%+.3f" % v for v in row))
              for n, row in zip(NAMES, corr)]
    lines.append("effective signal count: %.3f" % eff)
    return "\n".join(lines)


def eval_end(pre):
    return (_day(pre["holdout"]["start"]) - datetime.timedelta(days=1)
            ).isoformat()


def _datasets(data_dir, need):
    ref = read_dataset(data_dir, "reference.json", need)
    for k in ("ciks", "industry", "market_cap", "beta"):
        if not isinstance(ref.get(k), dict):
            raise RunnerError("dataset-malformed:reference.json")
    return (ref, read_dataset(data_dir, "filing_scores.json", need),
            read_dataset(data_dir, "form4_events.json", need))


def _store(data_dir):
    path = os.path.join(data_dir, "link_store.jsonl")
    if not os.path.exists(path):
        raise RunnerError("dataset-missing:link_store.jsonl")
    return link_store.LinkStore(path)


def dry_run(pre, data_dir):
    """Report text for the evaluation window excluding the holdout."""
    end = eval_end(pre)
    ref, filings, events = _datasets(data_dir, end)
    store = _store(data_dir)
    bars, missing = load_bars(data_dir, sorted(set(ref["market_cap"])
                                               | set(SUPPORT)), EVAL_START, end)
    if "SPY" not in bars:
        raise RunnerError("dataset-missing:SPY")
    months = _month_ends(sorted(bars["SPY"]), EVAL_START, end)
    corr, eff = correlation(Inputs(bars, ref, store, filings, events), months)
    coverage = {"window": "%s..%s" % (EVAL_START, end),
                "symbols": len(ref["market_cap"]),
                "with bars": len(bars), "missing bars": len(missing),
                "month ends": len(months),
                "edge rows": len(store.rows()),
                "filing symbols": len(filings), "form 4 events": len(events)}
    return format_report(coverage, corr, eff)


def approved(pre, roadmap_path):
    """True when an entry of the roadmap approvals log names the prereg's
    experiment and its registration values, ends "Approved in chat" with a
    date on or after the prereg's `created`.
    lean: the entry is matched by text, not bound to the prereg hash; bind it
    when the approvals log carries hashes."""
    try:
        with open(roadmap_path, encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return False
    log = text.partition("## Approvals log")[2]
    for entry in re.split(r"\n(?=- )", log):
        flat = " ".join(entry.split())
        m = re.search(r"Approved in chat, (\d{4}-\d{2}-\d{2})\.$", flat)
        if m and "`%s` registration values" % pre["experiment_id"] in flat \
                and m.group(1) >= pre["created"]:
            return True
    return False


def holdout_untouched(pre, led):
    """False when any ledgered trial's window overlaps the holdout or is not a
    date window."""
    h = pre["holdout"]
    for r in led.rows():
        if r["kind"] != "open":
            continue
        w = r["window"]
        if not (isinstance(w, dict) and "start" in w and "end" in w) or (
                w["start"] <= h["end"] and h["start"] <= w["end"]):
            return False
    return True


class Book:
    """Monthly composite tranches scaled by the ETF Trend exposure (rate-capped
    state kept per instance). lean: no single-name cap, no-trade band or
    volatility target; add them with the registration run."""

    def __init__(self, sessions, bars, inputs):
        pick = composite.CompositeTarget(sessions, inputs, N_SIDE)
        self.tranches = tranches.Tranches(sessions, pick, gross=GROSS)
        self.bars = bars
        self.prev = None

    def __call__(self, date, closes):
        w = self.tranches(date, closes)
        if w is None:
            return None
        self.prev = etf_trend.exposure_scale(self.bars, date, self.prev, "SPY")
        return {s: x * self.prev for s, x in w.items()}


def register(pre, data_dir, ledger_path, margin_rate):
    """Run the backtest on the holdout and write the trial; every refusal
    comes before the ledger is opened."""
    if not approved(pre, ROADMAP):
        raise RunnerError("prereg-not-approved")
    prereg.require_valid(pre)
    led = ledger_mod.TrialLedger(ledger_path)
    if not holdout_untouched(pre, led):
        raise RunnerError("holdout-touched")
    end = pre["holdout"]["end"]
    ref, filings, events = _datasets(data_dir, end)
    vetoes = read_dataset(data_dir, "vetoes.json", end)
    store = _store(data_dir)
    bars, missing = load_bars(data_dir, sorted(set(ref["market_cap"])
                                               | set(SUPPORT)), EVAL_START, end)
    if missing:
        raise RunnerError("dataset-missing:bars:" + ",".join(missing[:5]))
    for s in SUPPORT:
        last = max(bars[s], default=None)
        if last is None or _day(last) < _day(end) - datetime.timedelta(
                days=STALE_DAYS):
            raise RunnerError("dataset-stale:bars:" + s)
    sessions = sorted(bars["SPY"])
    inputs = Inputs(bars, ref, store, filings, events, vetoes)
    return backtest.run_backtest(
        pre, bars, Book(sessions, bars, inputs), led,
        margin=margin.MarginTerms(margin_rate=margin_rate))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--data", default=DATA)
    ap.add_argument("--prereg", default=PREREG)
    ap.add_argument("--ledger", default=LEDGER)
    ap.add_argument("--register", action="store_true",
                    help="open and close the trial (default: dry run)")
    ap.add_argument("--margin-rate", type=float,
                    help="broker's published annual debit rate, required with "
                         "--register")
    args = ap.parse_args(argv)
    try:
        with open(args.prereg, encoding="utf-8") as f:
            pre = json.load(f)
        if not args.register:
            print(dry_run(pre, args.data))
            return 0
        if args.margin_rate is None:
            raise RunnerError("margin-rate-required")
        rep = register(pre, args.data, args.ledger, args.margin_rate)
        print("verdict %s sharpe %s trial %s" % (rep["verdict"], rep["sharpe"],
                                                 rep["trial"]["trial_id"]))
        return 0
    except (RunnerError, composite.CompositeError, backtest.BacktestError,
            prereg.PreregError, ledger_mod.LedgerError,
            link_store.LinkStoreError, OSError, ValueError) as e:
        print("refused: %s" % e, file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
