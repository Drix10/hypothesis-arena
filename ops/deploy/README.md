# Paper deployment (G0)

One host, one runner, Alpaca paper only. Nothing here can touch a live account:
the transport is hard-wired to `paper-api.alpaca.markets`.

## Host

Ubuntu 22.04+, `g++`, `libcurl4-openssl-dev`, Python 3.11. A dedicated user:

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin mirotrade
sudo git clone https://github.com/Drix10/hypothesis-arena /opt/mirohedge
cd /opt/mirohedge/kernel && sudo -u mirotrade WITH_CURL=1 bash build.sh
```

The build runs the full gate; it must print `P3.1 GATE (normal): PASS`.

## Secrets and state

```bash
sudo install -d -m 700 -o mirotrade /etc/mirohedge /var/lib/mirohedge/g0
sudo tee /etc/mirohedge/env >/dev/null <<'ENV'
ALPACA_KEY_ID=...
ALPACA_SECRET=...
ALERT_WEBHOOK_URL=https://...
ENV
sudo chmod 600 /etc/mirohedge/env
sudo cp ops/deploy/approved.json.example /var/lib/mirohedge/g0/approved.json
```

Rotate the paper keys before use. The env file is the only place they live.

## Human sign-off

`approved.json` lists the approved sleeves (with their freshness window) and the
instrument allowlist. Review it, then sign the stage yourself:

```bash
sudo -u mirotrade scripts/sign-stage.sh /var/lib/mirohedge/g0
```

The runner refuses to start without a valid `STAGE`.

## Run

```bash
sudo cp ops/deploy/mirohedge-* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mirohedge-paper-loop mirohedge-emit.timer mirohedge-alerts.timer
```

- `mirohedge-emit.timer` writes one candidate per unheld symbol per month after
  the close; the loop picks it up during the next session.
- `mirohedge-paper-loop` exits 2 (refused) or 3 (HARD stop) and is then **not**
  restarted; investigate the journal before starting it again.
- Stop everything with `touch /var/lib/mirohedge/g0/HALT`. Entries hold, exits
  and reconciliation continue.

## What to watch

- `decisions.jsonl`: one line per candidate, with the reason for every hold.
- `journal-*.jsonl`: written before every order; `alerts.jsonl`: relayed outbound.
- Daily: account equity vs the modeled book; any non-`proceed` reason you do not
  recognize.

The core passive sleeve is plumbing, not an alpha claim, and paper results from
it do not count toward the G0 to G1 criteria (doc 10 10.2).
