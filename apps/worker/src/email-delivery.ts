import { deliverAndCheckVolume, type EmailVolumeCrossing, type EmailVolumeStore } from '../../../packages/notifications/src/index.js';
import { deliverWithDailyStaffEmails } from '../../../packages/reports/src/index.js';
import { dispatchRecruitThenDeliver, type RecruitDispatchPort } from '../../../packages/comms/src/recruit-dispatch.js';
import { dispatchPlacementsThen, type PlacementFeedPort } from '../../../packages/comms/src/placement-feed.js';
import { queuePersonRemindersThenDeliver, type PersonRemindersPort } from '../../../packages/comms/src/person-reminders.js';

type Delivery = Parameters<typeof deliverWithDailyStaffEmails>;

/**
 * The `email_delivery` job's work, exactly as the worker runs it: dispatch waiting placement events
 * and confirmed payments to the feed and waiting recruit events,
 * queue the daily staff emails and the person reminders when the worker can deliver (queueing
 * records the day for good, so a worker that would mark them not sent leaves them due), deliver one batch of due email
 * (`processDue`'s default size, oldest due first), then check the day's volume. An email queued
 * by this run goes out in this run if it fits the batch, otherwise in the next runs, in order.
 */
export function emailDeliveryWork(deps: {
  readonly recruitDispatch: RecruitDispatchPort;
  readonly placementFeed: PlacementFeedPort;
  readonly transferPaidFeed: PlacementFeedPort;
  readonly service: Delivery[0];
  readonly summaryStore: Delivery[1];
  readonly spikeStore: Delivery[2];
  readonly reminders: PersonRemindersPort;
  readonly volumeStore: EmailVolumeStore;
  readonly alert: (crossing: EmailVolumeCrossing) => void | Promise<void>;
  /** The clock; tests pin it. */
  readonly now?: () => Date;
}): () => Promise<number> {
  const { service } = deps, now = deps.now ?? (() => new Date());
  const delivery = { production: service.production, configured: service.configured,
    processDue: () => service.production && service.configured ? queuePersonRemindersThenDeliver(deps.reminders, () => service.processDue(), now) : service.processDue() };
  return () => deliverAndCheckVolume(
    () => dispatchPlacementsThen(deps.placementFeed, () => dispatchPlacementsThen(deps.transferPaidFeed, () => dispatchRecruitThenDeliver(deps.recruitDispatch, () => deliverWithDailyStaffEmails(delivery, deps.summaryStore, deps.spikeStore, now), now), now), now),
    deps.volumeStore, deps.alert, now);
}
