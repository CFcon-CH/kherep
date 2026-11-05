// Serialize read/compare/write within the NodeSession so an empty-queue pass
// cannot overwrite an earlier retry scheduled by an interleaved delivery.
export class AlarmSchedule {
  private tail: Promise<void> = Promise.resolve();
  constructor(privateStorage: Pick<DurableObjectStorage, "getAlarm" | "setAlarm">) { this.storage = privateStorage; }
  private readonly storage: Pick<DurableObjectStorage, "getAlarm" | "setAlarm">;
  earlier(due: number): Promise<void> {
    const write = this.tail.catch(() => {}).then(async () => {
      const current = await this.storage.getAlarm();
      if (current === null || current > due) await this.storage.setAlarm(due);
    });
    this.tail = write;
    return write;
  }
}
