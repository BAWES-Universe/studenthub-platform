// Words for the person's work screens (C-10 to C-13) and /me/work, in English
// and Arabic. English is the default and reads exactly as before; Arabic is
// chosen from the person's language preference (the profile's), else the
// browser's Accept-Language. Numbers stay Latin in both, as the legacy apps
// showed them, and dates and times are Kuwait's.

import type { IncomingMessage } from "node:http";

export type WorkLanguage = "en" | "ar";

const TIME_ZONE = "Asia/Kuwait";
const locale = (lang: WorkLanguage) => lang === "ar" ? "ar-KW-u-nu-latn" : "en-GB";

function formats(lang: WorkLanguage) {
  return {
    clock: (iso: string) => new Intl.DateTimeFormat(locale(lang), { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso)),
    longDate: (date: string) => new Intl.DateTimeFormat(locale(lang), { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${date}T00:00:00Z`)),
    monthLabel: (month: string) => new Intl.DateTimeFormat(locale(lang), { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(`${month}-01T00:00:00Z`)),
  };
}

function englishDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds / 60));
  const h = Math.floor(total / 60), m = total % 60;
  return h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h ${m}m`;
}
function arabicDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds / 60));
  const h = Math.floor(total / 60), m = total % 60;
  return h === 0 ? `${m} د` : m === 0 ? `${h} س` : `${h} س ${m} د`;
}

const en = {
  lang: "en" as WorkLanguage,
  ...formats("en"),
  duration: englishDuration,
  tabs: { assignment: "Placement", track: "Track", history: "History", appeals: "Appeals" },
  navLabel: "Work",
  refusals: {
    location_required: "We need your location to clock in or out. Allow location for this site and try again.",
    not_assigned: "You aren't placed at a store today, so there is nothing to clock in to.",
    already_working: "You are already clocked in.",
    session_changed: "Your hours changed in another tab or device. Here they are now; try again if you still need to.",
    not_working: "You aren't clocked in right now.",
    overlaps_session: "That time overlaps hours you already logged.",
    end_before_start: "The end time must be after the start time.",
    in_future: "You can't log time that hasn't happened yet.",
    outside_assignment: "You weren't placed at a store on that date.",
    invalid_input: "Check the times and try again.",
  } as Readonly<Record<string, string>>,
  done: {
    started: "You're clocked in.",
    stopped: "You're clocked out. Your hours are waiting for approval.",
    discarded: "That session was discarded.",
    added: "Your hours were added and are waiting for approval. They are marked as entered late.",
  } as Readonly<Record<string, string>>,
  status: { pending: "Waiting for approval", approved: "Approved", rejected: "Rejected" } as Readonly<Record<string, string>>,
  location: { unsupported: "This browser can't share your location.", getting: "Getting your location...", failed: "We couldn't get your location. Allow location for this site and try again." },
  manual: {
    heading: "Forgot to clock in?", intro: "Log the time yourself. It is marked as entered late and still needs approval. Times are Kuwait time.",
    started: "Started", ended: "Ended", note: "Note (optional)", submit: "Add hours",
  },
  yourStore: "your store", aStore: "A store", YourStore: "Your store",
  track: {
    title: "Track", clockedIn: "You're clocked in", since: (time: string, where: string, elapsed: string) => `Since ${time} at ${where} (${elapsed} so far).`,
    clockOut: "Clock out", clockIn: "Clock in", mistake: "Clocked in by mistake? Discarding removes this session; it will not count.", discard: "Discard this session",
    notIn: "Not clocked in", placedAt: (where: string) => `You're placed at ${where} today.`,
    notPlaced: "You aren't placed at a store today, so there is nothing to clock in to.",
  },
  history: {
    title: "History", approved: "Approved", waiting: "Waiting for approval", rejected: "Rejected", none: (month: string) => `No hours logged in ${month}.`, days: "Days",
    sessions: (n: number) => `${n} ${n === 1 ? "session" : "sessions"}`, approvedPart: (d: string) => `, ${d} approved`, waitingPart: (d: string) => `, ${d} waiting`,
    rejectedPart: (d: string) => `, ${d} rejected`, inProgressPart: ", in progress", truncated: "Only the first part of this month is shown.",
    next: "Next month", previous: "Previous month", months: "Months",
  },
  session: {
    toNow: (start: string) => `${start} to now`, range: (start: string, end: string, d: string) => `${start} to ${end} (${d})`, inProgress: "In progress",
    enteredLate: "entered late", corrected: "corrected by StudentHub", noLocation: "no location recorded", list: ", ",
    reason: "Reason:", note: "Note:", yourNote: "Your note:", appeal: "Appeal these hours",
  },
  appealStatus: { submitted: "Sent", awaiting_review: "Waiting for review", in_progress: "Being looked at", resolved: "Resolved" } as Readonly<Record<string, string>>,
  appealDone: { raised: "Your appeal was sent. StudentHub will look at it and reply here." } as Readonly<Record<string, string>>,
  sessionTime: (date: string, start: string, end: string | null) => `${date}, ${start} to ${end ?? "now"}`,
  appeals: {
    title: "Appeals", empty: (historyLink: string) => `You haven't appealed any hours. To appeal, open a day in ${historyLink} and choose "Appeal these hours".`, historyLinkText: "History",
    raised: (date: string) => `Raised ${date}`, older: "Older appeals",
    newTitle: "Appeal hours", whatIsWrong: "What is wrong with these hours?", send: "Send appeal",
    added: "Added", correctedTo: "Corrected to", detailTitle: "Appeal",
    raisedAbout: (date: string, time: string, where: string) => `Raised ${date} about ${time} at ${where}.`, yourReason: "Your reason:",
    changes: "Changes to your hours", noReply: "No reply yet.", newMark: " · New", replies: "Replies from StudentHub", all: "All appeals",
    invalid: "Tell us what is wrong with these hours.", open: "You already have an open appeal on these hours. Follow it in Appeals.", cannot: "These hours can't be appealed.",
  },
  day: {
    none: "No hours logged on this day.", totals: (a: string, w: string, r: string) => `Approved ${a} · Waiting ${w} · Rejected ${r}`,
    later: "Later sessions on this day", back: (month: string) => `Back to ${month}`,
  },
  placedBy: { staff: "Placed by StudentHub", request: "Placed at the company's request", recruit: "Placed after recruitment", import: "Placed in the old system" } as Readonly<Record<string, string>>,
  placement: {
    title: "Placement", period: (from: string, to: string) => `${from} to ${to}`, openPeriod: (from: string) => `From ${from}, no end date`,
    notNow: "You aren't placed at a store right now.", details: "Details", clock: "Clock in or out", nowHeading: "Where you work now", next: "Coming up", past: "Before",
    store: "Store", periodLabel: "Period", how: "How", placed: "Placed", hours: "Your hours", all: "All placements",
  },
  errors: {
    unavailable: ["Work is unavailable", "Hours tracking isn't switched on here yet."],
    signIn: ["Sign in", "Sign in to see your hours."],
    placementNotFound: ["Placement not found", "This placement isn't yours or doesn't exist."],
    monthNotFound: ["Month not found", "Choose a month up to this one."],
    dayNotFound: ["Day not found", "That isn't a valid date."],
    dayPage: ["Page not found", "That page of the day isn't valid."],
    listPage: ["Page not found", "That list page isn't valid."],
    hoursNotFound: ["Hours not found", "Open the day in History and choose the hours to appeal."],
    appealNotFound: ["Appeal not found", "This appeal isn't yours or doesn't exist."],
    notAllowed: ["Not allowed", "This page can't do that."],
    refused: ["Request refused", "We could not verify this request."],
    appealNotSent: ["Appeal not sent", "Open the day in History and try again."],
    tooLong: ["Too long", "What you sent is too long. Shorten it and try again."],
    wrong: ["Work is unavailable", "Something went wrong. Try again in a moment."],
  } as Readonly<Record<string, readonly [string, string]>>,
};

export type WorkCopy = typeof en;

const ar: WorkCopy = {
  lang: "ar",
  ...formats("ar"),
  duration: arabicDuration,
  tabs: { assignment: "مكان العمل", track: "تسجيل الدوام", history: "السجل", appeals: "الاعتراضات" },
  navLabel: "العمل",
  refusals: {
    location_required: "نحتاج موقعك لتسجيل الدخول أو الخروج. اسمح لهذا الموقع بمعرفة موقعك ثم حاول مرة أخرى.",
    not_assigned: "ليس لديك مكان عمل في متجر اليوم، فلا يوجد ما تسجّل الدخول إليه.",
    already_working: "أنت مسجّل الدخول بالفعل.",
    session_changed: "تغيّرت ساعاتك من نافذة أو جهاز آخر. هذه ساعاتك الآن؛ حاول مرة أخرى إن احتجت.",
    not_working: "أنت غير مسجّل الدخول الآن.",
    overlaps_session: "هذا الوقت يتداخل مع ساعات سجّلتها من قبل.",
    end_before_start: "يجب أن يكون وقت الانتهاء بعد وقت البدء.",
    in_future: "لا يمكنك تسجيل وقت لم يحدث بعد.",
    outside_assignment: "لم يكن لديك مكان عمل في متجر في ذلك التاريخ.",
    invalid_input: "راجع الأوقات ثم حاول مرة أخرى.",
  },
  done: {
    started: "تم تسجيل دخولك.",
    stopped: "تم تسجيل خروجك. ساعاتك بانتظار الموافقة.",
    discarded: "تم إلغاء هذه الجلسة.",
    added: "أُضيفت ساعاتك وهي بانتظار الموافقة. وهي معلّمة بأنها أُدخلت متأخرة.",
  },
  status: { pending: "بانتظار الموافقة", approved: "تمت الموافقة", rejected: "مرفوضة" },
  location: { unsupported: "هذا المتصفح لا يستطيع مشاركة موقعك.", getting: "جارٍ تحديد موقعك...", failed: "لم نتمكن من تحديد موقعك. اسمح لهذا الموقع بمعرفة موقعك ثم حاول مرة أخرى." },
  manual: {
    heading: "نسيت تسجيل الدخول؟", intro: "سجّل الوقت بنفسك. سيُعلَّم بأنه أُدخل متأخرًا ويحتاج إلى موافقة. الأوقات بتوقيت الكويت.",
    started: "البداية", ended: "النهاية", note: "ملاحظة (اختيارية)", submit: "إضافة الساعات",
  },
  yourStore: "متجرك", aStore: "متجر", YourStore: "متجرك",
  track: {
    title: "تسجيل الدوام", clockedIn: "أنت مسجّل الدخول", since: (time, where, elapsed) => `منذ ${time} في ${where} (${elapsed} حتى الآن).`,
    clockOut: "تسجيل الخروج", clockIn: "تسجيل الدخول", mistake: "سجّلت الدخول بالخطأ؟ الإلغاء يحذف هذه الجلسة ولن تُحتسب.", discard: "إلغاء هذه الجلسة",
    notIn: "غير مسجّل الدخول", placedAt: (where) => `مكان عملك اليوم: ${where}.`,
    notPlaced: "ليس لديك مكان عمل في متجر اليوم، فلا يوجد ما تسجّل الدخول إليه.",
  },
  history: {
    title: "السجل", approved: "تمت الموافقة", waiting: "بانتظار الموافقة", rejected: "مرفوضة", none: (month) => `لا توجد ساعات مسجّلة في ${month}.`, days: "الأيام",
    sessions: (n) => n === 1 ? "جلسة واحدة" : n === 2 ? "جلستان" : `${n} جلسات`, approvedPart: (d) => `، ${d} تمت الموافقة عليها`, waitingPart: (d) => `، ${d} بالانتظار`,
    rejectedPart: (d) => `، ${d} مرفوضة`, inProgressPart: "، جارية", truncated: "يظهر الجزء الأول فقط من هذا الشهر.",
    next: "الشهر التالي", previous: "الشهر السابق", months: "الأشهر",
  },
  session: {
    toNow: (start) => `${start} حتى الآن`, range: (start, end, d) => `${start} إلى ${end} (${d})`, inProgress: "جارية",
    enteredLate: "أُدخلت متأخرة", corrected: "صحّحها فريق StudentHub", noLocation: "لم يُسجَّل موقع", list: "، ",
    reason: "السبب:", note: "ملاحظة:", yourNote: "ملاحظتك:", appeal: "الاعتراض على هذه الساعات",
  },
  appealStatus: { submitted: "أُرسل", awaiting_review: "بانتظار المراجعة", in_progress: "قيد المراجعة", resolved: "تمت المعالجة" },
  appealDone: { raised: "أُرسل اعتراضك. سيراجعه فريق StudentHub ويرد عليك هنا." },
  sessionTime: (date, start, end) => `${date}، ${start} إلى ${end ?? "الآن"}`,
  appeals: {
    title: "الاعتراضات", empty: (historyLink) => `لم تعترض على أي ساعات. للاعتراض، افتح يومًا في ${historyLink} واختر "الاعتراض على هذه الساعات".`, historyLinkText: "السجل",
    raised: (date) => `قُدّم في ${date}`, older: "اعتراضات أقدم",
    newTitle: "الاعتراض على الساعات", whatIsWrong: "ما الخطأ في هذه الساعات؟", send: "إرسال الاعتراض",
    added: "أُضيفت", correctedTo: "صُحّحت إلى", detailTitle: "الاعتراض",
    raisedAbout: (date, time, where) => `قُدّم في ${date} بشأن ${time} في ${where}.`, yourReason: "سببك:",
    changes: "تغييرات على ساعاتك", noReply: "لا يوجد رد بعد.", newMark: " · جديد", replies: "ردود فريق StudentHub", all: "كل الاعتراضات",
    invalid: "أخبرنا ما الخطأ في هذه الساعات.", open: "لديك اعتراض مفتوح على هذه الساعات. تابعه في الاعتراضات.", cannot: "لا يمكن الاعتراض على هذه الساعات.",
  },
  day: {
    none: "لا توجد ساعات مسجّلة في هذا اليوم.", totals: (a, w, r) => `تمت الموافقة ${a} · بالانتظار ${w} · مرفوضة ${r}`,
    later: "جلسات لاحقة في هذا اليوم", back: (month) => `العودة إلى ${month}`,
  },
  placedBy: { staff: "عيّنك فريق StudentHub", request: "عُيّنت بطلب من الشركة", recruit: "عُيّنت بعد التوظيف", import: "عُيّنت في النظام القديم" },
  placement: {
    title: "مكان العمل", period: (from, to) => `${from} إلى ${to}`, openPeriod: (from) => `من ${from}، بدون تاريخ انتهاء`,
    notNow: "ليس لديك مكان عمل في متجر الآن.", details: "التفاصيل", clock: "تسجيل الدخول أو الخروج", nowHeading: "مكان عملك الآن", next: "القادم", past: "السابق",
    store: "المتجر", periodLabel: "المدة", how: "طريقة التعيين", placed: "مُعيَّن", hours: "ساعاتك", all: "كل أماكن العمل",
  },
  errors: {
    unavailable: ["العمل غير متاح", "تسجيل الساعات غير مفعّل هنا بعد."],
    signIn: ["تسجيل الدخول", "سجّل الدخول لرؤية ساعاتك."],
    placementNotFound: ["مكان العمل غير موجود", "مكان العمل هذا ليس لك أو غير موجود."],
    monthNotFound: ["الشهر غير موجود", "اختر شهرًا حتى الشهر الحالي."],
    dayNotFound: ["اليوم غير موجود", "هذا ليس تاريخًا صحيحًا."],
    dayPage: ["الصفحة غير موجودة", "صفحة اليوم هذه غير صحيحة."],
    listPage: ["الصفحة غير موجودة", "صفحة القائمة هذه غير صحيحة."],
    hoursNotFound: ["الساعات غير موجودة", "افتح اليوم في السجل واختر الساعات التي تريد الاعتراض عليها."],
    appealNotFound: ["الاعتراض غير موجود", "هذا الاعتراض ليس لك أو غير موجود."],
    notAllowed: ["غير مسموح", "لا يمكن لهذه الصفحة القيام بذلك."],
    refused: ["تم رفض الطلب", "لم نتمكن من التحقق من هذا الطلب."],
    appealNotSent: ["لم يُرسل الاعتراض", "افتح اليوم في السجل وحاول مرة أخرى."],
    tooLong: ["النص طويل جدًا", "ما أرسلته طويل جدًا. اختصره وحاول مرة أخرى."],
    wrong: ["العمل غير متاح", "حدث خطأ ما. حاول مرة أخرى بعد قليل."],
  },
};

export const WORK_COPY: Readonly<Record<WorkLanguage, WorkCopy>> = Object.freeze({ en, ar });

/** The browser's first choice between Arabic and English (Accept-Language), English otherwise. */
export function browserLanguage(req: Pick<IncomingMessage, "headers">): WorkLanguage {
  const header = req.headers["accept-language"];
  if (typeof header !== "string") return "en";
  const ranked = header.split(",").map((part, i) => {
    const [tag = "", ...params] = part.trim().split(";");
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return { tag: tag.toLowerCase(), q: q ? Number(q.slice(2)) : 1, i };
  }).filter((x) => Number.isFinite(x.q) && x.q > 0).sort((a, b) => b.q - a.q || a.i - b.i);
  const first = ranked.find((x) => /^(ar|en)(-|$)/.test(x.tag));
  return first?.tag.startsWith("ar") ? "ar" : "en";
}

/** The person's language: their saved preference, else their browser's. */
export async function workCopyFor(lookup: ((personId: string) => Promise<WorkLanguage | undefined>) | undefined, personId: string | undefined, req: Pick<IncomingMessage, "headers">): Promise<WorkCopy> {
  const saved = personId && lookup ? await lookup(personId).catch(() => undefined) : undefined;
  return WORK_COPY[saved ?? browserLanguage(req)];
}
