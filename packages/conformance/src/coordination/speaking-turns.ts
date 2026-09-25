/**
 * Draft coordination-candidate wire checks, not a live conformance profile.
 * This validates a single projection. It cannot prove fair ordering, atomic
 * contribution consumption, auth enforcement, or eventual wake delivery.
 */
export function validateSpeakingTurnProjection(
  value: unknown,
  options: { surface: "read" | "operation" | "wait" },
): void {
  const view = object(value, "speaking_turn");
  if (view.policy !== "speaking_turns") fail("policy");
  decimal(view.revision, "revision");
  if (typeof view.concluded !== "boolean") fail("concluded");
  if (view.next_deadline_at !== null) timestamp(view.next_deadline_at, "next_deadline_at");

  const holder = view.holder === null ? null : object(view.holder, "holder");
  if (holder) {
    text(holder.participant_id, "holder.participant_id");
    text(holder.request_id, "holder.request_id");
    decimal(holder.epoch, "holder.epoch", true);
    timestamp(holder.expires_at, "holder.expires_at");
    timestamp(holder.max_until, "holder.max_until");
    if (Date.parse(String(holder.expires_at)) > Date.parse(String(holder.max_until))) {
      fail("holder lease exceeds maximum tenure");
    }
  }

  const own = view.own === null ? null : object(view.own, "own");
  if (own) {
    text(own.request_id, "own.request_id");
    timestamp(own.expires_at, "own.expires_at");
    if (own.status === "queued") {
      if (!Number.isSafeInteger(own.queue_position) || Number(own.queue_position) < 1) {
        fail("own.queue_position");
      }
      if (holder?.request_id === own.request_id) fail("queued request is also holder");
    } else if (own.status === "held") {
      if (own.queue_position !== null) fail("held request has queue position");
      if (!holder || holder.request_id !== own.request_id)
        fail("held request lacks matching holder");
      if (holder.expires_at !== own.expires_at) fail("held request lease mismatch");
    } else {
      fail("own.status");
    }
  }

  if (view.concluded && (holder || own || view.next_deadline_at !== null)) {
    fail("concluded projection retains live work");
  }
  if ((holder || own) && view.next_deadline_at === null) fail("live request lacks next deadline");
  if (view.next_deadline_at !== null) {
    for (const request of [holder, own]) {
      if (
        request &&
        Date.parse(String(view.next_deadline_at)) > Date.parse(String(request.expires_at))
      ) {
        fail("next deadline follows a visible expiry");
      }
    }
  }

  if ("observation" in view) {
    if (options.surface !== "read") fail("non-read surface issued an observation");
    if (view.observation !== null) {
      text(view.observation, "observation");
      if (!own || own.status !== "held") fail("observation without own grant");
    }
  }

  if ("target" in view) {
    const target = object(view.target, "target");
    text(target.request_id, "target.request_id");
    if (!TARGET_STATES.has(String(target.status))) fail("target.status");
    if (
      target.status === "granted" &&
      (!own || own.status !== "held" || own.request_id !== target.request_id)
    ) {
      fail("granted target lacks own held request");
    }
    if (
      target.status === "waiting" &&
      (!own || own.status !== "queued" || own.request_id !== target.request_id)
    ) {
      fail("waiting target lacks own queued request");
    }
  }
  // Unrecognized additive fields are allowed. Missing required fields are not.
}

const TARGET_STATES = new Set([
  "waiting",
  "granted",
  "completed",
  "released",
  "expired",
  "removed",
  "concluded",
  "missing",
]);

function fail(field: string): never {
  throw new Error(`Invalid candidate speaking-turn projection: ${field}`);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(field);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) fail(field);
}

function decimal(value: unknown, field: string, positive = false) {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value) || (positive && BigInt(value) === 0n)) {
    fail(field);
  }
}

function timestamp(value: unknown, field: string) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail(field);
  }
}
