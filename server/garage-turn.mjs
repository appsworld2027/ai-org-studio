// Free-chat continuity boundary. This does not change the Garage transport,
// access controls or publication policy.
export async function prepareGarageTurn(garage, emit = () => {}) {
  const receipt = await garage.pull();
  if (receipt.ok) return receipt;
  if (receipt.available || receipt.configured) throw new Error(receipt.reason || "Garage recovery did not complete; turn paused.");
  emit({ t: "note", message: "Garage is not configured; shared cross-session memory is unavailable." });
  return receipt;
}

export async function persistGarageTurn(garage, product, info, log = () => {}) {
  if (!garage.ready()) return { ok: false, available: false, pushed: false, reason: "Garage unavailable" };
  let journalError = false;
  try { garage.journal(product, info); }
  catch (e) { journalError = true; log("Garage journal failed"); }
  try {
    const receipt = await garage.save(product, `${info.engine}: ${String(info.ask || "").replace(/\s+/g, " ").slice(0, 70)}`);
    return journalError
      ? { ...receipt, available: true, ok: false, reason: "Garage journal failed; complete turn checkpoint not recorded." }
      : { ...receipt, available: true };
  } catch {
    return { ok: false, available: true, pushed: false, reason: "Garage checkpoint failed; local state may require reconciliation." };
  }
}

export async function completeGarageTurn({ checkpoint, emit, release }) {
  try {
    if (checkpoint) {
      const receipt = await checkpoint();
      if (!receipt?.ok && receipt?.available !== false) {
        emit({ t: "note", message: "Garage checkpoint not confirmed durable. Local state retained where possible; retry synchronization before relying on this checkpoint." });
      }
    }
  } catch {
    emit({ t: "note", message: "Garage checkpoint not confirmed durable. Retry synchronization before relying on this checkpoint." });
  } finally {
    release();
  }
}
