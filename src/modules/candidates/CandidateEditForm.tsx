"use client";

import { useActionState, useEffect } from "react";
import { toast } from "sonner";
import type { ProfileState, EducationState, LanguageState } from "@/modules/candidates/actions";
import {
  updateCandidateProfile,
  uploadDocument,
  addCandidateSkill,
  removeCandidateSkill,
  addCandidateExperience,
  removeCandidateExperience,
  addCandidateCertificate,
  removeCandidateCertificate,
  addCandidateEducation,
  removeCandidateEducation,
  addCandidateLanguage,
  removeCandidateLanguage,
} from "@/modules/candidates/actions";

type Option = { id: number; label: string };
type UuidOption = { id: string; label: string };

type Skill = { id: number; title: string };
type Experience = { id: number; title: string; subtitle: string };
type Certificate = { id: string; title: string; subtitle: string };
type Language = { id: number; title: string; subtitle: string };
type EducationEntry = {
  id: string;
  universityId: number;
  degreeUuid: string | null;
  majorUuid: string | null;
  graduationYear: number | null;
  isCurrentlyStudying: boolean;
  universityLabel: string;
  degreeLabel?: string;
  majorLabel?: string;
};

type Props = {
  candidate: {
    name: string;
    nameAr: string;
    email: string;
    phone: string;
    objective: string;
    intro: string;
    civilId: string;
    profileUrl: string;
    birthDate: string;
    address: string;
    countryId: number | null;
    universityId: number | null;
    bankId: number | null;
    bankAccountName: string;
    iban: string;
    personalPhoto: string | null;
    resume: string | null;
    video: string | null;
    civilPhotoFront: string | null;
    civilPhotoBack: string | null;
  };
  countries: Option[];
  universities: Option[];
  banks: Option[];
  skills: Skill[];
  experiences: Experience[];
  certificates: Certificate[];
  languages: Language[];
  educationEntries: EducationEntry[];
  degrees: UuidOption[];
  majors: UuidOption[];
};

export function CandidateEditForm({ candidate, countries, universities, banks, skills, experiences, certificates, languages, educationEntries, degrees, majors }: Props) {
  const [profileState, profileAction, profilePending] = useActionState(
    updateCandidateProfile,
    { success: false } as ProfileState,
  );

  useEffect(() => {
    if (profileState.success) {
      toast.success("Profile saved", { description: "Your profile has been updated successfully." });
    }
  }, [profileState]);
  const [uploadState, uploadAction, uploadPending] = useActionState(uploadDocument, { error: "" });
  const [, addSkillAction, addSkillPending] = useActionState(addCandidateSkill, { error: "" });
  const [, removeSkillAction, removeSkillPending] = useActionState(removeCandidateSkill, { error: "" });
  const [, addExpAction, addExpPending] = useActionState(addCandidateExperience, { error: "" });
  const [, removeExpAction, removeExpPending] = useActionState(removeCandidateExperience, { error: "" });
  const [certState, addCertAction, addCertPending] = useActionState(addCandidateCertificate, { error: "" });
  const [, removeCertAction, removeCertPending] = useActionState(removeCandidateCertificate, { error: "" });
  const [addEduState, addEduAction, addEduPending] = useActionState(addCandidateEducation, { success: false } as EducationState);
  const [removeEduState, removeEduAction, removeEduPending] = useActionState(removeCandidateEducation, { success: false } as EducationState);
  const [addLangState, addLangAction, addLangPending] = useActionState<LanguageState, FormData>(addCandidateLanguage, { success: false } as LanguageState);
  const [removeLangState, removeLangAction, removeLangPending] = useActionState<LanguageState, FormData>(removeCandidateLanguage, { success: false } as LanguageState);

  useEffect(() => {
    if (addEduState.success) { toast.success("Education added", { description: "Your education entry has been added." }); }
  }, [addEduState]);
  useEffect(() => {
    if (removeEduState.success) { toast.success("Education removed", { description: "The education entry has been removed." }); }
  }, [removeEduState]);
  useEffect(() => {
    if (addLangState.success) { toast.success("Language added", { description: "Your language has been added." }); }
  }, [addLangState]);
  useEffect(() => {
    if (removeLangState.success) { toast.success("Language removed", { description: "The language entry has been removed." }); }
  }, [removeLangState]);

  return (
    <div className="candidateEditLayout">
      <form action={profileAction} className="candidateEditForm">
        <h2>Personal info</h2>
        <label><span>Name (English)</span><input name="name" defaultValue={candidate.name} required /><FieldError errors={profileState.fieldErrors?.name} /></label>
        <label><span>Name (Arabic)</span><input name="nameAr" defaultValue={candidate.nameAr} /><FieldError errors={profileState.fieldErrors?.nameAr} /></label>
        <label><span>Email</span><input name="email" type="email" defaultValue={candidate.email} /><FieldError errors={profileState.fieldErrors?.email} /></label>
        <label><span>Phone</span><input name="phone" type="tel" defaultValue={candidate.phone} /><FieldError errors={profileState.fieldErrors?.phone} /></label>
        <label><span>Birth date</span><input name="birthDate" type="date" defaultValue={candidate.birthDate} /><FieldError errors={profileState.fieldErrors?.birthDate} /></label>
        <h2>Location & education</h2>
        <label><span>Country / Nationality</span><select name="countryId" defaultValue={candidate.countryId ?? ""}><option value="">— Not set —</option>{countries.map((c) => (<option key={c.id} value={c.id}>{c.label}</option>))}</select><FieldError errors={profileState.fieldErrors?.countryId} /></label>
        <label><span>University</span><select name="universityId" defaultValue={candidate.universityId ?? ""}><option value="">— Not set —</option>{universities.map((u) => (<option key={u.id} value={u.id}>{u.label}</option>))}</select><FieldError errors={profileState.fieldErrors?.universityId} /></label>
        <label><span>Address</span><textarea name="address" rows={2} defaultValue={candidate.address} /><FieldError errors={profileState.fieldErrors?.address} /></label>
        <h2>Bank info</h2>
        <label><span>Bank</span><select name="bankId" defaultValue={candidate.bankId ?? ""}><option value="">— Not set —</option>{banks.map((b) => (<option key={b.id} value={b.id}>{b.label}</option>))}</select><FieldError errors={profileState.fieldErrors?.bankId} /></label>
        <label><span>Account holder name</span><input name="bankAccountName" defaultValue={candidate.bankAccountName} /><FieldError errors={profileState.fieldErrors?.bankAccountName} /></label>
        <label><span>IBAN</span><input name="iban" defaultValue={candidate.iban} /><FieldError errors={profileState.fieldErrors?.iban} /></label>
        <h2>Profile details</h2>
        <label><span>Civil ID</span><input name="civilId" defaultValue={candidate.civilId} /><FieldError errors={profileState.fieldErrors?.civilId} /></label>
        <label><span>Objective / Headline</span><input name="objective" defaultValue={candidate.objective} /><FieldError errors={profileState.fieldErrors?.objective} /></label>
        <label><span>Profile URL</span><input name="profileUrl" type="url" defaultValue={candidate.profileUrl} /><FieldError errors={profileState.fieldErrors?.profileUrl} /></label>
        <label><span>About / Intro</span><textarea name="intro" rows={5} defaultValue={candidate.intro} /><FieldError errors={profileState.fieldErrors?.intro} /></label>
        <div className="formActions"><button type="submit" disabled={profilePending}>{profilePending ? "Saving..." : "Save profile"}</button></div>
      </form>

      <form action={uploadAction} className="candidateEditForm">
        <h2>Documents</h2>
        {uploadState.error ? <p className="formError">{uploadState.error}</p> : null}
        <DocumentUpload label="Profile photo" type="photo" current={candidate.personalPhoto} />
        <DocumentUpload label="CV / Resume" type="cv" current={candidate.resume} />
        <DocumentUpload label="Video" type="video" current={candidate.video} />
        <DocumentUpload label="Civil ID (front)" type="civilFront" current={candidate.civilPhotoFront} />
        <DocumentUpload label="Civil ID (back)" type="civilBack" current={candidate.civilPhotoBack} />
        <div className="formActions"><button type="submit" disabled={uploadPending}>{uploadPending ? "Uploading..." : "Upload document"}</button></div>
      </form>

      <form action={addSkillAction} className="candidateEditForm">
        <h2>Skills</h2>
        {skills.length ? (<ul className="editableList">{skills.map((s) => (<li key={s.id}><span>{s.title}</span><button type="submit" form={`remove-skill-${s.id}`} disabled={removeSkillPending} className="removeButton">Remove</button></li>))}</ul>) : (<p className="formNotice">No skills added yet.</p>)}
        <label><span>Add skill</span><input name="skill" placeholder="e.g. Cashier, Barista, Driver..." /></label>
        <div className="formActions"><button type="submit" disabled={addSkillPending}>{addSkillPending ? "Adding..." : "Add skill"}</button></div>
      </form>

      {skills.map((s) => (<form key={s.id} id={`remove-skill-${s.id}`} action={removeSkillAction} hidden><input type="hidden" name="skillId" value={s.id} /></form>))}

      <form action={addExpAction} className="candidateEditForm">
        <h2>Work experience</h2>
        {experiences.length ? (<ul className="editableList">{experiences.map((e) => (<li key={e.id}><span>{e.title}{e.subtitle ? ` at ${e.subtitle}` : ""}</span><button type="submit" form={`remove-exp-${e.id}`} disabled={removeExpPending} className="removeButton">Remove</button></li>))}</ul>) : (<p className="formNotice">No work experience added yet.</p>)}
        <label><span>Job title / Role</span><input name="experience" placeholder="e.g. Sales Associate" required /></label>
        <label><span>Employer / Company</span><input name="employer" placeholder="e.g. Alshaya" /></label>
        <div className="inlineFields"><label><span>Start year</span><input name="startYear" type="number" min="1950" max="2035" /></label><label><span>End year</span><input name="endYear" type="number" min="1950" max="2035" /></label></div>
        <div className="formActions"><button type="submit" disabled={addExpPending}>{addExpPending ? "Adding..." : "Add experience"}</button></div>
      </form>

      {experiences.map((e) => (<form key={e.id} id={`remove-exp-${e.id}`} action={removeExpAction} hidden><input type="hidden" name="experienceId" value={e.id} /></form>))}

      <form action={addCertAction} className="candidateEditForm">
        <h2>Certificates</h2>
        {certificates.length ? (<ul className="editableList">{certificates.map((c) => (<li key={c.id}><span>{c.title}{c.subtitle ? ` — ${c.subtitle}` : ""}</span><button type="submit" form={`remove-cert-${c.id}`} disabled={removeCertPending} className="removeButton">Remove</button></li>))}</ul>) : (<p className="formNotice">No certificates added yet.</p>)}
        <label><span>Certificate type</span><select name="certificate_type" required defaultValue="false"><option value="false">Training Certificate</option><option value="true">Experience Certificate</option></select></label>
        <label><span>Certificate title</span><input name="certificate_title" placeholder="e.g. AWS Cloud Practitioner" required /></label>
        <label><span>Issuer / Organization</span><input name="certificate_issuer" placeholder="e.g. Amazon Web Services" /></label>
        <div className="inlineFields"><label><span>Date obtained</span><input name="start_date" type="date" /></label><label><span>Expiry date</span><input name="end_date" type="date" /></label></div>
        <label><span>Certificate URL</span><input name="certificate_url" type="url" placeholder="https://example.com/cert/123" /></label>
        {certState.error ? <p className="formError">{certState.error}</p> : null}
        <div className="formActions"><button type="submit" disabled={addCertPending}>{addCertPending ? "Adding..." : "Add certificate"}</button></div>
      </form>

      {certificates.map((c) => (<form key={c.id} id={`remove-cert-${c.id}`} action={removeCertAction} hidden><input type="hidden" name="certificateUuid" value={c.id} /></form>))}

      <form action={addLangAction} className="candidateEditForm">
        <h2>Languages</h2>
        {languages.length ? (<ul className="editableList">{languages.map((l) => (<li key={l.id}><span>{l.title} <span className="proficiencyBadge">{l.subtitle}</span></span><button type="submit" form={`remove-lang-${l.id}`} disabled={removeLangPending} className="removeButton">Remove</button></li>))}</ul>) : (<p className="formNotice">No languages added yet.</p>)}
        <label><span>Language</span><select name="language" required defaultValue=""><option value="" disabled>— Select language —</option>{["Arabic","English","French","Spanish","Portuguese","German","Italian","Dutch","Russian","Turkish","Persian","Urdu","Hindi","Bengali","Punjabi","Japanese","Korean","Chinese","Tagalog","Vietnamese","Thai","Malay","Indonesian","Swahili","Amharic","Somali","Greek"].map((lang) => (<option key={lang} value={lang}>{lang}</option>))}</select></label>
        <label><span>Proficiency</span><select name="proficiency" required defaultValue=""><option value="" disabled>— Select level —</option><option value="basic">Basic</option><option value="intermediate">Intermediate</option><option value="advanced">Advanced</option><option value="native">Native</option></select></label>
        {addLangState.error ? <p className="formError">{addLangState.error}</p> : null}
        <div className="formActions"><button type="submit" disabled={addLangPending}>{addLangPending ? "Adding..." : "Add language"}</button></div>
      </form>

      {languages.map((l) => (<form key={l.id} id={`remove-lang-${l.id}`} action={removeLangAction} hidden><input type="hidden" name="languageId" value={l.id} /></form>))}

      <form action={addEduAction} className="candidateEditForm">
        <h2>Education</h2>
        {educationEntries.length ? (<ul className="editableList">{educationEntries.map((e) => (<li key={e.id}><span>{e.universityLabel}{e.degreeLabel ? ` · ${e.degreeLabel}` : ""}{e.majorLabel ? ` · ${e.majorLabel}` : ""}{e.graduationYear ? ` (${e.graduationYear})` : ""}{e.isCurrentlyStudying ? " · Currently studying" : ""}</span><button type="submit" form={`remove-edu-${e.id}`} disabled={removeEduPending} className="removeButton">Remove</button></li>))}</ul>) : (<p className="formNotice">No education entries added yet.</p>)}
        <label><span>University</span><select name="universityId" required defaultValue=""><option value="" disabled>— Select university —</option>{universities.map((u) => (<option key={u.id} value={u.id}>{u.label}</option>))}</select></label>
        <label><span>Degree</span><select name="degreeUuid" defaultValue=""><option value="">— None —</option>{degrees.map((d) => (<option key={d.id} value={d.id}>{d.label}</option>))}</select></label>
        <label><span>Major</span><select name="majorUuid" defaultValue=""><option value="">— None —</option>{majors.map((m) => (<option key={m.id} value={m.id}>{m.label}</option>))}</select></label>
        <div className="inlineFields"><label><span>Graduation year</span><input name="graduationYear" type="number" min="1950" max="2035" /></label><label className="checkboxLabel"><input name="isCurrentlyStudying" type="checkbox" value="1" /><span>Currently studying</span></label></div>
        {addEduState.error ? <p className="formError">{addEduState.error}</p> : null}
        <div className="formActions"><button type="submit" disabled={addEduPending}>{addEduPending ? "Adding..." : "Add education"}</button></div>
      </form>

      {educationEntries.map((e) => (<form key={e.id} id={`remove-edu-${e.id}`} action={removeEduAction} hidden><input type="hidden" name="educationUuid" value={e.id} /></form>))}
    </div>
  );
}

function DocumentUpload({ label, type, current }: { label: string; type: string; current: string | null }) {
  return (<fieldset className="documentUploadField"><legend>{label}</legend><input type="hidden" name="type" value={type} /><input type="file" name={`file_${type}`} accept={acceptFor(type)} />{current ? (<small>Current: <a href={current} target="_blank" rel="noreferrer">{current.split("/").pop()}</a></small>) : (<small>No file uploaded yet.</small>)}</fieldset>);
}
function acceptFor(type: string): string {
  switch (type) { case "photo": case "civilFront": case "civilBack": return "image/*"; case "cv": return ".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"; case "video": return "video/*"; default: return "*/*"; }
}
function FieldError({ errors }: { errors?: string[] }) { return errors?.[0] ? <p className="formError">{errors[0]}</p> : null; }
