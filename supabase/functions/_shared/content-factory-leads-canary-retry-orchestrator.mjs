export class RetryFlowError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "RetryFlowError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export async function executeRetryDelivery(deps) {
  let run = null;
  let claimed = false;
  let delivered = null;
  let rollbackHandled = false;
  try {
    run = await deps.prepare();
    if (!run) throw new RetryFlowError("POST13D_PREPARE_FAILED");
    if (await deps.claim(run) !== true) {
      throw new RetryFlowError("POST13D_DELIVERY_CLAIM_FAILED", {
        delivery: "NONE",
      });
    }
    claimed = true;
    delivered = await deps.send(run);
    if (!delivered || !Number.isSafeInteger(delivered.messageId)) {
      throw new RetryFlowError("POST13D_DELIVERY_RESPONSE_INVALID", {
        delivery: "AMBIGUOUS",
      });
    }
    if (await deps.finalize(run, delivered) !== true) {
      let compensated = false;
      try {
        compensated = await deps.compensate(run, delivered) === true;
      } catch {
        compensated = false;
      }
      const marked = await deps.rollback(
        run,
        compensated ? "FINALIZE_FAILED" : "COMPENSATION_UNCERTAIN",
        compensated,
      );
      rollbackHandled = marked === true;
      throw new RetryFlowError("POST13D_FINALIZE_FAILED", {
        delivery: "VERIFIED",
        compensated,
        rollback_marked: rollbackHandled,
      });
    }
    return Object.freeze({ run, delivered, state: "ACTIVE" });
  } catch (error) {
    if (!delivered && error?.details?.delivered) {
      delivered = error.details.delivered;
    }
    if (run && !rollbackHandled) {
      const delivery = error?.details?.delivery ??
        (delivered ? "VERIFIED" : claimed ? "AMBIGUOUS" : "NONE");
      let proven = delivery === "NONE";
      let reason = proven ? "DELIVERY_REJECTED" : "DELIVERY_AMBIGUOUS";
      if (delivery === "VERIFIED" && delivered) {
        try {
          proven = await deps.compensate(run, delivered) === true;
        } catch {
          proven = false;
        }
        reason = proven ? "FINALIZE_FAILED" : "COMPENSATION_UNCERTAIN";
      }
      try {
        rollbackHandled = await deps.rollback(run, reason, proven) === true;
      } catch {
        rollbackHandled = false;
      }
    }
    throw new RetryFlowError("POST13D_DELIVERY_FAILED", {
      prepared: Boolean(run),
      claimed,
      delivered: Boolean(delivered),
      rollback_marked: rollbackHandled,
      cause: error?.code ?? error?.message ?? "UNKNOWN",
    });
  }
}
