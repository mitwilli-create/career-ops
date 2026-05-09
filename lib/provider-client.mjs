/**
 * lib/provider-client.mjs — Circuit breaker + exponential backoff for triage providers
 *
 * Provider state is module-level and persists for the process lifetime.
 * Circuit breaker opens after CB_THRESHOLD consecutive failures, then
 * resets after CB_TIMEOUT_MS cooldown.
 */

// ── Circuit breaker state ────────────────────────────────────────
const circuitBreakers = new Map(); // provider → { failures, openUntil }
const CB_THRESHOLD    = 3;
const CB_TIMEOUT_MS   = 5 * 60 * 1000; // 5 minutes

export function isCircuitOpen(provider) {
  const cb = circuitBreakers.get(provider);
  if (!cb) return false;
  if (cb.failures >= CB_THRESHOLD) {
    if (Date.now() < cb.openUntil) {
      console.log(`[circuit] ${provider} circuit OPEN — skipping until ${new Date(cb.openUntil).toISOString()}`);
      return true;
    }
    circuitBreakers.delete(provider); // cooldown passed, reset
  }
  return false;
}

export function recordSuccess(provider) {
  circuitBreakers.delete(provider);
}

export function recordFailure(provider) {
  const cb = circuitBreakers.get(provider) || { failures: 0, openUntil: 0 };
  cb.failures++;
  if (cb.failures >= CB_THRESHOLD) {
    cb.openUntil = Date.now() + CB_TIMEOUT_MS;
    console.warn(`[circuit] ${provider} circuit OPENED after ${cb.failures} failures. Cooldown: 5 min.`);
  }
  circuitBreakers.set(provider, cb);
}

// ── Exponential backoff with 10–30% full-delay jitter ───────────
// Delays: ~1100–1300ms, ~2200–2600ms, ~4400–5200ms
export async function withRetryBackoff(fn, provider, maxAttempts = 3) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await fn();
      recordSuccess(provider);
      return result;
    } catch (err) {
      const isRetryable = err.message.includes('rate_limit') ||
                          err.message.includes('overloaded') ||
                          err.message.includes('529') ||
                          err.message.includes('503');
      if (!isRetryable || attempt === maxAttempts - 1) {
        recordFailure(provider);
        throw err;
      }
      const baseDelay = (2 ** attempt) * 1000;
      const jitter    = baseDelay * (0.10 + Math.random() * 0.20); // 10–30% of base
      const delay     = baseDelay + jitter;
      console.log(`[${provider}] rate limited — retry ${attempt + 1}/${maxAttempts} in ${Math.round(delay)}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}
