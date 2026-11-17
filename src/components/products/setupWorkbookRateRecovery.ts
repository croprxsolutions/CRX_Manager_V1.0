import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { hasRpcCode, RpcErrorCodes, sanitizeError } from '../../lib/db';
import { isDefinitiveRpcRejection } from '../../lib/idempotency';
import { isChemistryAuthorizationRefusal } from '../../lib/productChemistry';
import type { RatePreview, RateUploadRow } from '../../lib/productSetupWorkbook';

export type RatesState = { rows: RateUploadRow[]; preview: RatePreview | null } | null;
export type DeferredRatesRebase = { source: string; generation: number; rows: RateUploadRow[] } | null;

function updateRatesAfterRefusal(error: unknown, setRates: Dispatch<SetStateAction<RatesState>>): void {
  if (hasRpcCode(error, RpcErrorCodes.PRODUCT_RATES_LOCKED)) {
    setRates((current) => current?.preview ? { ...current, preview: { ...current.preview, rates_locked: true } } : current);
  } else if (hasRpcCode(error, RpcErrorCodes.PRODUCT_RATE_PREVIEW_CHANGED) || hasRpcCode(error, RpcErrorCodes.PRODUCT_RATES_STALE)) {
    setRates((current) => current ? { rows: current.rows, preview: null } : current);
  }
}

function classifyRatesSaveFailure(error: unknown, hadRetryPending: boolean) {
  const authoritative = hasRpcCode(error, RpcErrorCodes.PRODUCT_RATES_LOCKED)
    || hasRpcCode(error, RpcErrorCodes.PRODUCT_RATE_PREVIEW_CHANGED) || hasRpcCode(error, RpcErrorCodes.PRODUCT_RATES_STALE);
  if (authoritative) return { authoritative: true, retryPending: false, resetKey: true, message: sanitizeError(error) };
  const authRefusal = isChemistryAuthorizationRefusal(error);
  const isPostgrest = !!error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    && /^PGRST\d{3}$/i.test((error as { code: string }).code);
  if (hadRetryPending && (authRefusal || isPostgrest || !isDefinitiveRpcRejection(error))) return { authoritative: false, retryPending: true, resetKey: false,
    message: authRefusal
      ? 'Sign in again or check administrator access. The previous rate save may have gone through; confirm again to retry the same request.'
      : 'The rate save may have gone through. Confirm again to retry the same request.' };
  if (isDefinitiveRpcRejection(error)) return { authoritative: false, retryPending: false, resetKey: true, message: sanitizeError(error) };
  return { authoritative: false, retryPending: true, resetKey: false,
    message: 'The rate save may have gone through. Confirm again to retry the same request.' };
}

export function classifyParentRatesSaveFailure(error: unknown, hadRetryPending: boolean, knownStateRefusal: boolean) {
  const authorizationRefusal = isChemistryAuthorizationRefusal(error);
  const postgrestRefusal = !!error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    && /^PGRST\d{3}$/i.test((error as { code: string }).code);
  const retryPending = hadRetryPending && (authorizationRefusal || postgrestRefusal || !isDefinitiveRpcRejection(error));
  return {
    authorizationRefusal,
    retryPending: retryPending || (!knownStateRefusal && !isDefinitiveRpcRejection(error)),
    message: authorizationRefusal
      ? hadRetryPending
        ? 'Sign in again or check administrator access. The previous parent-rate save may have gone through; confirm again to retry the same request.'
        : 'Sign in again or check administrator access, then try the save again.'
      : retryPending || !isDefinitiveRpcRejection(error)
        ? 'The save may have gone through, but no reply arrived. Confirm again to safely retry the same request.'
        : sanitizeError(error),
  };
}

export function handleRatesSaveFailure(input: {
  error: unknown;
  hadRetryPending: boolean;
  currentRates: Exclude<RatesState, null>;
  generation: number;
  ratesRetryPending: MutableRefObject<boolean>;
  deferredRatesRebase: MutableRefObject<DeferredRatesRebase>;
  setRates: Dispatch<SetStateAction<RatesState>>;
  resetKey: () => void;
}): string {
  const { error, hadRetryPending, currentRates, generation, ratesRetryPending, deferredRatesRebase, setRates, resetKey } = input;
  const failure = classifyRatesSaveFailure(error, hadRetryPending);
  ratesRetryPending.current = failure.retryPending;
  if (failure.resetKey) resetKey();
  if (failure.authoritative) {
    const deferred = deferredRatesRebase.current;
    const stale = hasRpcCode(error, RpcErrorCodes.PRODUCT_RATE_PREVIEW_CHANGED) || hasRpcCode(error, RpcErrorCodes.PRODUCT_RATES_STALE);
    if (deferred && deferred.generation === generation && deferred.source === JSON.stringify([currentRates.rows, currentRates.preview]) && stale) {
      setRates({ rows: deferred.rows, preview: null });
      deferredRatesRebase.current = null;
    } else updateRatesAfterRefusal(error, setRates);
    if (!failure.retryPending && !stale) deferredRatesRebase.current = null;
  }
  return failure.message;
}
