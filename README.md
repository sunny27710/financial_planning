# Portfolio Tracker

A self-hosted web app that tracks your stock portfolio in real time and alerts you when:

1. **A stock hits a price target**: above or below a price, as a one-shot or repeating alert.
2. **A covered call pays enough**: a call option on a stock you own has a premium above your threshold, with filters for days to expiry, % out of the money and annualized yield.

It has no dependencies. You only need Node.js 18.17 or newer.

## Quick start

```bash
npm start
```

Open http://localhost:3000, add your holdings, then set up alerts.

### Loading your holdings

You can add holdings on the page by share count, or by the **dollar amount** you invested. With a dollar amount, the app buys at today's price: shares = amount ÷ price, and that price becomes your cost basis.

To load many at once, copy `portfolio.example.csv` to `portfolio.csv` and list one holding per line (`VOO, 486,178`). On first start, when the app has no holdings yet, it loads them from that file. `portfolio.csv` is ignored by git, so your numbers stay on your computer. To reload the file later, delete `data/db.json` and start again. That also clears your alerts.

To try it with simulated prices and option chains (no internet needed):

```bash
npm run demo
```

### Demo with nothing to install

[`demo/portfolio-demo.html`](demo/portfolio-demo.html) is a single file that runs the whole app in your browser with simulated prices. Download it, then double-click it to open. It comes with example holdings and alerts. Use the **Market +3% / −3%** buttons to trigger price alerts, and **Reset demo** to start over. Changes are saved in that browser only. Desktop notifications may not work when the page is opened as a local file.

If you change the app, rebuild the demo with `npm run build:demo`. A test fails if the committed file is out of date.

## Features

**Live portfolio**
- Prices refresh every 15 s by default, and the server pushes them to the browser over Server-Sent Events.
- Shows market value, today's change, total gain/loss, cost basis and weight per position.
- Shows pre-market and after-hours prices when the regular session is closed.

**Price alerts**
- "Rises to or above" / "falls to or below" a target price, with an optional note.
- One-shot alerts turn off after they fire. Repeat alerts re-arm once the price crosses back over the target, so you aren't alerted on every tick.

**Covered-call alerts**
- Use symbol `*` to watch every holding with ≥ 100 shares, or name a single ticker.
- Conditions: minimum premium per share (by **bid**, mid or last), min/max days to expiry, minimum % out of the money and an optional minimum annualized yield.
- The live match table shows yield, annualized yield, open interest, and the total premium you'd collect for the number of contracts your shares cover.
- Each contract is notified at most once per cooldown window (24 h by default).

**Notification channels**
- **In-app**: a toast plus a sound, and a desktop notification once you click *Enable notifications*. These need the page to be open.
- **Phone push (works with the browser closed)**: install the free [ntfy](https://ntfy.sh) app, subscribe to a hard-to-guess topic name, and enter it under *Settings*. The server sends the alerts.
- **Webhook**: a Discord or Slack-compatible incoming webhook URL.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` to reach it from other devices |
| `APP_PASSWORD` | – | Turns on HTTP basic auth (any username). **Set this if you bind beyond localhost.** |
| `DATA_PROVIDER` | `yahoo` | `yahoo` for real data, `mock` for simulated data |
| `DB_FILE` | `data/db.json` | Where holdings, alerts and settings are stored |

Polling intervals, the cooldown and the notification channels can be changed in the *Settings* tab.

## Notes

- Market data comes from Yahoo Finance's public endpoints. They are free and need no key, but they are unofficial and can change or rate-limit. Option chains are polled less often (every 5 min by default) for that reason. The provider interface (`getQuotes`, `getCallChain` in `src/providers/`) is small, so you can add a broker or paid feed such as Tradier, Polygon or Schwab.
- Alerts are only checked while the server is running. For 24/7 alerts, run it on an always-on machine (a home server, a Raspberry Pi or a small VPS) and use ntfy for push.
- This is an informational tool, not financial advice. Check quotes with your broker before trading.

## Development

```bash
npm test
```

```
server.js              HTTP server, REST API, SSE stream
src/monitor.js         polling loops, alert evaluation
src/alerts.js          pure alert logic (tested)
src/notifier.js        in-app / ntfy / webhook delivery
src/providers/         yahoo.js (live), mock.js (simulated)
public/                dashboard (vanilla HTML/CSS/JS)
demo/                  standalone browser-only demo (built by scripts/build-demo.mjs)
```
