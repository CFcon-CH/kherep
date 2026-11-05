// Serialize read/compare/write within the NodeSession so an empty-queue pass
// cannot overwrite an earlier retry scheduled by an interleaved delivery.
export class AlarmSchedule {
  private tail: Promise<void> = Promise.resolve();
  constructor(privateStorage: Pick<DurableObjectStorage, "getAlarm" | "setAlarm">) { this.storage = privateStorage; }
  private readonly storage: Pick<DurableObjectStorage, "getAlarm" | "setAlarm">;
  earlier(due: number): Promise<void> {
    return this.schedule(due, false);
  }
  // A completed retry pass owns its fallback, which must move later even
  // when pushFrame armed it during that pass. Subsequent writes stay ordered.
  replace(due: number): Promise<void> {
    return this.schedule(due, true);
  }
  private schedule(due: number, replace: boolean): Promise<void> {
    const write = this.tail.catch(() => {}).then(async () => {
      if (replace) {
        // Retry a transient completion write once within this same serialized
        // operation, so a later fresh delivery's earlier write still wins.
        try { await this.storage.setAlarm(due); }
        catch { await this.storage.setAlarm(due); }
        return;
      }
      const current = await this.storage.getAlarm();
      if (current === null || current > due) await this.storage.setAlarm(due);
    });
    this.tail = write;
    return write;
  }
}
