export class CanaryFlowError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "CanaryFlowError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export async function executeRuntimeActivation(deps) {
  let claimed = false;
  let claimAttempted = false;
  let webhookAttempted = false;
  try {
    claimAttempted = true;
    if (await deps.claim() !== true) {
      claimAttempted = false;
      throw new CanaryFlowError("ACTIVATION_UNAUTHORIZED");
    }
    claimed = true;
    const identity = await deps.verifyIdentity();
    webhookAttempted = true;
    await deps.setWebhook();
    await deps.verifyWebhook();
    if (await deps.complete() !== true) {
      throw new CanaryFlowError("ACTIVATION_FINALIZE_FAILED");
    }
    return Object.freeze({ identity, state: "ACTIVE" });
  } catch (error) {
    let removalProven = !webhookAttempted;
    if (claimed || claimAttempted) {
      try {
        removalProven = await deps.removeAndVerifyWebhook() === true;
      } catch {
        removalProven = false;
      }
      if (removalProven) {
        if (await deps.completeDeactivation() !== true) removalProven = false;
      }
      if (!removalProven) await deps.markRollbackRequired();
    }
    throw new CanaryFlowError("ACTIVATION_FAILED", {
      claimed,
      webhook_attempted: webhookAttempted,
      removal_proven: removalProven,
      cause: error?.code ?? error?.message ?? "UNKNOWN",
    });
  }
}

export async function executeCtaActivation(deps) {
  let run = null;
  let editAttempted = false;
  try {
    assertSentinels(await deps.snapshotSentinels());
    run = await deps.prepare();
    editAttempted = true;
    await deps.editCta(run);
    if (await deps.markActive(run) !== true) {
      throw new CanaryFlowError("CTA_FINALIZE_FAILED");
    }
    assertSentinels(await deps.snapshotSentinels());
    return Object.freeze({ run, state: "ACTIVE" });
  } catch (error) {
    if (!run) {
      try {
        run = await deps.getRun();
      } catch {
        run = null;
      }
    }
    let tokenRevoked = run === null;
    let ctaRemoved = !editAttempted;
    let sentinelsMatch = false;
    if (run) {
      try {
        tokenRevoked = await deps.ensureTokenRevoked(run) === true;
      } catch {
        tokenRevoked = false;
      }
      if (editAttempted) {
        try {
          ctaRemoved = await deps.removeAndVerifyCta(run) === true;
        } catch {
          ctaRemoved = false;
        }
      }
    }
    try {
      assertSentinels(await deps.snapshotSentinels());
      sentinelsMatch = true;
    } catch {
      sentinelsMatch = false;
    }
    const rollbackProven = tokenRevoked && ctaRemoved && sentinelsMatch;
    if (run) {
      try {
        const marked = await deps.markRunRollback(run, rollbackProven);
        if (marked !== true) throw new Error("RUN_ROLLBACK_NOT_MARKED");
      } catch {
        // The runtime is still forced into a non-active terminal path below.
      }
    }
    try {
      await deps.beginDeactivation();
    } catch {
      // Caller reports the rollback-required state; it must not retry live writes.
    }
    throw new CanaryFlowError("CANARY_CTA_ACTIVATION_FAILED", {
      edit_attempted: editAttempted,
      token_revoked: tokenRevoked,
      cta_removed: ctaRemoved,
      sentinels_match: sentinelsMatch,
      rollback_proven: rollbackProven,
      cause: error?.code ?? error?.message ?? "UNKNOWN",
    });
  }
}

export async function executeCanaryRollback(deps) {
  const run = await deps.getRun();
  if (!run) {
    if (await deps.beginDeactivation() !== true) {
      throw new CanaryFlowError("ZERO_RUN_DEACTIVATION_FAILED");
    }
    return Object.freeze({ state: "DEACTIVATING", zero_run: true });
  }

  let tokenRevoked = false;
  let ctaRemoved = false;
  let sentinelsMatch = false;
  try {
    tokenRevoked = await deps.ensureTokenRevoked(run) === true;
    if (!tokenRevoked) throw new CanaryFlowError("TOKEN_REVOKE_NOT_PROVEN");
    ctaRemoved = await deps.removeAndVerifyCta(run) === true;
    if (!ctaRemoved) throw new CanaryFlowError("CTA_REMOVE_NOT_PROVEN");
    assertSentinels(await deps.snapshotSentinels());
    sentinelsMatch = true;
    if (await deps.markRunRollback(run, true) !== true) {
      throw new CanaryFlowError("RUN_ROLLBACK_NOT_FINAL");
    }
    if (await deps.beginDeactivation() !== true) {
      throw new CanaryFlowError("RUNTIME_DEACTIVATION_FAILED");
    }
    return Object.freeze({ state: "DEACTIVATING", zero_run: false });
  } catch (error) {
    try {
      await deps.markRunRollback(run, false);
    } catch {
      // Fail closed; runtime transition is attempted next.
    }
    try {
      await deps.beginDeactivation();
    } catch {
      // No further live mutation is permitted without owner proof.
    }
    throw new CanaryFlowError("ROLLBACK_REQUIRES_OWNER_PROOF", {
      token_revoked: tokenRevoked,
      cta_removed: ctaRemoved,
      sentinels_match: sentinelsMatch,
      cause: error?.code ?? error?.message ?? "UNKNOWN",
    });
  }
}

function assertSentinels(snapshot) {
  if (
    !snapshot || snapshot.sentinel_count !== 2 || snapshot.matches !== true ||
    !/^[0-9a-f]{64}$/u.test(snapshot.current_hash) ||
    snapshot.current_hash !== snapshot.frozen_hash
  ) {
    throw new CanaryFlowError("SENTINEL_SCOPE_MISMATCH");
  }
}
