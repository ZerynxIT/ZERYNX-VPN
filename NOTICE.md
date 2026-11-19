# Notices and credits

**ZERYNX** — Copyright (c) 2026 ZERYNX (ZerynxIT). Released under the MIT License (see `LICENSE`).

## Inspiration

The idea of a free, Cloudflare-hosted panel with per-user subscription links was inspired by the
public work of the **Nova Proxy** project by IRNova (https://github.com/IRNova/Nova-Proxy).
ZERYNX is an independent implementation: the Worker, API, panel and subscription page in this
repository were written from scratch and contain no code from Nova Proxy.

## Third-party components (loaded at runtime, not bundled)

- **qrcode-generator** by Kazuhiko Arase — MIT License — loaded from cdnjs in `worker/public/index.html`.
- **Vazirmatn** font by Saber Rastikerdar — SIL Open Font License 1.1 — loaded from Google Fonts.

## Protocol

The relay implements the publicly documented VLESS protocol over WebSocket. Cloudflare Workers
and D1 are products of Cloudflare, Inc. and are subject to their terms.
