/** Profile-journey copy. These strings do not imply that a route or field is implemented. */
export type ProfileLanguage = 'en' | 'ar';

const english = {
  "nav.profile": "My profile",
  "nav.background": "Education and experience",
  "nav.workspaces": "Workspaces",
  "nav.main": "Main navigation",
  "nav.sections": "Profile sections",
  "nav.skip": "Skip to content",
  "nav.back": "Back to my profile",
  "action.signOut": "Sign out",
  "action.signIn": "Sign in to continue",
  "action.edit": "Edit",
  "action.editField": "Edit {field}",
  "action.addField": "Add {field}",
  "action.save": "Save",
  "action.cancel": "Cancel",
  "action.keep": "Keep editing",
  "action.discard": "Discard changes",
  "action.retry": "Try again",
  "action.check": "Check save status",
  "action.current": "Review current value",
  "action.review": "Review change",
  "action.confirm": "Confirm change",
  "action.background": "Open education and experience",
  "title.edit": "Edit {field}",
  "title.review": "Review profile change",
  "title.fallback": "Your StudentHub profile",
  "section.work": "About my work",
  "section.personal": "Personal details",
  "section.background": "Education and experience",
  "section.details": "More profile details",
  "field.displayName": "Display name",
  "field.arabicName": "Arabic name",
  "field.gender": "Gender",
  "field.birthDate": "Birth date",
  "field.age": "Age",
  "field.nationality": "Nationality",
  "field.university": "University",
  "field.objective": "Objective",
  "field.intro": "Introduction",
  "field.preferredTime": "Preferred time",
  "field.language": "Language",
  "field.area": "Area",
  "field.drivingLicence": "Driving licence",
  "field.jobSearchStatus": "Looking for work",
  "field.committed": "Commitment marker",
  "field.isProfileCompleted": "Imported profile completeness",
  "field.pendingFields": "Imported profile requirements",
  "field.employeeIdentifier": "StudentHub ID",
  "field.civilExpired": "Civil ID expired",
  "value.yes": "Yes",
  "value.no": "No",
  "value.male": "Male",
  "value.female": "Female",
  "value.other": "Other",
  "value.notLooking": "Not looking right now",
  "value.active": "Actively looking for work",
  "value.open": "Open to offers",
  "value.english": "English",
  "value.arabic": "Arabic",
  "value.missing": "Not recorded",
  "value.unavailable": "Unavailable",
  "value.complete": "Complete",
  "value.incomplete": "Incomplete",
  "value.none": "None",
  "meta.imported": "Imported on {date}",
  "meta.updated": "Updated by you on {date}",
  "meta.notImported": "Not imported",
  "meta.historical": "These imported indicators do not describe your latest edits.",
  "meta.readOnly": "This detail cannot be edited here yet.",
  "help.privacy": "This page excludes documents, civil ID numbers, bank details and internal notes.",
  "help.preferredTime": "Your preferred working time.",
  "help.name": "Enter at least two name parts, separated by single spaces.",
  "help.arabicName": "Use Arabic letters in your name. You can leave this blank.",
  "help.optional": "Optional. Leave blank to remove this value.",
  "help.limit": "Maximum {limit} characters.",
  "help.text": "No spaces at the start or end, repeated spaces, or line breaks.",
  "help.chooseStatus": "Choose your current work-search status.",
  "help.date": "Enter your birth date as a calendar date.",
  "help.birth": "You must be at least 16.",
  "help.language": "Other journeys may still be in English.",
  "state.ready": "Ready",
  "state.empty": "Not recorded",
  "state.invalid": "Correct this field",
  "state.conflict": "Profile changed",
  "state.unavailable": "Profile unavailable",
  "state.expired": "Session expired",
  "status.saving": "Saving…",
  "status.saved": "Saved {field}: {value}",
  "status.cleared": "Saved {field}: Not recorded",
  "status.unknown": "Save not confirmed",
  "status.checking": "Checking save status…",
  "status.receipt": "Earlier save confirmed: {field}",
  "draft.title": "Unsaved changes",
  "draft.cancelHelp": "Cancel discards this unsaved change.",
  "draft.leave": "Leave without saving this change?",
  "draft.current": "Current value",
  "draft.yours": "Your draft",
  "draft.restored": "Your unsaved draft is ready to review.",
  "draft.phoneReentry": "Enter your phone number again. Your previous entry is not shown.",
  "draft.expired": "Your unsaved draft is no longer available. Enter your change again.",
  "error.required": "Enter {field}.",
  "error.choice": "Choose one of the available options.",
  "error.length": "Use no more than {limit} characters.",
  "error.name": "Use at least two letter-based name parts with single spaces; check punctuation.",
  "error.arabicName": "Enter a name containing Arabic letters.",
  "error.spacing": "Remove extra spaces at the start or end and repeated spaces.",
  "error.characters": "Remove line breaks and unsupported control characters.",
  "error.date": "Enter a valid calendar date.",
  "error.future": "Birth date cannot be in the future.",
  "error.minimumAge": "You must be at least 16 to complete a StudentHub profile.",
  "error.invalid": "Check {field} and try again.",
  "error.canonical": "We could not safely interpret this value. Check it before saving.",
  "error.conflict": "This value changed since you opened the form. Review it before saving your draft.",
  "error.tokenPayloadMismatch": "This save attempt contains a different change. Review your draft before saving again.",
  "error.load": "We could not load your profile. Try again.",
  "error.unknown": "We could not confirm whether your change was saved. Check its status before trying another change.",
  "error.denied": "This profile is no longer available.",
  "error.session": "Sign in again to continue safely.",
  "error.formExpired": "This form expired. Reload the current value before saving.",
  "error.security": "We could not verify this request. Reopen the form and try again.",
  "pending.identity_reference": "Identity reference",
  "pending.nationality": "Nationality",
  "pending.display_name": "Display name",
  "pending.arabic_name": "Arabic name",
  "pending.gender": "Gender",
  "pending.objective": "Objective",
  "pending.personal_photo": "Personal photo",
  "pending.email": "Email",
  "pending.phone": "Phone number",
  "pending.birth_date": "Birth date",
  "pending.civil_id": "Civil ID",
  "pending.civil_expiry": "Civil ID expiry",
  "pending.civil_front": "Civil ID front",
  "pending.civil_back": "Civil ID back",
  "pending.driving_licence": "Driving licence",
  "pending.location": "Location",
  "pending.kuwaiti_mother": "Kuwaiti mother",
  "pending.education": "Education",
  "pending.skill": "Skill",
} as const;

export type ProfileCopyKey = keyof typeof english;

const arabic = {
  "nav.profile": "ملفي الشخصي",
  "nav.background": "التعليم والخبرة",
  "nav.workspaces": "مساحات العمل",
  "nav.main": "التنقل الرئيسي",
  "nav.sections": "أقسام الملف الشخصي",
  "nav.skip": "الانتقال إلى المحتوى",
  "nav.back": "العودة إلى ملفي الشخصي",
  "action.signOut": "تسجيل الخروج",
  "action.signIn": "سجّل الدخول للمتابعة",
  "action.edit": "تعديل",
  "action.editField": "تعديل {field}",
  "action.addField": "إضافة {field}",
  "action.save": "حفظ",
  "action.cancel": "إلغاء",
  "action.keep": "متابعة التعديل",
  "action.discard": "تجاهل التغييرات",
  "action.retry": "المحاولة مرة أخرى",
  "action.check": "التحقق من حالة الحفظ",
  "action.current": "مراجعة القيمة الحالية",
  "action.review": "مراجعة التغيير",
  "action.confirm": "تأكيد التغيير",
  "action.background": "فتح التعليم والخبرة",
  "title.edit": "تعديل {field}",
  "title.review": "مراجعة تغيير الملف الشخصي",
  "title.fallback": "ملفك الشخصي في StudentHub",
  "section.work": "نبذة عن عملي",
  "section.personal": "البيانات الشخصية",
  "section.background": "التعليم والخبرة",
  "section.details": "تفاصيل إضافية عن الملف الشخصي",
  "field.displayName": "الاسم المعروض",
  "field.arabicName": "الاسم بالعربية",
  "field.gender": "الجنس",
  "field.birthDate": "تاريخ الميلاد",
  "field.age": "العمر",
  "field.nationality": "الجنسية",
  "field.university": "الجامعة",
  "field.objective": "الهدف المهني",
  "field.intro": "نبذة تعريفية",
  "field.preferredTime": "الوقت المفضل",
  "field.language": "اللغة",
  "field.area": "المنطقة",
  "field.drivingLicence": "رخصة القيادة",
  "field.jobSearchStatus": "البحث عن عمل",
  "field.committed": "مؤشر الالتزام",
  "field.isProfileCompleted": "اكتمال الملف الشخصي عند الاستيراد",
  "field.pendingFields": "متطلبات الملف الشخصي المستوردة",
  "field.employeeIdentifier": "رقم StudentHub",
  "field.civilExpired": "البطاقة المدنية منتهية الصلاحية",
  "value.yes": "نعم",
  "value.no": "لا",
  "value.male": "ذكر",
  "value.female": "أنثى",
  "value.other": "آخر",
  "value.notLooking": "لا أبحث عن عمل حاليًا",
  "value.active": "أبحث عن عمل بجدية",
  "value.open": "أرحّب بعروض العمل",
  "value.english": "الإنجليزية",
  "value.arabic": "العربية",
  "value.missing": "غير مسجل",
  "value.unavailable": "غير متاح",
  "value.complete": "مكتمل",
  "value.incomplete": "غير مكتمل",
  "value.none": "لا يوجد",
  "meta.imported": "تم الاستيراد في {date}",
  "meta.updated": "آخر تحديث منك في {date}",
  "meta.notImported": "لم يتم الاستيراد",
  "meta.historical": "هذه المؤشرات المستوردة لا تعكس أحدث تعديلاتك.",
  "meta.readOnly": "لا يمكن تعديل هذه المعلومة هنا بعد.",
  "help.privacy": "لا تتضمن هذه الصفحة المستندات أو أرقام البطاقات المدنية أو البيانات البنكية أو الملاحظات الداخلية.",
  "help.preferredTime": "الوقت الذي تفضله للعمل.",
  "help.name": "أدخل اسمًا مكوّنًا من جزأين على الأقل، مع مسافة واحدة بين الأجزاء.",
  "help.arabicName": "استخدم أحرفًا عربية في اسمك. يمكنك ترك هذا الحقل فارغًا.",
  "help.optional": "اختياري. اترك الحقل فارغًا لإزالة هذه القيمة.",
  "help.limit": "الحد الأقصى لعدد الأحرف: {limit}",
  "help.text": "لا تستخدم مسافات في البداية أو النهاية، أو مسافات متكررة، أو فواصل أسطر.",
  "help.chooseStatus": "اختر حالتك الحالية في البحث عن عمل.",
  "help.date": "أدخل تاريخ ميلادك كتاريخ تقويمي.",
  "help.birth": "يجب ألا يقل عمرك عن 16 عامًا.",
  "help.language": "قد تظل الصفحات الأخرى باللغة الإنجليزية.",
  "state.ready": "جاهز",
  "state.empty": "غير مسجل",
  "state.invalid": "صحّح هذا الحقل",
  "state.conflict": "تغيّر الملف الشخصي",
  "state.unavailable": "الملف الشخصي غير متاح",
  "state.expired": "انتهت الجلسة",
  "status.saving": "جارٍ الحفظ…",
  "status.saved": "تم حفظ {field}: {value}",
  "status.cleared": "تم حفظ {field}: غير مسجل",
  "status.unknown": "لم يتم تأكيد الحفظ",
  "status.checking": "جارٍ التحقق من حالة الحفظ…",
  "status.receipt": "تم تأكيد الحفظ السابق: {field}",
  "draft.title": "تغييرات غير محفوظة",
  "draft.cancelHelp": "يؤدي الإلغاء إلى تجاهل هذا التغيير غير المحفوظ.",
  "draft.leave": "هل تريد المغادرة دون حفظ هذا التغيير؟",
  "draft.current": "القيمة الحالية",
  "draft.yours": "مسودتك",
  "draft.restored": "مسودتك غير المحفوظة جاهزة للمراجعة.",
  "draft.phoneReentry": "أدخل رقم هاتفك مجددًا. لن يظهر إدخالك السابق.",
  "draft.expired": "لم تعد مسودتك غير المحفوظة متاحة. أدخل التغيير مرة أخرى.",
  "error.required": "أدخل {field}.",
  "error.choice": "اختر أحد الخيارات المتاحة.",
  "error.length": "يجب ألا يتجاوز عدد الأحرف {limit}",
  "error.name": "استخدم جزأين على الأقل من الاسم مكوّنين من أحرف، مع مسافة واحدة بينهما، وتحقق من علامات الترقيم.",
  "error.arabicName": "أدخل اسمًا يحتوي على أحرف عربية.",
  "error.spacing": "أزل المسافات الزائدة في البداية أو النهاية والمسافات المتكررة.",
  "error.characters": "أزل فواصل الأسطر ومحارف التحكم غير المدعومة.",
  "error.date": "أدخل تاريخًا صحيحًا.",
  "error.future": "لا يمكن أن يكون تاريخ الميلاد في المستقبل.",
  "error.minimumAge": "يجب ألا يقل عمرك عن 16 عامًا لإكمال ملف شخصي في StudentHub.",
  "error.invalid": "تحقق من {field} وحاول مرة أخرى.",
  "error.canonical": "تعذّر تفسير هذه القيمة بصورة آمنة. تحقق منها قبل الحفظ.",
  "error.conflict": "تغيّرت هذه القيمة منذ فتح النموذج. راجعها قبل حفظ مسودتك.",
  "error.tokenPayloadMismatch": "تتضمن محاولة الحفظ هذه تغييرًا مختلفًا. راجع مسودتك قبل الحفظ مجددًا.",
  "error.load": "تعذّر تحميل ملفك الشخصي. حاول مرة أخرى.",
  "error.unknown": "تعذّر التأكد من حفظ تغييرك. تحقق من حالته قبل محاولة إجراء تغيير آخر.",
  "error.denied": "لم يعد هذا الملف الشخصي متاحًا.",
  "error.session": "سجّل الدخول مجددًا للمتابعة بأمان.",
  "error.formExpired": "انتهت صلاحية هذا النموذج. أعد تحميل القيمة الحالية قبل الحفظ.",
  "error.security": "تعذّر التحقق من هذا الطلب. افتح النموذج مجددًا وحاول مرة أخرى.",
  "pending.identity_reference": "مرجع الهوية",
  "pending.nationality": "الجنسية",
  "pending.display_name": "الاسم المعروض",
  "pending.arabic_name": "الاسم بالعربية",
  "pending.gender": "الجنس",
  "pending.objective": "الهدف المهني",
  "pending.personal_photo": "الصورة الشخصية",
  "pending.email": "البريد الإلكتروني",
  "pending.phone": "رقم الهاتف",
  "pending.birth_date": "تاريخ الميلاد",
  "pending.civil_id": "البطاقة المدنية",
  "pending.civil_expiry": "انتهاء صلاحية البطاقة المدنية",
  "pending.civil_front": "الوجه الأمامي للبطاقة المدنية",
  "pending.civil_back": "الوجه الخلفي للبطاقة المدنية",
  "pending.driving_licence": "رخصة القيادة",
  "pending.location": "الموقع",
  "pending.kuwaiti_mother": "الأم كويتية",
  "pending.education": "التعليم",
  "pending.skill": "المهارة",
} as const satisfies Record<ProfileCopyKey, string>;

export const PROFILE_COPY = Object.freeze({
  en: Object.freeze(english),
  ar: Object.freeze(arabic),
});

type PlaceholderNames<S extends string> = S extends `${string}{${infer Name}}${infer Rest}`
  ? Name | PlaceholderNames<Rest>
  : never;
export type ProfileCopyParameters<K extends ProfileCopyKey> = Record<
  PlaceholderNames<(typeof english)[K]>, string | number
>;
type CopyArguments<K extends ProfileCopyKey> = [PlaceholderNames<(typeof english)[K]>] extends [never]
  ? []
  : [parameters: ProfileCopyParameters<K>];

/** Only validated locales are accepted, even when called from untyped JavaScript. */
export function directionForProfileLanguage(language: ProfileLanguage): 'ltr' | 'rtl' {
  if (language !== 'en' && language !== 'ar') throw new TypeError('Unsupported profile language');
  return language === 'ar' ? 'rtl' : 'ltr';
}

function interpolate(
  language: ProfileLanguage,
  key: ProfileCopyKey,
  parameters: unknown,
): string {
  directionForProfileLanguage(language);
  if (!Object.hasOwn(english, key)) throw new TypeError('Unknown profile copy key');
  const template: string = PROFILE_COPY[language][key];
  const expected = new Set(Array.from(template.matchAll(/\{([A-Za-z]+)\}/g), (match) => match[1]!));
  const values = parameters === undefined ? {} : parameters;
  if (typeof values !== 'object' || values === null || Array.isArray(values)) {
    throw new TypeError('Profile copy parameters must be an object');
  }
  const keys = Reflect.ownKeys(values);
  if (keys.length !== expected.size || keys.some((name) => typeof name !== 'string' || !expected.has(name))) {
    throw new TypeError('Profile copy parameters do not match the template');
  }
  const checked: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const name of expected) {
    // Never interpolate inherited properties or execute a parameter getter.
    const descriptor = Object.getOwnPropertyDescriptor(values, name);
    const value: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
    if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new TypeError('Profile copy parameters must be strings or finite numbers');
    }
    checked[name] = String(value);
  }
  // A single replacement pass prevents placeholder-looking values from being reinterpreted.
  return template.replace(/\{([A-Za-z]+)\}/g, (_match: string, name: string) => checked[name]!);
}

/** Plain text for primitives that perform their own output escaping. Never insert as raw HTML. */
export function profileCopyText<K extends ProfileCopyKey>(
  language: ProfileLanguage,
  key: K,
  ...args: CopyArguments<K>
): string {
  return interpolate(language, key, args[0]);
}

/** HTML-text-safe message. Interpolate complete translated text, then escape exactly once.
 * This is not a URL validator. A caller supplies bidi isolation and semantic HTML structure.
 */
export function profileCopy<K extends ProfileCopyKey>(
  language: ProfileLanguage,
  key: K,
  ...args: CopyArguments<K>
): string {
  return interpolate(language, key, args[0])
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
