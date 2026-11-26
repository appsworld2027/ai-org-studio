// Opt-in supervised delivery fetch guard. It does not change Studio chat or
// canonical AI Org routing, and never substitutes a paid or different model.
import { setTimeout as delay } from "node:timers/promises";

export function retryAfterMs(value, now = Date.now()) {
  if (value == null || !String(value).trim()) return 60000;
  const raw = String(value).trim();
  const seconds = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) * 1000 : NaN;
  const ms = Number.isFinite(seconds) ? seconds : Date.parse(raw) - now;
  return Number.isFinite(ms) ? Math.max(1000, Math.ceil(ms) + 1000) : 60000;
}

export function createDeliveryRateGuard({
  fetchImpl = globalThis.fetch, now = Date.now, sleep = (ms, signal) => delay(ms, undefined, {signal}),
  minIntervalMs = 21000, maxCooldownMs = 120000, maxRetries = 6
} = {}) {
  let nextRequestAt = 0, remaining = maxRetries;
  return {
    async fetch(url, options, observe = () => {}) {
      let requestRetries = 0;
      const pause = async (ms, fields) => {
        if (ms <= 0) return;
        observe("route.cooldown",{durationMs:ms,...fields});
        await sleep(ms, options?.signal);
      };
      for (;;) {
        await pause(Math.max(0,nextRequestAt-now()),{});
        options?.signal?.throwIfAborted();
        if(requestRetries)observe("route.retry",{httpStatus:429});
        nextRequestAt = now()+minIntervalMs;
        const res = await fetchImpl(url,options);
        if (res.status !== 429) return res;
        const cooldown = retryAfterMs(res.headers?.get("retry-after"), now());
        if (cooldown > maxCooldownMs || remaining <= 0 || requestRetries >= 1) return res;
        remaining--;requestRetries++;
        await res.body?.cancel?.().catch(()=>{});
        await pause(cooldown,{httpStatus:429,errorKind:"provider_rate_limit"});
      }
    }
  };
}
