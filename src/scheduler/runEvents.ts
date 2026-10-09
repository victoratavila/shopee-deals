import { EventEmitter } from "node:events";

export interface SchedulerRunFinishedEvent {
  runId: string;
  finishedAt: string;
}

export const schedulerRunEvents = new EventEmitter();

export function notifySchedulerRunFinished(event: SchedulerRunFinishedEvent): void {
  schedulerRunEvents.emit("run-finished", event);
}
