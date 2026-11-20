import { deliverAndCheckVolume, type EmailVolumeCrossing, type EmailVolumeStore } from '../../../packages/notifications/src/index.js';
import { deliverWithDailyStaffEmails } from '../../../packages/reports/src/index.js';
import { dispatchRecruitThenDeliver, type RecruitDispatchPort } from '../../../packages/comms/src/recruit-dispatch.js';

type Delivery = Parameters<typeof deliverWithDailyStaffEmails>;

/**
 * The `email_delivery` job's work, exactly as the worker runs it: dispatch waiting recruit events,
 * queue the daily staff emails when the worker can deliver, deliver one batch of due email
 * (`processDue`'s default size, oldest due first), then check the day's volume. An email queued
 * by this run goes out in this run if it fits the batch, otherwise in the next runs, in order.
 */
export function emailDeliveryWork(deps: {
  readonly recruitDispatch: RecruitDispatchPort;
  readonly service: Delivery[0];
  readonly summaryStore: Delivery[1];
  readonly spikeStore: Delivery[2];
  readonly volumeStore: EmailVolumeStore;
  readonly alert: (crossing: EmailVolumeCrossing) => void | Promise<void>;
}): () => Promise<number> {
  return () => deliverAndCheckVolume(
    () => dispatchRecruitThenDeliver(deps.recruitDispatch, () => deliverWithDailyStaffEmails(deps.service, deps.summaryStore, deps.spikeStore)),
    deps.volumeStore, deps.alert);
}
