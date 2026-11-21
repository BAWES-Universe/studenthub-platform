/** Every journey the walker knows, in walk order. */
import type { Journey } from "../journey.js";
import { workHistory } from "./work-history.js";

export const JOURNEYS: readonly Journey[] = [workHistory];
