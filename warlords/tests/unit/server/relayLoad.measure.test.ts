// Measurement harness (not part of the suite: runs only with SGWL_MEASURE=1):
// a real 8-player match (host player + 7 guests, real sim) through server/relay.mjs,
// every guest pushing input at 60 fps. Prints each socket's inbound messages / bytes
// per second (peak 1-s window and mean) and the largest frame per direction.
import fs from 'node:fs';
import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { emptyInput } from '../../../src/core/types';
import { ClientSession } from '../../../src/net/clientSession';
import { HostSession } from '../../../src/net/hostSession';
import { WsTransport } from '../../../src/net/wsTransport';
import { waitFor } from '../net/fixtures';
// @ts-expect-error plain .mjs without type declarations
import { createRelay } from '../../../server/relay.mjs';

const RUN = process.env.SGWL_MEASURE === '1';
const SECONDS = Number(process.env.SGWL_MEASURE_SECONDS ?? 30);

describe.skipIf(!RUN)('relay load of a real 8-player match', () => {
  it('measures', async () => {
    const relay = createRelay({});
    const server = http.createServer();
    server.on('upgrade', (req, socket, head) => relay.handleUpgrade(req, socket, head));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws`;
    interface Meter {
      label: string;
      windows: Map<number, { n: number; b: number }>;
      maxFrame: number;
      kinds: Map<string, number>;
    }
    const meters: Meter[] = [];
    let measuring = false;
    const t0 = Date.now();
    relay.wss.on('connection', (ws: { on(ev: string, cb: (d: Buffer, bin: boolean) => void): void }) => {
      const m: Meter = { label: `s${meters.length}`, windows: new Map(), maxFrame: 0, kinds: new Map() };
      meters.push(m);
      ws.on('message', (d: Buffer) => {
        if (!measuring) return;
        const sec = Math.floor((Date.now() - t0) / 1000);
        const w = m.windows.get(sec) ?? { n: 0, b: 0 };
        w.n++;
        w.b += d.length;
        m.windows.set(sec, w);
        m.maxFrame = Math.max(m.maxFrame, d.length);
        let kind = 'ctrl';
        if (d.length > 2 && d[0] <= 3) {
          const off = 2 + d[1];
          const bin = d[0] & 1;
          kind = `${d[0] & 2 ? 'U' : 'R'}:${bin ? `b${d[off]}` : (/"t":"([a-zA-Z]+)"/.exec(d.subarray(off, off + 40).toString())?.[1] ?? 'txt')}`;
        }
        m.kinds.set(kind, (m.kinds.get(kind) ?? 0) + 1);
      });
    });
    const hostT = await WsTransport.host(url);
    const host = new HostSession({
      name: '房主',
      transport: hostT,
      roomCode: hostT.roomCode,
      seed: 11,
      preferWorkerTicker: false,
      settings: { playerCount: 8, mode: 'standard' },
      timings: { roleReveal: 0.02, lordPick: 1, pick: 1, pickReveal: 0.01, loadTimeout: 60 },
    });
    const clients: ClientSession[] = [];
    try {
      for (let i = 0; i < 7; i++) {
        const t = await WsTransport.join(url, hostT.roomCode);
        const s = await ClientSession.connect({ transport: t, name: `g${i}` });
        s.on('heroSelect', (v) => v.options.length && v.picks[s.mySeat] === undefined && s.pickHero(v.options[0]));
        clients.push(s);
      }
      await waitFor(() => host.lobby.seats.length === 8, 10_000, 'lobby of 8');
      host.on('heroSelect', (v) => v.options.length && v.picks[0] === undefined && host.pickHero(v.options[0]));
      measuring = true;
      host.start();
      await waitFor(() => host.phase === 'playing' && clients.every((c) => c.phase === 'playing'), 120_000, 'playing');
      const end = Date.now() + SECONDS * 1000;
      let last = performance.now();
      let k = 0;
      while (Date.now() < end) {
        const now = performance.now();
        k++;
        for (const c of clients) {
          c.view?.pushInput({ ...emptyInput(), moveZ: 1, moveX: Math.sin(k / 20), buttons: k % 40 < 20 ? 1 : 0, yaw: k / 30 });
          c.view?.update((now - last) / 1000);
        }
        host.view?.pushInput({ ...emptyInput(), moveZ: 1, buttons: k % 30 < 10 ? 1 : 0 });
        last = now;
        await new Promise((r) => setTimeout(r, 16));
      }
      measuring = false;
      const rows = meters.map((m, i) => {
        const ws = [...m.windows.values()];
        const peakN = Math.max(0, ...ws.map((w) => w.n));
        const peakB = Math.max(0, ...ws.map((w) => w.b));
        const meanN = ws.reduce((a, w) => a + w.n, 0) / Math.max(1, ws.length);
        const meanB = ws.reduce((a, w) => a + w.b, 0) / Math.max(1, ws.length);
        return `${i === 0 ? 'host ' : `guest${i}`}: msgs/s peak ${peakN} mean ${meanN.toFixed(0)} · KB/s peak ${(peakB / 1024).toFixed(1)} mean ${(meanB / 1024).toFixed(1)} · max frame ${m.maxFrame} B (${ws.length} s) · ${[...m.kinds].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k}=${(n / Math.max(1, ws.length)).toFixed(0)}/s`).join(' ')}`;
      });
      const report = `[measure] ${SECONDS} s of an 8-player match through the relay (inbound per socket):\n${rows.join('\n')}\n`;
      if (process.env.SGWL_MEASURE_OUT) fs.appendFileSync(process.env.SGWL_MEASURE_OUT, report);
      else process.stdout.write(report);
      expect(meters.length).toBe(8);
    } finally {
      for (const c of clients) c.leave();
      host.leave();
      await relay.close();
      await new Promise((r) => server.close(r));
    }
  }, 300_000);
});
