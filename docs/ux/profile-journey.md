# My profile: one person, a useful first impression

Status: **proposed design and acceptance contract; not implemented or UX accepted**. Authored by GPT, 2 November 2026. Source baseline: `studenthub-platform@d56843401d6ad77fc92ad77d81d32f82605d7b17`. This document does not identify which legacy client is deployed. Pair with [kit-spec.md](kit-spec.md) and [profile-contract-pack.md](profile-contract-pack.md). Documentation approval is not permission to implement, merge, deploy, or start autonomous work.

## 1. Evidence and boundaries

**Verified source facts.** The gateway renders server-side HTML, not a React app. `/profile` already edits nine fields through preview → confirm → redirect. Language has a separate preview flow. The screen currently mixes an imported-data presentation, inline editors, repeated work-status information, and contradictory read-only copy. Invalid-value forms retain their value, but generic failure pages do not provide complete recovery. A successful form confirmation redirects without an explicit saved notice. These are repairable journey defects, not grounds for replacing the stack. [Renderer](https://github.com/BAWES-Universe/studenthub-platform/blob/d56843401d6ad77fc92ad77d81d32f82605d7b17/apps/gateway/src/web-ui.ts), [edit handler](https://github.com/BAWES-Universe/studenthub-platform/blob/d56843401d6ad77fc92ad77d81d32f82605d7b17/apps/gateway/src/profile-edit-http.ts).

Legacy mobile demonstrates grouped personal/contact information, focused editing, and direction-aware markup. Reuse that clarity, not its candidate-only identity or every historical feature. [Legacy personal information, pinned](https://github.com/BAWES-Universe/studenthub-candidate/blob/de3ac8c8177d0a4c127f2668cb938adbff2755b4/src/app/pages/logged-in/personal-info/personal-info.page.html). The [parity inventory](https://github.com/BAWES-Universe/studenthub-platform/blob/d56843401d6ad77fc92ad77d81d32f82605d7b17/docs/parity/ui-journeys.md) is historical evidence, not automatic approval to restore its navigation.

**Product direction.** A person has one profile; recruiter/staff/employer grants select workspaces, never a second identity or permission to edit somebody else's profile here. Looking for work is a personal preference, not an account role or hiring eligibility. No applications, interviews, chat, tickets, wallets, perks, assessments, or other retired features appear. No profile score, job-matching promise, public visibility promise, or invented photo upload.

## 2. Exact field inventory and disposition

The table preserves all 19 projected fields; regrouping is presentation, not a schema/permission change. Identifiers are engineering names, never untranslated UI labels. [Projection and mappings](https://github.com/BAWES-Universe/studenthub-platform/blob/d56843401d6ad77fc92ad77d81d32f82605d7b17/packages/profile/src/profile.ts), [types](https://github.com/BAWES-Universe/studenthub-platform/blob/d56843401d6ad77fc92ad77d81d32f82605d7b17/packages/profile/src/types.ts), [write rules](https://github.com/BAWES-Universe/studenthub-platform/blob/d56843401d6ad77fc92ad77d81d32f82605d7b17/packages/profile/src/self-edit.ts).

| Field → approved source | Current constraint | Proposed placement |
|---|---|---|
| `displayName` → `candidate_name` | Editable, required, 255 Unicode code points; name rules below | Identity heading; Personal details editor |
| `arabicName` → `candidate_name_ar` | Editable, clearable, 255; Arabic-letter/name rules | Personal details |
| `gender` → `candidate_gender` | Editable `male/female/other` | Personal details |
| `birthDate` → `candidate_birth_date` | Editable actual ISO date; minimum 16, Kuwait date; no write maximum age | Personal details |
| `age` → same birth date | Derived, never independently editable; derived age becomes unavailable after an owned birth-date write if >150 | Personal details, subordinate to birth date |
| `nationality` → country nationality display value | Read only at baseline | Personal details |
| `university` → university display value | Read only at baseline | Education and experience link context |
| `objective` → `candidate_objective` | Editable, clearable, 100 | About my work, concise lead |
| `intro` → `candidate_intro` | Editable, clearable, 5,000 | About my work, full readable text |
| `preferredTime` → `candidate_preferred_time` | Editable, clearable, 100; preferred **working** time, not contact time | About my work |
| `language` → `candidate_language_pref` + owned preference | `en/ar`; separate preview/confirm contract | Header language control |
| `area` → area display value | Read only; no coordinates | Personal details |
| `drivingLicence` → `candidate_driving_license` | Editable boolean | Personal details |
| `jobSearchStatus` → `candidate_job_search_status` | Editable `not_looking/active/open_to_offers` | Single status in identity summary |
| `committed` → `candidate_committed` | Imported boolean, not a new commitment action | More profile details |
| `isProfileCompleted` → inverse incomplete marker | Imported only; unavailable after owned preference overlays | More profile details; no live progress meter |
| `pendingFields` → `candidate_pending_profile` | Closed requirement names only; unavailable after overlays | More profile details, historical labels only |
| `employeeIdentifier` → `candidate_id` | Display-only C-prefixed identifier | More profile details; no role inference |
| `civilExpired` → expiry-date comparison | Boolean only; excludes number and date | More profile details; no eligibility inference |

Current name validation requires two or more letter-based name parts separated by one normal space; permits supported internal apostrophe/hyphen/full stop; Arabic name additionally needs an Arabic letter. Current text writes normalize NFC but reject leading/trailing whitespace, repeated whitespace and prohibited control/directional characters. **Current introduction cannot accept line breaks.** Do not silently flatten paragraphs or truncate text. Show these limitations honestly until a separately reviewed field contract changes them. A clear stores missing/not-recorded, not an empty invented value. Distinguish unavailable import data from a deliberately cleared field. Birth-date write policy has no maximum age; the read-derived age ceiling is a known discrepancy, not authority to invent a maximum-age validation. In the owned birth-date overlay, a derivation failure is caught and `age` becomes unavailable while `birthDate` remains available; do not present it as a failed save or whole-profile failure.

**Later, not part of this screen's available controls:** phone/profile link, nationality/university writes, Kuwaiti-mother status, and location catalogue editing need their landed contracts and permission checks. Phone, email, profile URL and Kuwaiti-mother value are absent from this projection. Pending requirement names mentioning them do not expose their values. Education/experience and record capabilities are separate journeys; retain the existing `/profile/background` navigation, not a speculative inline records editor or an API link. Civil ID numbers, bank data, document locations, secrets and internal notes remain excluded. Do not show disabled promotional cards for unavailable future features.

## 3. Anatomy: a profile, not a database inspection page

**Proposed visual hierarchy.** Use the existing brand and the small kit, with one calm reading surface, generous section spacing, strong name typography and a restrained accent. No charts or tile grid. Keep provenance available as secondary details, not a timestamp under every primary value.

1. Compact header: brand, language, Sign out. Main navigation: My profile (current), Education and experience; Workspaces only where existing navigation permits it.
2. `profile-heading`: My profile. `profile-summary`: name (or neutral fallback), Arabic name if present, objective if present, **one** Looking for work status and its accessible Edit action. An initial monogram is decorative, not an upload affordance. Never call the person a candidate/student because of imported storage names.
3. Wrapping section links to `section-work`, `section-personal`, `section-background`, `section-details`. About my work leads: objective, introduction, preferred working time. Personal details uses paired labels/values. Every editable field gets a precise accessible Edit {field} name; a section must not imply a multi-field Save.
4. Education and experience: current university if approved and a real link to the existing journey. No invented counts, CV or certificates.
5. More profile details: native disclosure, all supplementary projected fields and per-field provenance accessible inside. Explain historical completeness without a stale completion checklist. Missing values remain explicit. Privacy text states the data excluded, not who else can see the profile.

At **320 px**, use 16 px outer gutters, one reading column, wrapping names and status, stacked label/value/action when needed, no horizontal tabs or clipped controls. At **390 px**, retain one column; header actions may wrap, section links remain fully reachable. At **desktop (1,280 px test)** use a restrained navigation rail and maximum ~960 px content width; long introduction remains a readable ~65-character measure. Personal details may use two columns, but DOM reading order stays logical. No essential side panel disappears on mobile. Edit replaces the relevant reading region with a dedicated one-field page; no cramped modal or nested scroll area.

Use 44 px minimum primary touch targets, visible focus and non-color status indicators. Native labels, fieldsets/legends for radio groups, headings and landmarks are mandatory. Error summary links to the invalid input; `aria-describedby` associates help/error. Save progress and success use polite announcements; invalid/conflict alerts are announced once. Keep focus unobscured by the keyboard or action area. Expand text at 200% and test reflow at 320 CSS px; no fixed-height Arabic labels. IDs shared with the kit: `profile-edit-heading`, `profile-edit-form`, `profile-error-summary`, `profile-notice`, `field-{allowlisted-key}`, `field-{key}-hint`, `field-{key}-error`.

## 4. Complete one-field journey

**View → edit.** Authorized server read establishes the current person and allowed field. The proposed new edit route is `GET /profile/edit/:field`, with save at `POST /profile/edit/:field/save` (neither is claimed to exist at the baseline), with Back to my profile, field label, current value, concise constraints and Save/Cancel. The form-render token binds purpose/version, actor, target, field set and displayed baseline. Do not issue a token for a client-supplied arbitrary field. No JS-only access or extra role selector.

**Edit → save.** First slice saves exactly one field. Save submits token, value and payload-bound idempotency key using the new browser-write contract; no review screen for these ordinary fields. Existing preview/confirm callers remain unchanged. Language remains its separate current contract until explicitly migrated: Review change → Confirm change, with translated copy. Saving one field cannot update other fields or imply an all-profile transaction.

**Save → confirmed result.** Reauthorize, check origin/CSRF, canonicalize per field and perform atomic write/audit/token-consumption/receipt. Follow POST with a safe GET. Announce “Saved {field}: {value}” with the actual stored value (Not recorded for an allowed clear), update the reading view and restore focus to the changed field/notice. Long values remain fully available below; announcement may use a disclosed shortened preview but cannot hide a changed stored value. Do not display “Saved” on request dispatch.

**Drafts and navigation.** First slice preserves the submitted value by native POST re-render on authorized validation, conflict and known failure responses where possible. Keep the displayed baseline and draft distinct; reauthorize before returning either. Unknown-outcome recovery uses the same operation key/payload and receipt, not a durable draft service. Never put personal content or tokens in URLs, localStorage, logs or analytics. No durable or cross-login recovery is promised.

A bounded same-origin progressive enhancement may warn on dirty Back, section navigation or language change with Keep editing / Discard changes; native forms remain usable without it. Cancel is an explicit discard action; make this clear beside the action, and return immediately when clean. Browser Back/Forward must never replay a POST or auto-save. Restored DOM content is untrusted: reauthorize and refresh the baseline before Save; show a conflict if changed. Browser-native unload prompts may be browser-translated and cannot guarantee recovery. Logout clears any in-memory draft; expired sessions and revoked access never echo protected drafts. If a draft cannot be recovered after sign-in or navigation, say so and request re-entry rather than pretending it was retained. A short-lived server-side draft service or cross-login restoration is optional later work requiring separate scope, not a U1–U3 prerequisite.

**Unknown result.** A timeout is not proof of failure. Where the authorized form/request state remains available, keep the same key/payload for Check save status; reauthorize then look up receipt **before** testing stale baseline. Return original committed receipt even if the profile subsequently changed; show original saved value as receipt history, current value separately if needed. Never automatically submit a modified draft under the old key. A different payload with the same key is a conflict. Full invariants and named tests live in the contract pack.

## 5. Six required states and recovery

| State | What the person sees / can do | Safety and focus |
|---|---|---|
| Ready | Current profile or valid editor; Save and Cancel | Focus heading on navigation; normal keyboard order |
| Empty | Not recorded for known absence; Add {field} only if editable | No fabricated value, default gender or inferred work status; focus edit heading on Add |
| Invalid | Correct this field summary + precise field error; original draft retained | No write; focus summary, link to input; fix then Save |
| Conflict | Profile changed; authorized Current value and Your draft side by side; Review current value / Keep editing | No force overwrite. Fresh token/baseline and explicit new Save after review; key-payload conflict requires a new deliberate attempt |
| Unavailable | Read failure: Profile unavailable / Try again. Unknown write: Save not confirmed / Check save status | Do not assert no change after unknown commit. Re-render the authorized submitted draft where possible; revoked access is generic, no current values or draft echo |
| Expired session | Session expired / Sign in to continue | Hide protected content; reauthenticate and authorize before returning any receipt. If no approved draft recovery exists, explain the loss and request re-entry. Different person gets no draft. Expired form token with valid session refreshes form/baseline, not an unnecessary login |

The latter token-expiry case uses the Form expired copy and still requires draft/baseline reconciliation. Capability absence is per-field read-only, not a false global claim that editing is unavailable. Imported/not-recorded values remain distinguishable even inside an otherwise ready screen.

## 6. Arabic and complete journey copy

**Scope:** Arabic for this profile journey and its local navigation/recovery strings, not a claim the whole site is translated. Set `lang="ar" dir="rtl"` for Arabic profile pages; `lang="en" dir="ltr"` for English. Existing English downstream pages retain their real language/direction. Use logical CSS; mirror directional navigation arrows, not logos/checkmarks. Render person-entered values in `bdi dir="auto"`; isolate future email/URL/phone values with LTR semantics without reversing digits or the plus sign. Dates display with locale formatting but retain unambiguous ISO submission; schema enum codes never become translated payloads. Translate controlled values, not proper names/imported free text. Explicitly mark English proper data where useful; do not classify it as an untranslated UI string.

Below is the **closed copy inventory** for the proposed journey. `{field}`, `{value}`, `{limit}`, `{date}` and `{count}` are escaped runtime substitutions, isolated for direction; `{field}` is a translated label. Do not concatenate English errors. New strings added in implementation must add both locales and tests. “L” means exact reused legacy value verified in [ar.json at de3ac8c8](https://github.com/BAWES-Universe/studenthub-candidate/blob/de3ac8c8177d0a4c127f2668cb938adbff2755b4/src/assets/i18n/ar.json); all others are newly authored **proposed Arabic awaiting cross-family review**. In particular legacy Objective → موضوعي is not reused. No machine translation of arbitrary server diagnostics.

| Key | English | العربية | Origin |
|---|---|---|---|
| nav.profile | My profile | ملفي الشخصي | New |
| nav.background | Education and experience | التعليم والخبرة | New |
| nav.workspaces | Workspaces | مساحات العمل | New |
| nav.main | Main navigation | التنقل الرئيسي | New |
| nav.sections | Profile sections | أقسام الملف الشخصي | New |
| nav.skip | Skip to content | الانتقال إلى المحتوى | New |
| nav.back | Back to my profile | العودة إلى ملفي الشخصي | New |
| action.signOut | Sign out | تسجيل الخروج | New |
| action.signIn | Sign in to continue | سجّل الدخول للمتابعة | New |
| action.edit | Edit | تعديل | L |
| action.editField | Edit {field} | تعديل {field} | New |
| action.addField | Add {field} | إضافة {field} | New |
| action.save | Save | حفظ | L |
| action.cancel | Cancel | إلغاء | L |
| action.keep | Keep editing | متابعة التعديل | New |
| action.discard | Discard changes | تجاهل التغييرات | New |
| action.retry | Try again | المحاولة مرة أخرى | New |
| action.check | Check save status | التحقق من حالة الحفظ | New |
| action.current | Review current value | مراجعة القيمة الحالية | New |
| action.review | Review change | مراجعة التغيير | New |
| action.confirm | Confirm change | تأكيد التغيير | New |
| action.background | Open education and experience | فتح التعليم والخبرة | New |
| title.edit | Edit {field} | تعديل {field} | New |
| title.review | Review profile change | مراجعة تغيير الملف الشخصي | New |
| title.fallback | Your StudentHub profile | ملفك الشخصي في StudentHub | New |
| section.work | About my work | نبذة عن عملي | New |
| section.personal | Personal details | البيانات الشخصية | New |
| section.background | Education and experience | التعليم والخبرة | New |
| section.details | More profile details | تفاصيل إضافية عن الملف الشخصي | New |
| field.displayName | Display name | الاسم المعروض | New |
| field.arabicName | Arabic name | الاسم بالعربية | New |
| field.gender | Gender | الجنس | New |
| field.birthDate | Birth date | تاريخ الميلاد | New |
| field.age | Age | العمر | New |
| field.nationality | Nationality | الجنسية | L |
| field.university | University | الجامعة | New |
| field.objective | Objective | الهدف المهني | New |
| field.intro | Introduction | نبذة تعريفية | New |
| field.preferredTime | Preferred time | الوقت المفضل | L |
| field.language | Language | اللغة | New |
| field.area | Area | المنطقة | New |
| field.drivingLicence | Driving licence | رخصة القيادة | New |
| field.jobSearchStatus | Looking for work | البحث عن عمل | New |
| field.committed | Commitment marker | مؤشر الالتزام | New |
| field.isProfileCompleted | Imported profile completeness | اكتمال الملف الشخصي عند الاستيراد | New |
| field.pendingFields | Imported profile requirements | متطلبات الملف الشخصي المستوردة | New |
| field.employeeIdentifier | Employee identifier | الرقم التعريفي للموظف | New |
| field.civilExpired | Civil ID expired | البطاقة المدنية منتهية الصلاحية | New |
| value.yes | Yes | نعم | L |
| value.no | No | لا | L |
| value.male | Male | ذكر | New |
| value.female | Female | أنثى | New |
| value.other | Other | آخر | New |
| value.notLooking | Not looking right now | لا أبحث عن عمل حاليًا | New |
| value.active | Actively looking for work | أبحث عن عمل بجدية | New |
| value.open | Open to offers | منفتح على عروض العمل | New |
| value.english | English | الإنجليزية | New |
| value.arabic | Arabic | العربية | New |
| value.missing | Not recorded | غير مسجل | New |
| value.unavailable | Unavailable | غير متاح | New |
| value.complete | Complete | مكتمل | New |
| value.incomplete | Incomplete | غير مكتمل | New |
| value.none | None | لا يوجد | New |
| meta.imported | Imported on {date} | تم الاستيراد في {date} | New |
| meta.updated | Updated by you on {date} | حدّثته في {date} | New |
| meta.notImported | Not imported | لم يتم الاستيراد | New |
| meta.historical | These imported indicators do not describe your latest edits. | هذه المؤشرات المستوردة لا تعكس أحدث تعديلاتك. | New |
| meta.readOnly | This detail cannot be edited here yet. | لا يمكن تعديل هذه المعلومة هنا بعد. | New |
| help.privacy | This page excludes documents, civil ID numbers, bank details and internal notes. | لا تتضمن هذه الصفحة المستندات أو أرقام البطاقات المدنية أو البيانات البنكية أو الملاحظات الداخلية. | New |
| help.preferredTime | Your preferred working time. | الوقت الذي تفضله للعمل. | New |
| help.name | Enter at least two name parts, separated by single spaces. | أدخل اسمًا مكوّنًا من جزأين على الأقل، مع مسافة واحدة بين الأجزاء. | New |
| help.arabicName | Use Arabic letters in your name. You can leave this blank. | استخدم أحرفًا عربية في اسمك. يمكنك ترك هذا الحقل فارغًا. | New |
| help.optional | Optional. Leave blank to remove this value. | اختياري. اترك الحقل فارغًا لإزالة هذه القيمة. | New |
| help.limit | Maximum {limit} characters. | الحد الأقصى {limit} حرفًا. | New |
| help.text | No spaces at the start or end, repeated spaces, or line breaks. | لا تستخدم مسافات في البداية أو النهاية، أو مسافات متكررة، أو فواصل أسطر. | New |
| help.chooseStatus | Choose your current work-search status. | اختر حالتك الحالية في البحث عن عمل. | New |
| help.date | Enter your birth date as a calendar date. | أدخل تاريخ ميلادك كتاريخ تقويمي. | New |
| help.birth | You must be at least 16. | يجب ألا يقل عمرك عن 16 عامًا. | New |
| help.language | Other journeys may still be in English. | قد تظل الصفحات الأخرى باللغة الإنجليزية. | New |
| state.ready | Ready | جاهز | New |
| state.empty | Not recorded | غير مسجل | New |
| state.invalid | Correct this field | صحّح هذا الحقل | New |
| state.conflict | Profile changed | تغيّر الملف الشخصي | New |
| state.unavailable | Profile unavailable | الملف الشخصي غير متاح | New |
| state.expired | Session expired | انتهت الجلسة | New |
| status.saving | Saving… | جارٍ الحفظ… | New |
| status.saved | Saved {field}: {value} | تم حفظ {field}: {value} | New |
| status.cleared | Saved {field}: Not recorded | تم حفظ {field}: غير مسجل | New |
| status.unknown | Save not confirmed | لم يتم تأكيد الحفظ | New |
| status.checking | Checking save status… | جارٍ التحقق من حالة الحفظ… | New |
| status.receipt | Earlier save confirmed: {value} | تم تأكيد الحفظ السابق: {value} | New |
| draft.title | Unsaved changes | تغييرات غير محفوظة | New |
| draft.cancelHelp | Cancel discards this unsaved change. | يؤدي الإلغاء إلى تجاهل هذا التغيير غير المحفوظ. | New |
| draft.leave | Leave without saving this change? | هل تريد المغادرة دون حفظ هذا التغيير؟ | New |
| draft.current | Current value | القيمة الحالية | New |
| draft.yours | Your draft | مسودتك | New |
| draft.restored | Your unsaved draft is ready to review. | مسودتك غير المحفوظة جاهزة للمراجعة. | New |
| draft.expired | Your unsaved draft is no longer available. Enter your change again. | لم تعد مسودتك غير المحفوظة متاحة. أدخل التغيير مرة أخرى. | New |
| error.required | Enter {field}. | أدخل {field}. | New |
| error.choice | Choose one of the available options. | اختر أحد الخيارات المتاحة. | New |
| error.length | Use no more than {limit} characters. | استخدم {limit} حرفًا كحد أقصى. | New |
| error.name | Use at least two letter-based name parts with single spaces; check punctuation. | استخدم جزأين على الأقل من الاسم مكوّنين من أحرف، مع مسافة واحدة بينهما، وتحقق من علامات الترقيم. | New |
| error.arabicName | Enter a name containing Arabic letters. | أدخل اسمًا يحتوي على أحرف عربية. | New |
| error.spacing | Remove extra spaces at the start or end and repeated spaces. | أزل المسافات الزائدة في البداية أو النهاية والمسافات المتكررة. | New |
| error.characters | Remove line breaks and unsupported control characters. | أزل فواصل الأسطر ومحارف التحكم غير المدعومة. | New |
| error.date | Enter a valid calendar date. | أدخل تاريخًا صحيحًا. | New |
| error.future | Birth date cannot be in the future. | لا يمكن أن يكون تاريخ الميلاد في المستقبل. | New |
| error.minimumAge | You must be at least 16 to complete a StudentHub profile. | يجب ألا يقل عمرك عن 16 عامًا لإكمال ملف شخصي في StudentHub. | New |
| error.invalid | Check {field} and try again. | تحقق من {field} وحاول مرة أخرى. | New |
| error.canonical | We could not safely interpret this value. Check it before saving. | تعذّر تفسير هذه القيمة بصورة آمنة. تحقق منها قبل الحفظ. | New |
| error.conflict | This value changed since you opened the form. Review it before saving your draft. | تغيّرت هذه القيمة منذ فتح النموذج. راجعها قبل حفظ مسودتك. | New |
| error.keyConflict | This save attempt contains a different change. Review your draft before saving again. | تتضمن محاولة الحفظ هذه تغييرًا مختلفًا. راجع مسودتك قبل الحفظ مجددًا. | New |
| error.load | We could not load your profile. Try again. | تعذّر تحميل ملفك الشخصي. حاول مرة أخرى. | New |
| error.unknown | We could not confirm whether your change was saved. Check its status before trying another change. | تعذّر التأكد من حفظ تغييرك. تحقق من حالته قبل محاولة إجراء تغيير آخر. | New |
| error.denied | This profile is no longer available. | لم يعد هذا الملف الشخصي متاحًا. | New |
| error.session | Sign in again to continue safely. | سجّل الدخول مجددًا للمتابعة بأمان. | New |
| error.formExpired | This form expired. Reload the current value before saving. | انتهت صلاحية هذا النموذج. أعد تحميل القيمة الحالية قبل الحفظ. | New |
| error.security | We could not verify this request. Reopen the form and try again. | تعذّر التحقق من هذا الطلب. افتح النموذج مجددًا وحاول مرة أخرى. | New |
| pending.identity_reference | Identity reference | مرجع الهوية | New |
| pending.nationality | Nationality | الجنسية | L |
| pending.display_name | Display name | الاسم المعروض | New |
| pending.arabic_name | Arabic name | الاسم بالعربية | New |
| pending.gender | Gender | الجنس | New |
| pending.objective | Objective | الهدف المهني | New |
| pending.personal_photo | Personal photo | الصورة الشخصية | New |
| pending.email | Email | البريد الإلكتروني | New |
| pending.phone | Phone number | رقم الهاتف | New |
| pending.birth_date | Birth date | تاريخ الميلاد | New |
| pending.civil_id | Civil ID | البطاقة المدنية | New |
| pending.civil_expiry | Civil ID expiry | انتهاء صلاحية البطاقة المدنية | New |
| pending.civil_front | Civil ID front | الوجه الأمامي للبطاقة المدنية | New |
| pending.civil_back | Civil ID back | الوجه الخلفي للبطاقة المدنية | New |
| pending.driving_licence | Driving licence | رخصة القيادة | New |
| pending.location | Location | الموقع | New |
| pending.kuwaiti_mother | Kuwaiti mother | الأم كويتية | New |
| pending.education | Education | التعليم | New |
| pending.skill | Skill | المهارة | New |

Pending requirement labels above describe approved historical metadata only; they are not links, new fields or upload prompts. State labels can be test/assistive labels rather than visible badges on every screen. Brand names and user content are not translated; schema identifiers, token material and internal errors are never shown.

## 7. Acceptance boundary and unresolved work

The browser script in the contract pack must exercise view → edit → Save → stored result, validation → correction, Cancel, dirty navigation, Back/Forward, receipt recovery and all six states at 320/390/desktop in both locales; keyboard focus and mixed-direction content are mandatory. Evidence names exact candidate SHA, browser, viewport, locale, result and screenshots. An automated reviewer runs it, not Khalid. Rendered-HTML checks alone mean **landed, not UX accepted**.

Open gates: U2a new write contract; reconciliation of existing PR #237 before U2b; same-operation receipt recovery; optional later cross-login draft restoration; language-flow migration decision; read-derived age ceiling discrepancy; Arabic cross-family review; actual browser evidence. This document neither changes those contracts nor certifies them. Source inspection was read-only; no application tests or browser runs were performed for this document.
