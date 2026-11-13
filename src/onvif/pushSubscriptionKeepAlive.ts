import debug from 'debug';
import { CameraConfig } from '../types';
import { logDebug, logInfo, logWarn } from '../logger';
import { computeRenewDelayMs, getEventsXaddr, redactUrl } from './pullPoint';
import { createPushSubscription, renewPushSubscription } from './push';

const log = debug('push-keepalive');
const PUSH_FAILURES_BEFORE_STATUS_CHANGE = 3;
const PUSH_RESUBSCRIBE_BACKOFF_MS = 3000;
// Cameras that omit TerminationTime from subscribe/renew responses still expire the
// subscription (PT24H was requested); renew those on a fixed cadence slightly under it.
const PUSH_FALLBACK_RENEW_DELAY_MS = 23 * 60 * 60 * 1000;

interface PushSubscriptionState {
  address: string;
  currentTimeMs: number | null;
  terminationTimeMs: number | null;
}

export interface PushSubscriptionKeepAliveHooks {
  onHealthy?: () => void;
  onError?: (err: unknown) => void;
}

/**
 * Keeps a push (BaseNotification) subscription alive:
 *   establish (events xaddr discovery -> CreateSubscription) -> renew before expiry
 *   -> on renewal failure warn + recover via re-subscribe (retry with backoff until stopped).
 *
 * Health semantics (parity with pull mode): the first successful establishment and every
 * recovery fire `onHealthy`; 3 consecutive failures fire `onError` once per failure streak
 * so the camera status can go OFFLINE. Deliberate limitation: there is no
 * notification-absence liveness check — a quiet camera is indistinguishable from a dead
 * subscription, and renewal success is the health probe. Missing notifications never mark
 * the camera offline.
 */
export function startPushSubscriptionKeepAlive(
  cfg: CameraConfig,
  notifyUrl: string,
  hooks?: PushSubscriptionKeepAliveHooks,
): { stop: () => void } {
  let stopped = false;
  let healthy = false;
  let consecutiveFailures = 0;
  let failureReported = false;
  let renewTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffResolve: (() => void) | null = null;
  let recoveryPromise: Promise<void> | null = null;
  const state: { subscription: PushSubscriptionState | null } = { subscription: null };

  const clearRenewTimer = () => {
    if (renewTimer) {
      clearTimeout(renewTimer);
      renewTimer = null;
    }
  };

  // Abortable recovery backoff: stop() resolves a pending wait so the recovery loop
  // exits immediately instead of leaving a dangling timer behind.
  const waitBackoff = () => new Promise<void>((resolve) => {
    backoffResolve = resolve;
    backoffTimer = setTimeout(() => {
      backoffTimer = null;
      backoffResolve = null;
      resolve();
    }, PUSH_RESUBSCRIBE_BACKOFF_MS);
  });

  const clearBackoffTimer = () => {
    if (backoffTimer) {
      clearTimeout(backoffTimer);
      backoffTimer = null;
    }
    const resolve = backoffResolve;
    backoffResolve = null;
    resolve?.();
  };

  const recordSuccess = () => {
    consecutiveFailures = 0;
    failureReported = false;
    if (!healthy) {
      healthy = true;
      hooks?.onHealthy?.();
    }
  };

  const recordFailure = (err: unknown) => {
    consecutiveFailures += 1;
    if (healthy) {
      healthy = false;
    }
    if (consecutiveFailures >= PUSH_FAILURES_BEFORE_STATUS_CHANGE && !failureReported) {
      failureReported = true;
      hooks?.onError?.(err);
    }
  };

  const scheduleRenewal = (currentSubscription: PushSubscriptionState) => {
    clearRenewTimer();
    const renewDelayMs = computeRenewDelayMs(currentSubscription.currentTimeMs, currentSubscription.terminationTimeMs)
      ?? PUSH_FALLBACK_RENEW_DELAY_MS;
    logDebug(`[DEBUG] Push renewal scheduled camera=${cfg.name} subscription=${redactUrl(currentSubscription.address)} delayMs=${renewDelayMs}`);
    renewTimer = setTimeout(() => {
      void renewSubscription();
    }, renewDelayMs);
  };

  const establishSubscription = async (reason: string) => {
    const eventsXaddr = await getEventsXaddr(cfg);
    if (!eventsXaddr) {
      throw new Error(`Could not determine events XAddr for push subscription camera=${cfg.name}`);
    }

    const result = await createPushSubscription(eventsXaddr, cfg, notifyUrl);
    if (!result.ok) {
      throw new Error(`Push subscription attempt failed for camera=${cfg.name}`);
    }

    state.subscription = {
      // Cameras that omit SubscriptionReference/Address expect notifications on the events xaddr.
      address: result.address ?? eventsXaddr,
      currentTimeMs: result.currentTimeMs ?? null,
      terminationTimeMs: result.terminationTimeMs ?? null,
    };
    scheduleRenewal(state.subscription);
    recordSuccess();
    log('Push subscription created for', cfg.name);

    if (reason === 'startup') {
      logInfo(`[INFO] Push subscription created camera=${cfg.name} notifyUrl=${notifyUrl}`);
    } else {
      logInfo(`[INFO] Push subscription recovered camera=${cfg.name} reason=${reason}`);
    }
  };

  const recoverSubscription = async (reason: string) => {
    if (stopped) return;
    if (recoveryPromise) {
      await recoveryPromise;
      return;
    }

    recoveryPromise = (async () => {
      clearRenewTimer();
      logWarn(`[WARN] Re-establishing push subscription camera=${cfg.name} reason=${reason}`);

      let attempt = 0;
      while (!stopped) {
        attempt += 1;
        if (attempt > 1) {
          await waitBackoff();
        }
        if (stopped) return;

        try {
          await establishSubscription(`recovery:${reason}:attempt=${attempt}`);
          return;
        } catch (err) {
          recordFailure(err);
          logWarn(`[WARN] Push subscription recovery attempt failed camera=${cfg.name} attempt=${attempt}`, err);
        }
      }
    })().finally(() => {
      recoveryPromise = null;
    });

    await recoveryPromise;
  };

  const renewSubscription = async () => {
    if (stopped || recoveryPromise || !state.subscription) return;

    const currentSubscription = state.subscription;
    const renewed = await renewPushSubscription(currentSubscription.address, cfg);
    if (renewed) {
      state.subscription = {
        ...currentSubscription,
        currentTimeMs: renewed.currentTimeMs,
        terminationTimeMs: renewed.terminationTimeMs,
      };
      scheduleRenewal(state.subscription);
      recordSuccess();
      logInfo(`[INFO] Push subscription renewed camera=${cfg.name} subscription=${redactUrl(state.subscription.address)}`);
      return;
    }

    logWarn(`[WARN] Push subscription renewal failed; re-subscribing camera=${cfg.name} subscription=${redactUrl(currentSubscription.address)}`);
    recordFailure(new Error('Push subscription renewal failed'));
    await recoverSubscription('renew failed');
  };

  void (async () => {
    try {
      await establishSubscription('startup');
    } catch (err) {
      // The camera may be unreachable at startup (e.g. still booting after a power loss).
      // This is not fatal: the recovery loop retries until the subscription is established.
      logWarn(`[WARN] Push subscription startup failed; will keep retrying camera=${cfg.name}`, err);
      recordFailure(err);
      void recoverSubscription('startup failed');
    }
  })();

  return {
    stop: () => {
      stopped = true;
      clearRenewTimer();
      clearBackoffTimer();
    },
  };
}
