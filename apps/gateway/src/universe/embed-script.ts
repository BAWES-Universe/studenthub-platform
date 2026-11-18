/**
 * E2 embed script. Served from /universe/embed/embed.js under `script-src 'self'`
 * (no inline, no eval). Profile values are inserted only with textContent. The
 * host attestation lives only in transient memory, the exact-origin/exact-source
 * message and one POST. Nothing is written to any browser storage.
 */
export const UNIVERSE_EMBED_E2_SCRIPT = String.raw`"use strict";
(function () {
  var body = document.body;
  var data = body.dataset;
  var hosts = (data.hosts || "").split(" ").filter(Boolean);
  var token = data.token || "";
  var lang = document.documentElement.lang === "ar" ? "ar" : "en";
  var T = {
    en: {
      loading: "Checking your StudentHub account…",
      open_in_universe: "Open this in Universe.",
      signed_out: "Sign in to StudentHub to see your profile here.",
      waiting: "Finish signing in in the new tab, then come back to Universe.",
      needs_universe: "Waiting for Universe to confirm who you are…",
      different_account: "You are signed in to StudentHub as a different account than Universe.",
      start_again: "Start again.",
      not_linked: "Your StudentHub account is not linked to your existing StudentHub record yet.",
      linked_data_not_ready: "Your account is linked. Your profile details are not ready yet.",
      unavailable_or_conflict: "Your profile can't be shown right now.",
      populated: "Your profile",
      error: "Something went wrong. Try again in a moment.",
      unavailable: "Not recorded",
      imported: "From your StudentHub record",
      written: "Added by you",
      derived: "Calculated",
      fields: { displayName: "Name", arabicName: "Arabic name", nationality: "Nationality", university: "University", area: "Area", jobSearchStatus: "Job search", isProfileCompleted: "Profile complete" },
      yes: "Yes", no: "No"
    },
    ar: {
      loading: "جارٍ التحقق من حسابك في StudentHub…",
      open_in_universe: "افتح هذه الصفحة داخل Universe.",
      signed_out: "سجّل الدخول إلى StudentHub لرؤية ملفك هنا.",
      waiting: "أكمل تسجيل الدخول في التبويب الجديد ثم عد إلى Universe.",
      needs_universe: "بانتظار تأكيد Universe لهويتك…",
      different_account: "أنت مسجّل الدخول في StudentHub بحساب مختلف عن حسابك في Universe.",
      start_again: "ابدأ من جديد.",
      not_linked: "حسابك في StudentHub غير مرتبط بسجلك الحالي بعد.",
      linked_data_not_ready: "حسابك مرتبط، لكن تفاصيل ملفك ليست جاهزة بعد.",
      unavailable_or_conflict: "لا يمكن عرض ملفك الآن.",
      populated: "ملفك",
      error: "حدث خطأ. حاول مرة أخرى بعد قليل.",
      unavailable: "غير مسجّل",
      imported: "من سجلك في StudentHub",
      written: "أضفته أنت",
      derived: "محسوب",
      fields: { displayName: "الاسم", arabicName: "الاسم بالعربية", nationality: "الجنسية", university: "الجامعة", area: "المنطقة", jobSearchStatus: "البحث عن عمل", isProfileCompleted: "اكتمال الملف" },
      yes: "نعم", no: "لا"
    }
  };
  var text = T[lang];
  var statusEl = document.getElementById("status");
  var profileEl = document.getElementById("profile");
  var connect = document.getElementById("connect");
  var signout = document.getElementById("signout");
  var link = document.getElementById("link");
  var full = document.getElementById("full");
  var generation = 0;
  var pending = null;
  var renewTimer = null;
  var pendingTimer = null;
  // Monotonic deadline (performance.now) after which rendered profile data must be gone.
  var leaseDeadline = 0;
  // A sign-in started in the other tab; kept apart from the visible state, which a
  // visibility change resets, so the waiting message and its quick poll come back.
  var signingIn = false;
  // Status replies can overlap (the 3 s poll during sign-in): only the newest one counts.
  var statusSeq = 0;

  function clearProfile() {
    while (profileEl.firstChild) profileEl.removeChild(profileEl.firstChild);
    profileEl.hidden = true;
  }
  function show(state) {
    statusEl.textContent = text[state] || text.error;
    body.setAttribute("data-state", state);
    // While waiting, the sign-in stays offered: a closed sign-in tab can be retried
    // (a new start supersedes the old handoff).
    connect.hidden = !(state === "signed_out" || state === "waiting");
    signout.hidden = !(state === "different_account" || state === "start_again");
    link.hidden = state !== "not_linked";
    full.hidden = state !== "open_in_universe";
  }
  function stopTimers() {
    if (renewTimer) { clearTimeout(renewTimer); renewTimer = null; }
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    leaseDeadline = 0;
    pending = null;
  }
  function leaseLive() { return leaseDeadline > 0 && performance.now() < leaseDeadline; }
  // Lease deadline or renewal: rendered data goes first, then verification restarts.
  // A new generation, so replies to requests started under the old lease are ignored.
  function expireLease(g) {
    if (g !== generation) return;
    generation += 1;
    if (renewTimer) { clearTimeout(renewTimer); renewTimer = null; }
    leaseDeadline = 0;
    clearProfile();
    show("needs_universe");
    verify(generation);
  }
  // Synchronous clear: runs inside pagehide / hidden visibilitychange handlers.
  function hideAll() {
    generation += 1;
    stopTimers();
    clearProfile();
    show("loading");
  }
  if (window.parent === window) { clearProfile(); show("open_in_universe"); return; }

  function call(method, path, payload) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 5000);
    var headers = { "x-studenthub-embed": token };
    if (payload) headers["content-type"] = "application/json";
    return fetch(path, {
      method: method, credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: headers, body: payload ? JSON.stringify(payload) : undefined, signal: controller.signal
    }).then(function (response) {
      if (!response.ok) throw new Error("status " + response.status);
      return response.json();
    }).finally(function () { clearTimeout(timer); });
  }
  function fail(g) { if (g === generation) { stopTimers(); clearProfile(); show("error"); } }

  function render(fields) {
    clearProfile();
    var list = document.createElement("dl");
    fields.forEach(function (field) {
      var label = text.fields[field.key];
      if (!label) return;
      var dt = document.createElement("dt");
      dt.textContent = label;
      var dd = document.createElement("dd");
      var value = field.value;
      dd.textContent = value === null ? text.unavailable : value === true ? text.yes : value === false ? text.no : String(value);
      var mark = document.createElement("small");
      mark.textContent = field.source === "imported_snapshot" ? text.imported : field.source === "written_by_person" ? text.written : field.source === "derived" ? text.derived : "";
      if (mark.textContent) { dd.appendChild(document.createTextNode(" ")); dd.appendChild(mark); }
      list.appendChild(dt);
      list.appendChild(dd);
    });
    profileEl.appendChild(list);
    profileEl.hidden = false;
  }

  function loadProfile(g) {
    call("GET", "/universe/embed/profile").then(function (reply) {
      if (g !== generation) return;
      if (reply.state === "populated" && !leaseLive()) { expireLease(g); return; }
      // Never insert profile fields into a hidden document; becoming visible re-checks.
      if (document.visibilityState !== "visible") { clearProfile(); return; }
      if (reply.state === "populated" && Array.isArray(reply.fields)) render(reply.fields); else clearProfile();
      show(reply.state);
    }).catch(function () { fail(g); });
  }

  function verify(g) {
    call("POST", "/universe/embed/challenge", {}).then(function (reply) {
      if (g !== generation) return;
      if (typeof reply.challenge !== "string") { clearProfile(); show(reply.state || "error"); return; }
      pending = { challenge: reply.challenge, generation: g };
      hosts.forEach(function (origin) {
        window.parent.postMessage({ type: "studenthub.embed.identity-request", v: 1, challenge: reply.challenge }, origin);
      });
      // Two status replies can each start a challenge in one generation: the older
      // challenge's timer must not clear the newer pending one.
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = setTimeout(function () {
        if (pending && pending.generation === g) { pending = null; clearProfile(); show("needs_universe"); }
      }, 5000);
    }).catch(function () { fail(g); });
  }

  window.addEventListener("message", function (event) {
    if (hosts.indexOf(event.origin) < 0 || event.source !== window.parent) return;
    var message = event.data;
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    if (Object.keys(message).sort().join(",") !== "attestation,type,v") return;
    if (message.type !== "studenthub.embed.identity" || message.v !== 1 || typeof message.attestation !== "string") return;
    if (!pending || pending.generation !== generation) return;
    var g = pending.generation;
    pending = null;
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
    var sentAt = performance.now();
    call("POST", "/universe/embed/identity", { attestation: message.attestation }).then(function (reply) {
      if (g !== generation) return;
      if (reply.state === "ready" && typeof reply.leaseSeconds === "number" && reply.leaseSeconds > 0) {
        // Measured from the send time, so the client deadline is never later than the server lease.
        var lease = Math.min(reply.leaseSeconds, 600) * 1000;
        var renewIn = typeof reply.renewAfterSeconds === "number" ? reply.renewAfterSeconds * 1000 : 0;
        leaseDeadline = sentAt + lease;
        var left = leaseDeadline - performance.now();
        if (left <= 0) { expireLease(g); return; }
        // This lease starts a new generation: earlier status and profile replies are ignored.
        generation += 1;
        g = generation;
        if (renewTimer) clearTimeout(renewTimer);
        // One timer: renewal, never later than the deadline; renewal clears the profile first.
        renewTimer = setTimeout(function () { expireLease(g); }, Math.max(0, Math.min(renewIn - (performance.now() - sentAt), left)));
        loadProfile(g);
      } else if (reply.state === "ready") { fail(g);
      } else { stopTimers(); clearProfile(); show(reply.state); }
    }).catch(function () { fail(g); });
  });

  function revalidate() {
    var g = generation;
    var s = ++statusSeq;
    call("GET", "/universe/embed/status").then(function (reply) {
      if (g !== generation || s !== statusSeq) return;
      // Sign-in still in progress in the other tab: keep (or restore) the waiting message.
      if (reply.state === "signed_out" && signingIn) { show("waiting"); return; }
      signingIn = false;
      if (reply.state === "ready") {
        if (!leaseLive()) { expireLease(g); return; }
        if (profileEl.hidden) loadProfile(g);
        return;
      }
      stopTimers();
      clearProfile();
      if (reply.state === "needs_universe") { show("needs_universe"); verify(g); return; }
      show(reply.state);
    }).catch(function () { if (s === statusSeq) fail(g); });
  }

  connect.addEventListener("submit", function () { signingIn = true; show("waiting"); });
  signout.addEventListener("click", function () {
    hideAll();
    signingIn = false;
    var g = generation;
    call("POST", "/logout", {}).then(function () { if (g === generation) show("signed_out"); }).catch(function () { fail(g); });
  });
  window.addEventListener("pagehide", hideAll);
  window.addEventListener("pageshow", function (event) { if (event.persisted) { hideAll(); revalidate(); } });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") hideAll(); else { hideAll(); revalidate(); }
  });
  // While visible, re-check at least every 60 seconds; failure leaves content cleared.
  // Each tick also enforces the lease deadline, in case a timer was delayed.
  setInterval(function () {
    if (!profileEl.hidden && !leaseLive()) expireLease(generation);
    if (document.visibilityState === "visible") revalidate();
  }, 60000);
  // While waiting for the sign-in tab, notice the completed handoff promptly.
  setInterval(function () {
    if (document.visibilityState === "visible" && signingIn) revalidate();
  }, 3000);
  show("loading");
  // A frame that loads in a background tab waits for the visible transition.
  if (document.visibilityState === "visible") revalidate();
})();
`;
