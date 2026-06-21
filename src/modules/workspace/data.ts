import { prisma } from "@/lib/prisma";
import { formatDate, formatMoney } from "@/modules/workspace/format";

export async function getAdminCandidateRows() {
  const rows = await prisma.candidate.findMany({
    where: { deleted: 0 },
    orderBy: { candidate_updated_at: "desc" },
    take: 60,
    select: {
      candidate_id: true,
      candidate_name: true,
      candidate_email: true,
      candidate_status: true,
      approved: true,
      candidate_hourly_rate: true,
      currency_code: true,
      candidate_updated_at: true,
      country: { select: { country_name_en: true } }
    }
  });

  return rows.map((row) => ({
    id: row.candidate_id,
    name: row.candidate_name,
    email: row.candidate_email,
    country: row.country?.country_name_en ?? "No country",
    status: row.approved === 0 ? "Needs review" : row.candidate_status === 10 ? "Active" : `Status ${row.candidate_status}`,
    rate: formatMoney(row.candidate_hourly_rate, row.currency_code ?? "KWD"),
    updated: formatDate(row.candidate_updated_at)
  }));
}

export async function getAdminCompanyRows() {
  const rows = await prisma.company.findMany({
    where: { deleted: 0 },
    orderBy: { company_updated_at: "desc" },
    take: 60,
    select: {
      company_id: true,
      company_name: true,
      company_email: true,
      no_of_active_requests: true,
      company_approved_to_hire: true,
      company_hourly_rate: true,
      currency_code: true,
      company_updated_at: true,
      staff: { select: { staff_name: true } }
    }
  });

  return rows.map((row) => ({
    id: row.company_id,
    name: row.company_name,
    email: row.company_email ?? "No email",
    owner: row.staff?.staff_name ?? "Unassigned",
    requests: row.no_of_active_requests ?? 0,
    status: row.company_approved_to_hire ? "Approved" : "Not approved",
    rate: formatMoney(row.company_hourly_rate, row.currency_code ?? "KWD"),
    updated: formatDate(row.company_updated_at)
  }));
}

export async function getAdminRequestRows() {
  const rows = await prisma.request.findMany({
    orderBy: { request_updated_datetime: "desc" },
    take: 60,
    select: {
      request_uuid: true,
      request_position_title: true,
      request_status: true,
      request_number_of_employees: true,
      request_updated_datetime: true,
      company: { select: { company_name: true } },
      staff: { select: { staff_name: true } }
    }
  });

  return rows.map((row) => ({
    id: row.request_uuid,
    title: row.request_position_title ?? "Untitled request",
    company: row.company?.company_name ?? "No company",
    owner: row.staff?.staff_name ?? "Unassigned",
    seats: row.request_number_of_employees ?? 0,
    status: row.request_status ?? "No status",
    updated: formatDate(row.request_updated_datetime)
  }));
}

export async function getAdminTransferRows() {
  const rows = await prisma.transfer.findMany({
    where: { deleted: 0 },
    orderBy: { transfer_updated_at: "desc" },
    take: 60,
    select: {
      transfer_id: true,
      total: true,
      company_total: true,
      transfer_status: true,
      start_date: true,
      end_date: true,
      currency_code: true,
      company: { select: { company_name: true } }
    }
  });

  return rows.map((row) => ({
    id: row.transfer_id,
    company: row.company?.company_name ?? "No company",
    period: `${formatDate(row.start_date)} to ${formatDate(row.end_date)}`,
    status: `Status ${row.transfer_status}`,
    total: formatMoney(row.total ?? row.company_total, row.currency_code ?? "KWD")
  }));
}

export async function getAdminTransferDetail(transferId: number) {
  const [transfer, candidates, invoices, fileEntries] = await prisma.$transaction([
    prisma.transfer.findUnique({
      where: { transfer_id: transferId },
      select: {
        transfer_id: true,
        total: true,
        company_total: true,
        transfer_cost: true,
        transfer_status: true,
        start_date: true,
        end_date: true,
        payment_received_on: true,
        transfer_created_at: true,
        transfer_updated_at: true,
        currency_code: true,
        company: { select: { company_name: true, company_email: true } },
        staff_transfer_transfer_created_byTostaff: { select: { staff_name: true } },
        staff_transfer_transfer_updated_byTostaff: { select: { staff_name: true } }
      }
    }),
    prisma.transfer_candidate.findMany({
      where: { transfer_id: transferId, deleted: 0 },
      orderBy: { tc_updated_at: "desc" },
      take: 80,
      select: {
        tc_id: true,
        candidate_total: true,
        company_total: true,
        transfer_cost: true,
        hours: true,
        minutes: true,
        paid: true,
        currency_code: true,
        candidate: { select: { candidate_name: true, candidate_email: true } },
        store: { select: { store_name: true } }
      }
    }),
    prisma.invoice.findMany({
      where: { transfer_id: transferId, deleted: 0 },
      orderBy: { invoice_date: "desc" },
      take: 20,
      select: { invoice_id: true, invoice_date: true, invoice_status: true }
    }),
    prisma.transfer_file_entry.findMany({
      where: { transfer: { transfer_id: transferId } },
      take: 20,
      select: {
        tfe_uuid: true,
        status: true,
        status_description: true,
        credit_amount: true,
        credit_currency: true,
        beneficiary_name: true
      }
    })
  ]);

  return {
    transfer,
    metrics: [
      { label: "Status", value: `Status ${transfer?.transfer_status ?? 0}`, note: "Legacy transfer status" },
      { label: "Total", value: formatMoney(transfer?.total ?? transfer?.company_total, transfer?.currency_code ?? "KWD"), note: "Transfer total" },
      { label: "Cost", value: formatMoney(transfer?.transfer_cost, transfer?.currency_code ?? "KWD"), note: "Transfer cost" },
      { label: "Candidates", value: candidates.length, note: "Candidate payout rows shown" }
    ],
    candidates: candidates.map((row) => ({
      id: row.tc_id,
      title: row.candidate?.candidate_name ?? "Unknown candidate",
      subtitle: row.store?.store_name ?? row.candidate?.candidate_email ?? "No store",
      meta: `${row.hours ?? 0}h ${row.minutes ?? 0}m · ${row.paid ? "Paid" : "Unpaid"} · ${formatMoney(row.candidate_total, row.currency_code ?? transfer?.currency_code ?? "KWD")}`
    })),
    invoices: invoices.map((invoice) => ({
      id: invoice.invoice_id,
      title: `Invoice #${invoice.invoice_id}`,
      subtitle: `${invoice.invoice_status ?? "No status"}`,
      meta: formatDate(invoice.invoice_date)
    })),
    fileEntries: fileEntries.map((entry) => ({
      id: entry.tfe_uuid,
      title: entry.beneficiary_name ?? "Transfer file entry",
      subtitle: entry.status_description ?? entry.status ?? "No status",
      meta: formatMoney(entry.credit_amount, entry.credit_currency ?? transfer?.currency_code ?? "KWD")
    }))
  };
}

export async function getStaffRequestRows(staffId: number) {
  const rows = await prisma.request.findMany({
    where: { staff_id: staffId },
    orderBy: { request_updated_datetime: "desc" },
    take: 60,
    select: {
      request_uuid: true,
      request_position_title: true,
      request_status: true,
      request_number_of_employees: true,
      request_updated_datetime: true,
      company: { select: { company_name: true } }
    }
  });

  return rows.map((row) => ({
    id: row.request_uuid,
    title: row.request_position_title ?? "Untitled request",
    company: row.company?.company_name ?? "No company",
    seats: row.request_number_of_employees ?? 0,
    status: row.request_status ?? "No status",
    updated: formatDate(row.request_updated_datetime)
  }));
}


export async function getStaffInterviewRows(staffId: number) {
  const rows = await prisma.request_interview.findMany({
    where: { staff_id: staffId },
    orderBy: { interview_at: "desc" },
    take: 60,
    select: {
      request_interview_uuid: true,
      interview_at: true,
      status: true,
      internal_note: true,
      candidate: { select: { candidate_id: true, candidate_name: true, candidate_email: true } },
      request: { select: { request_uuid: true, request_position_title: true } }
    }
  });

  return rows.map((row) => ({
    id: row.request_interview_uuid,
    candidate: row.candidate?.candidate_name ?? "Unknown candidate",
    candidateEmail: row.candidate?.candidate_email ?? "",
    candidateId: row.candidate?.candidate_id ?? null,
    requestTitle: row.request?.request_position_title ?? "Untitled request",
    requestUuid: row.request?.request_uuid ?? "",
    scheduledAt: row.interview_at ? formatDate(row.interview_at) : "Not scheduled",
    status: row.status === 1 ? "Completed" : row.status === 2 ? "Cancelled" : "Scheduled",
    note: row.internal_note ?? ""
  }));
}

export async function getStaffInterviewDetail(interviewUuid: string, staffId: number) {
  const interview = await prisma.request_interview.findFirst({
    where: { request_interview_uuid: interviewUuid, staff_id: staffId },
    select: {
      request_interview_uuid: true,
      interview_at: true,
      status: true,
      internal_note: true,
      interview_note: true,
      created_at: true,
      updated_at: true,
      candidate: { select: { candidate_id: true, candidate_name: true, candidate_email: true, candidate_phone: true } },
      request: { select: { request_uuid: true, request_position_title: true, request_status: true, company: { select: { company_name: true } } } },
      staff: { select: { staff_name: true } }
    }
  });

  return interview;
}

export async function getStaffCandidateRows(staffId: number) {
  const histories = await prisma.candidate_work_history.findMany({
    where: { staff_id: staffId },
    orderBy: { end_date: "desc" },
    take: 60,
    select: {
      id: true,
      candidate_id: true,
      start_date: true,
      end_date: true,
      company_candidate_work_history_company_idTocompany: { select: { company_name: true } }
    }
  });

  const candidateIds = histories.map((row) => row.candidate_id).filter((id): id is number => Boolean(id));
  const candidates = await prisma.candidate.findMany({
    where: { candidate_id: { in: candidateIds } },
    select: { candidate_id: true, candidate_name: true, candidate_email: true, approved: true }
  });
  const candidateById = new Map(candidates.map((candidate) => [candidate.candidate_id, candidate]));

  return histories.map((row) => {
    const candidate = row.candidate_id ? candidateById.get(row.candidate_id) : null;
    return {
      id: row.id,
      candidateId: candidate?.candidate_id ?? row.candidate_id ?? 0,
      name: candidate?.candidate_name ?? "Unknown candidate",
      email: candidate?.candidate_email ?? "No email",
      company: row.company_candidate_work_history_company_idTocompany?.company_name ?? "No company",
      status: candidate?.approved === 0 ? "Needs review" : "Assigned",
      period: `${formatDate(row.start_date)} to ${formatDate(row.end_date)}`
    };
  });
}

export type StaffCandidateFilter = "all" | "active" | "needs-review" | "incomplete" | "civil-id";

export type StaffCandidateDirectoryRow = {
  id: number;
  uid: string;
  name: string;
  email: string;
  phone: string;
  country: string;
  company: string;
  store: string;
  status: string;
  flags: string[];
  rate: string;
  updated: string;
  created: string;
  civilExpiry: string;
  candidateStatus: number;
  approved: number;
  isIncomplete: boolean;
  needsCivilId: boolean;
  searchStatus: number | null;
  priorityScore: number;
  signal: string;
};

export async function getStaffCandidateDirectoryRows({
  staffId,
  search,
  filter
}: {
  staffId: number;
  search?: string;
  filter?: StaffCandidateFilter;
}) {
  const normalizedSearch = search?.trim();
  const candidateIds = await getCandidateIdsForStaff(staffId);
  const staffCandidateWhere = candidateIds.length ? { candidate_id: { in: candidateIds } } : { candidate_id: -1 };
  const where = {
    deleted: 0,
    ...staffCandidateWhere,
    ...(filter === "active" ? { candidate_status: 10, approved: { not: 0 } } : {}),
    ...(filter === "needs-review" ? { approved: 0 } : {}),
    ...(filter === "incomplete" ? { is_incomplete_profile: true } : {}),
    ...(filter === "civil-id" ? { candidate_civil_need_verification: true } : {}),
    ...(normalizedSearch
      ? {
          OR: [
            { candidate_name: { contains: normalizedSearch } },
            { candidate_email: { contains: normalizedSearch } },
            ...(Number.isInteger(Number(normalizedSearch)) ? [{ candidate_id: Number(normalizedSearch) }] : [])
          ]
        }
      : {})
  };

  const [rows, active, needsReview, incomplete, civilId] = await prisma.$transaction([
    prisma.candidate.findMany({
      where,
      orderBy: { candidate_updated_at: "desc" },
      take: 80,
      select: {
        candidate_id: true,
        candidate_uid: true,
        candidate_name: true,
        candidate_email: true,
        candidate_phone: true,
        candidate_status: true,
        approved: true,
        candidate_job_search_status: true,
        candidate_civil_expiry_date: true,
        is_incomplete_profile: true,
        candidate_civil_need_verification: true,
        candidate_hourly_rate: true,
        currency_code: true,
        candidate_created_at: true,
        candidate_updated_at: true,
        country: { select: { country_name_en: true } },
        store: { select: { store_name: true, company: { select: { company_name: true } } } }
      }
    }),
    prisma.candidate.count({ where: { deleted: 0, ...staffCandidateWhere, candidate_status: 10, approved: { not: 0 } } }),
    prisma.candidate.count({ where: { deleted: 0, ...staffCandidateWhere, approved: 0 } }),
    prisma.candidate.count({ where: { deleted: 0, ...staffCandidateWhere, is_incomplete_profile: true } }),
    prisma.candidate.count({ where: { deleted: 0, ...staffCandidateWhere, candidate_civil_need_verification: true } })
  ]);

  return {
    rows: rows.map((row) => {
      const isIncomplete = Boolean(row.is_incomplete_profile);
      const needsCivilId = Boolean(row.candidate_civil_need_verification);
      const flags = [
        row.approved === 0 ? "Needs review" : null,
        isIncomplete ? "Incomplete" : null,
        needsCivilId ? "Civil ID" : null,
        row.candidate_status !== 10 ? `Status ${row.candidate_status}` : null
      ].filter((flag): flag is string => Boolean(flag));

      return {
        id: row.candidate_id,
        uid: row.candidate_uid ?? `#${row.candidate_id}`,
        name: row.candidate_name,
        email: row.candidate_email,
        phone: row.candidate_phone ?? "No phone",
        country: row.country?.country_name_en ?? "No country",
        company: row.store?.company?.company_name ?? "No company",
        store: row.store?.store_name ?? "No store",
        status: row.approved === 0 ? "Needs review" : row.candidate_status === 10 ? "Active" : `Status ${row.candidate_status}`,
        flags,
        rate: formatMoney(row.candidate_hourly_rate, row.currency_code ?? "KWD"),
        updated: formatDate(row.candidate_updated_at),
        created: formatDate(row.candidate_created_at),
        civilExpiry: formatDate(row.candidate_civil_expiry_date),
        candidateStatus: row.candidate_status,
        approved: row.approved,
        isIncomplete,
        needsCivilId,
        searchStatus: row.candidate_job_search_status ?? null,
        priorityScore:
          (row.approved === 0 ? 40 : 0) +
          (isIncomplete ? 30 : 0) +
          (needsCivilId ? 25 : 0) +
          (row.candidate_status !== 10 ? 10 : 0),
        signal:
          row.approved === 0
            ? "Approval decision"
            : isIncomplete
              ? "Profile cleanup"
              : needsCivilId
                ? "Civil ID review"
                : row.candidate_status === 10
                  ? "Ready"
                  : "Watch"
      };
    }),
    metrics: [
      { label: "Active", value: active, note: "Approved active candidates" },
      { label: "Needs Review", value: needsReview, note: "Candidates waiting on approval" },
      { label: "Incomplete", value: incomplete, note: "Profiles flagged incomplete" },
      { label: "Civil ID", value: civilId, note: "Candidates needing civil ID review" }
    ]
  };
}

export async function getStaffCandidateConsole({
  staffId,
  search,
  filter,
  candidateId
}: {
  staffId: number;
  search?: string;
  filter?: StaffCandidateFilter;
  candidateId?: number;
}) {
  const directory = await getStaffCandidateDirectoryRows({ staffId, search, filter });
  const rows = directory.rows;
  const selectedId =
    candidateId && Number.isFinite(candidateId) && (await canStaffAccessCandidate(staffId, candidateId))
      ? candidateId
      : rows[0]?.id;
  const selected = selectedId ? await getCandidateDetail(selectedId, "/staff/requests") : null;
  const candidateIds = rows.map((row) => row.id);
  const scopedCandidateWhere = candidateIds.length ? { candidate_id: { in: candidateIds } } : { candidate_id: -1 };

  const [
    requestCount,
    applicationCount,
    interviewCount,
    storyCount,
    workLogCount,
    appealCount,
    transferCandidateCount,
    unpaidCandidateCount,
    invoiceCount,
    idRequestCount,
    recentRequests,
    recentTransfers,
    recentIdRequests,
    recentWorkLogs,
    recentInvitations,
    pendingAppeals,
    warnings
  ] =
    await prisma.$transaction([
      prisma.request.count({ where: { staff_id: staffId } }),
      prisma.request_application.count({ where: { request: { staff_id: staffId } } }),
      prisma.request_interview.count({ where: { OR: [{ staff_id: staffId }, { request: { staff_id: staffId } }] } }),
      prisma.story.count({ where: { staff_id: staffId } }),
      prisma.candidate_working_hour.count({ where: scopedCandidateWhere }),
      prisma.candidate_working_hour_appeal.count({ where: { ...scopedCandidateWhere, status: { in: [0, 1] } } }),
      prisma.transfer_candidate.count({ where: { ...scopedCandidateWhere, deleted: 0 } }),
      prisma.transfer_candidate.count({ where: { ...scopedCandidateWhere, deleted: 0, paid: 0 } }),
      prisma.invoice.count({
        where: {
          deleted: 0,
          transfer: candidateIds.length ? { transfer_candidate: { some: scopedCandidateWhere } } : { transfer_id: -1 }
        }
      }),
      prisma.candidate_id_request.count({ where: { created_by: staffId } }),
      prisma.request.findMany({
        where: { staff_id: staffId },
        orderBy: { request_updated_datetime: "desc" },
        take: 5,
        select: {
          request_uuid: true,
          request_position_title: true,
          request_status: true,
          request_number_of_employees: true,
          request_updated_datetime: true,
          company: { select: { company_name: true } }
        }
      }),
      prisma.transfer_candidate.findMany({
        where: { ...scopedCandidateWhere, deleted: 0 },
        orderBy: { tc_updated_at: "desc" },
        take: 5,
        select: {
          tc_id: true,
          transfer_id: true,
          candidate_total: true,
          company_total: true,
          paid: true,
          currency_code: true,
          tc_updated_at: true,
          candidate: { select: { candidate_name: true } },
          company: { select: { company_name: true } }
        }
      }),
      prisma.candidate_id_request.findMany({
        where: { created_by: staffId },
        orderBy: { updated_at: "desc" },
        take: 5,
        select: { cir_uuid: true, status: true, candidate_ids: true, updated_at: true, created_at: true }
      }),
      prisma.candidate_working_hour.findMany({
        where: scopedCandidateWhere,
        orderBy: [{ updated_at: "desc" }, { date: "desc" }],
        take: 12,
        select: {
          candidate_working_hour_uuid: true,
          candidate_id: true,
          date: true,
          total_time: true,
          status: true,
          updated_at: true,
          candidate: { select: { candidate_name: true } },
          store: { select: { store_name: true } }
        }
      }),
      prisma.invitation.findMany({
        where: scopedCandidateWhere,
        orderBy: { invitation_created_at: "desc" },
        take: 12,
        select: {
          invitation_uuid: true,
          candidate_id: true,
          invitation_status: true,
          invitation_created_at: true,
          candidate: { select: { candidate_name: true } },
          request: { select: { request_uuid: true, request_position_title: true, company: { select: { company_name: true } } } }
        }
      }),
      prisma.candidate_working_hour_appeal.findMany({
        where: { ...scopedCandidateWhere, status: { in: [0, 1] } },
        orderBy: { updated_at: "desc" },
        take: 8,
        select: {
          appeal_uuid: true,
          candidate_id: true,
          reason: true,
          status: true,
          updated_at: true,
          created_at: true,
          candidate: { select: { candidate_name: true } }
        }
      }),
      prisma.candidate_warning.findMany({
        where: scopedCandidateWhere,
        orderBy: { created_at: "desc" },
        take: 8,
        select: {
          warning_id: true,
          candidate_id: true,
          title: true,
          message: true,
          created_at: true,
          candidate: { select: { candidate_name: true } }
        }
      })
    ]);

  const [fallbackCandidates, fallbackCompanies, fallbackTransfers, fallbackInvoices, fallbackIdRequests] = candidateIds.length
    ? await prisma.$transaction([
        prisma.candidate.count({ where: { deleted: 0 } }),
        prisma.company.count({ where: { deleted: 0 } }),
        prisma.transfer.count({ where: { deleted: 0 } }),
        prisma.invoice.count({ where: { deleted: 0 } }),
        prisma.candidate_id_request.count()
      ])
    : await prisma.$transaction([
        prisma.candidate.count({ where: { deleted: 0 } }),
        prisma.company.count({ where: { deleted: 0 } }),
        prisma.transfer.count({ where: { deleted: 0 } }),
        prisma.invoice.count({ where: { deleted: 0 } }),
        prisma.candidate_id_request.count()
      ]);

  const activity = [
    ...recentWorkLogs.map((item) => ({
      id: item.candidate_working_hour_uuid,
      type: "Work log",
      title: item.candidate?.candidate_name ?? "Candidate",
      subtitle: item.store?.store_name ?? "No store",
      meta: `${item.total_time ?? 0} min · Status ${item.status ?? 0}`,
      sortDate: item.updated_at ?? item.date,
      href: `/staff/candidates?candidate=${item.candidate_id ?? ""}`
    })),
    ...recentInvitations.map((item) => ({
      id: item.invitation_uuid,
      type: "Invitation",
      title: item.candidate?.candidate_name ?? "Candidate",
      subtitle: item.request.company?.company_name ?? item.request.request_position_title ?? "Request",
      meta: `Status ${item.invitation_status ?? 0}`,
      sortDate: item.invitation_created_at,
      href: `/staff/requests/${item.request.request_uuid}`
    })),
    ...pendingAppeals.map((item) => ({
      id: item.appeal_uuid,
      type: "Appeal",
      title: item.candidate?.candidate_name ?? "Candidate",
      subtitle: item.reason?.slice(0, 96) ?? "Work-log appeal",
      meta: `Status ${item.status}`,
      sortDate: item.updated_at ?? item.created_at,
      href: `/staff/candidates?candidate=${item.candidate_id}`
    })),
    ...warnings.map((item) => ({
      id: item.warning_id,
      type: "Warning",
      title: item.candidate?.candidate_name ?? "Candidate",
      subtitle: item.title ?? item.message.slice(0, 96),
      meta: formatDate(item.created_at),
      sortDate: item.created_at,
      href: `/staff/candidates?candidate=${item.candidate_id ?? ""}`
    }))
  ]
    .sort((a, b) => (b.sortDate?.getTime() ?? 0) - (a.sortDate?.getTime() ?? 0))
    .slice(0, 16)
    .map((item) => ({ ...item, sortDate: undefined, meta: item.meta || formatDate(item.sortDate) }));

  const needsDecision = rows
    .filter((row) => row.priorityScore > 0)
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .slice(0, 8);
  const active = rows.filter((row) => row.candidateStatus === 10 && row.approved !== 0).slice(0, 8);
  const recentlyUpdated = rows.slice(0, 8);
  const quiet = rows
    .filter((row) => row.priorityScore === 0 && row.candidateStatus !== 10)
    .slice(0, 8);

  return {
    ...directory,
    selected,
    selectedId,
    activity,
    staffOS: {
      tabs: [
        { label: "Candidates", value: rows.length, href: "/staff/candidates", active: true },
        { label: "Requests", value: requestCount, href: "/staff/requests", active: false },
        { label: "Time", value: workLogCount, href: "/staff/candidates#time", active: false },
        { label: "Pay", value: unpaidCandidateCount, href: "/staff/candidates#pay", active: false },
        { label: "Invoices", value: invoiceCount, href: "/staff/candidates#invoices", active: false },
        { label: "ID Cards", value: idRequestCount, href: "/staff/candidates#id-cards", active: false }
      ],
      quickStats: [
        { label: "Requests", value: requestCount, note: "Assigned hiring demand" },
        { label: "Applications", value: applicationCount, note: "Candidates in request pipeline" },
        { label: "Interviews", value: interviewCount, note: "Scheduled or imported interviews" },
        { label: "Stories", value: storyCount, note: "Legacy fulfillment stories" },
        { label: "Time Logs", value: workLogCount, note: "Candidate tracked shifts in scope" },
        { label: "Open Appeals", value: appealCount, note: "Time disputes needing review" },
        { label: "Payout Rows", value: transferCandidateCount, note: "Candidate transfer rows in scope" },
        { label: "Unpaid", value: unpaidCandidateCount, note: "Transfer candidate rows not paid" }
      ],
      workflows: [
        {
          id: "requests",
          title: "Staff hiring pipeline",
          subtitle: "Requests, applications, interviews, stories",
          metric: requestCount,
          href: "/staff/requests",
          rows: recentRequests.map((request) => ({
            id: request.request_uuid,
            title: request.request_position_title ?? "Untitled request",
            subtitle: request.company?.company_name ?? "No company",
            meta: `${request.request_status ?? "No status"} · ${request.request_number_of_employees ?? 0} seats · ${formatDate(request.request_updated_datetime)}`,
            href: `/staff/requests/${request.request_uuid}`
          }))
        },
        {
          id: "time",
          title: "Candidate time tracking",
          subtitle: "Clocked shifts, pending approvals, appeals",
          metric: workLogCount,
          href: "/staff/candidates#time",
          rows: recentWorkLogs.slice(0, 5).map((log) => ({
            id: log.candidate_working_hour_uuid,
            title: log.candidate?.candidate_name ?? "Candidate",
            subtitle: log.store?.store_name ?? "No store",
            meta: `${log.total_time ?? 0} min · Status ${log.status ?? 0} · ${formatDate(log.date)}`
          }))
        },
        {
          id: "pay",
          title: "Pay candidates",
          subtitle: "Transfer rows, paid state, candidate totals",
          metric: unpaidCandidateCount,
          href: "/staff/candidates#pay",
          rows: recentTransfers.map((transfer) => ({
            id: transfer.tc_id,
            title: transfer.candidate?.candidate_name ?? "Candidate payout",
            subtitle: transfer.company?.company_name ?? "No company",
            meta: `${transfer.paid ? "Paid" : "Unpaid"} · ${formatMoney(transfer.candidate_total, transfer.currency_code ?? "KWD")}`
          }))
        },
        {
          id: "invoices",
          title: "Company invoices",
          subtitle: "Invoice records generated from transfers",
          metric: invoiceCount,
          href: "/staff/candidates#invoices",
          rows: recentTransfers.map((transfer) => ({
            id: `invoice-${transfer.tc_id}`,
            title: transfer.company?.company_name ?? "Company invoice",
            subtitle: transfer.candidate?.candidate_name ?? "Candidate",
            meta: formatMoney(transfer.company_total, transfer.currency_code ?? "KWD")
          }))
        },
        {
          id: "id-cards",
          title: "ID cards and PDFs",
          subtitle: "Civil ID batches and printable document queue",
          metric: idRequestCount || fallbackIdRequests,
          href: "/staff/candidates#id-cards",
          rows: recentIdRequests.map((request) => ({
            id: request.cir_uuid,
            title: `ID batch ${request.cir_uuid.slice(0, 12)}`,
            subtitle: `${parseCandidateIds(request.candidate_ids).length} candidates`,
            meta: `${request.status ?? "pending"} · ${formatDate(request.updated_at ?? request.created_at)}`
          }))
        }
      ],
      estate: [
        { label: "Candidates", value: fallbackCandidates, note: "Total imported" },
        { label: "Companies", value: fallbackCompanies, note: "Employer accounts" },
        { label: "Transfers", value: fallbackTransfers, note: "Payroll batches" },
        { label: "Invoices", value: fallbackInvoices, note: "Legacy invoice rows" }
      ]
    },
    lanes: [
      {
        id: "decision",
        title: "Needs staff decision",
        note: "Approval, profile, civil ID, or status exceptions",
        rows: needsDecision
      },
      { id: "active", title: "Active assignments", note: "Approved candidates in active status", rows: active },
      { id: "recent", title: "Recently changed", note: "Newest candidate updates in your scope", rows: recentlyUpdated },
      { id: "watch", title: "Watch list", note: "Non-active candidates without open flags", rows: quiet }
    ],
    actionPlan: buildStaffCandidateActionPlan(selected)
  };
}

export async function getStaffCandidateDetail(staffId: number, candidateId: number) {
  const hasAccess = await canStaffAccessCandidate(staffId, candidateId);
  if (!hasAccess) return null;
  return getCandidateDetail(candidateId);
}

async function getCandidateIdsForStaff(staffId: number) {
  const rows = await prisma.candidate_work_history.findMany({
    where: { staff_id: staffId, candidate_id: { not: null } },
    distinct: ["candidate_id"],
    orderBy: { end_date: "desc" },
    take: 500,
    select: { candidate_id: true }
  });
  return rows.map((row) => row.candidate_id).filter((id): id is number => Boolean(id));
}

async function canStaffAccessCandidate(staffId: number, candidateId: number) {
  const row = await prisma.candidate_work_history.findFirst({
    where: { staff_id: staffId, candidate_id: candidateId },
    select: { id: true }
  });
  return Boolean(row);
}

export async function getCandidateDetail(candidateId: number, requestBasePath = "/staff/requests") {
  const [
    candidate,
    invitations,
    workHours,
    histories,
    notes,
    skills,
    tags,
    warnings,
    links,
    idCards,
    applications,
    interviews,
    suggestions,
    education,
    experiences,
    certificates,
    languages,
    stats
  ] = await prisma.$transaction([
    prisma.candidate.findUnique({
      where: { candidate_id: candidateId },
      select: {
        candidate_id: true,
        candidate_uid: true,
        candidate_name: true,
        candidate_name_ar: true,
        candidate_objective: true,
        candidate_intro: true,
        candidate_personal_photo: true,
        candidate_resume: true,
        candidate_email: true,
        candidate_email_verification: true,
        candidate_phone: true,
        candidate_civil_id: true,
        candidate_civil_expiry_date: true,
        candidate_civil_photo_front: true,
        candidate_civil_photo_back: true,
        candidate_video: true,
        candidate_address_line1: true,
        candidate_birth_date: true,
        bank_id: true,
        bank_account_name: true,
        candidate_iban: true,
        candidate_status: true,
        approved: true,
        candidate_hourly_rate: true,
        currency_code: true,
        candidate_job_search_status: true,
        candidate_civil_need_verification: true,
        is_incomplete_profile: true,
        profile_url: true,
        candidate_created_at: true,
        candidate_updated_at: true,
        country_id: true,
        country: { select: { country_name_en: true } },
        university_id: true,
        university: { select: { university_name_en: true } },
        store: { select: { store_name: true, company: { select: { company_name: true } } } }
      }
    }),
    prisma.invitation.findMany({
      where: { candidate_id: candidateId },
      orderBy: { invitation_created_at: "desc" },
      take: 8,
      select: {
        invitation_uuid: true,
        invitation_status: true,
        invitation_created_at: true,
        request: {
          select: {
            request_uuid: true,
            request_position_title: true,
            company: { select: { company_name: true } }
          }
        }
      }
    }),
    prisma.candidate_working_hour.findMany({
      where: { candidate_id: candidateId },
      orderBy: { date: "desc" },
      take: 8,
      select: {
        candidate_working_hour_uuid: true,
        date: true,
        total_time: true,
        status: true,
        store: { select: { store_name: true } }
      }
    }),
    prisma.candidate_work_history.findMany({
      where: { candidate_id: candidateId },
      orderBy: { end_date: "desc" },
      take: 8,
      select: {
        id: true,
        start_date: true,
        end_date: true,
        candidate_hourly_rate: true,
        company_candidate_work_history_company_idTocompany: { select: { company_name: true } },
        staff: { select: { staff_name: true } }
      }
    }),
    prisma.note.findMany({
      where: { candidate_id: candidateId },
      orderBy: { note_created_datetime: "desc" },
      take: 6,
      select: {
        note_uuid: true,
        note_type: true,
        note_text: true,
        note_created_datetime: true
      }
    }),
    prisma.candidate_skill.findMany({
      where: { candidate_id: candidateId, deleted: 0 },
      orderBy: { candidate_skill_created_at: "desc" },
      take: 12,
      select: {
        candidate_skill_id: true,
        skill: true,
        candidate_skill_created_at: true
      }
    }),
    prisma.candidate_tag.findMany({
      where: { candidate_id: candidateId, deleted: 0 },
      orderBy: { created_at: "desc" },
      take: 10,
      select: {
        tag_id: true,
        tag: true,
        reason: true,
        created_at: true,
        staff: { select: { staff_name: true } }
      }
    }),
    prisma.candidate_warning.findMany({
      where: { candidate_id: candidateId },
      orderBy: { created_at: "desc" },
      take: 8,
      select: {
        warning_id: true,
        title: true,
        message: true,
        created_at: true
      }
    }),
    prisma.candidate_link.findMany({
      where: { candidate_id: candidateId },
      orderBy: { updated_at: "desc" },
      take: 8,
      select: {
        cl_uuid: true,
        title: true,
        url: true,
        updated_at: true
      }
    }),
    prisma.candidate_id_card.findMany({
      where: { candidate_id: candidateId, deleted: 0 },
      orderBy: { updated_at: "desc" },
      take: 4,
      select: {
        id: true,
        expiry_date: true,
        created_at: true,
        updated_at: true
      }
    }),
    prisma.request_application.findMany({
      where: { candidate_id: candidateId },
      orderBy: { created_at: "desc" },
      take: 8,
      select: {
        application_uuid: true,
        status: true,
        created_at: true,
        request: {
          select: {
            request_uuid: true,
            request_position_title: true,
            company: { select: { company_name: true } }
          }
        }
      }
    }),
    prisma.request_interview.findMany({
      where: { candidate_id: candidateId },
      orderBy: { interview_at: "desc" },
      take: 8,
      select: {
        request_interview_uuid: true,
        status: true,
        interview_at: true,
        request: {
          select: {
            request_uuid: true,
            request_position_title: true,
            company: { select: { company_name: true } }
          }
        }
      }
    }),
    prisma.suggestion.findMany({
      where: { candidate_id: candidateId },
      orderBy: { suggestion_datetime: "desc" },
      take: 8,
      select: {
        suggestion_uuid: true,
        suggestion_status: true,
        mail_to_company: true,
        suggestion_datetime: true,
        request: {
          select: {
            request_uuid: true,
            request_position_title: true,
            company: { select: { company_name: true } }
          }
        },
        note_suggestion_note_uuidTonote: { select: { note_text: true } }
      }
    }),
    prisma.candidate_education.findMany({
      where: { candidate_id: candidateId },
      orderBy: { updated_at: "desc" },
      take: 6,
      select: {
        education_uuid: true,
        university_id: true,
        degree_uuid: true,
        major_uuid: true,
        graduation_year: true,
        is_currently_studying: true,
        university: { select: { university_name_en: true } },
        degree: { select: { degree_name_en: true } },
        major: { select: { major_name_en: true } },
        updated_at: true
      }
    }),
    prisma.candidate_experience.findMany({
      where: { candidate_id: candidateId, deleted: 0 },
      orderBy: { candidate_experience_created_at: "desc" },
      take: 8,
      select: {
        candidate_experience_id: true,
        experience: true,
        employer: true,
        start_year: true,
        end_year: true,
        candidate_experience_created_at: true
      }
    }),
    prisma.candidate_certificate.findMany({
      where: { candidate_id: candidateId, is_deleted: false },
      orderBy: { updated_at: "desc" },
      take: 6,
      select: {
        certificate_uuid: true,
        certificate_type: true,
        start_date: true,
        end_date: true,
        company_candidate_certificate_company_idTocompany: { select: { company_name: true } },
        store: { select: { store_name: true } },
        staff: { select: { staff_name: true } },
        updated_at: true
      }
    }),
    prisma.candidate_language.findMany({
      where: { candidate_id: candidateId, deleted: 0 },
      orderBy: { candidate_language_created_at: "desc" },
      take: 10,
      select: {
        candidate_language_id: true,
        language: true,
        proficiency: true,
      }
    }),
    prisma.candidate_stats.findFirst({
      where: { candidate_id: candidateId },
      orderBy: { updated_at: "desc" },
      select: {
        total_revenue: true,
        currency_code: true,
        updated_at: true
      }
    })
  ]);

  return {
    candidate,
    metrics: [
      { label: "Status", value: candidate?.approved === 0 ? "Needs review" : `Active ${candidate?.candidate_status ?? ""}`, note: "Approval and legacy status" },
      { label: "Rate", value: formatMoney(candidate?.candidate_hourly_rate, candidate?.currency_code ?? "KWD"), note: "Candidate hourly rate" },
      { label: "Invitations", value: invitations.length, note: "Most recent invitations shown below" },
      { label: "Work Logs", value: workHours.length, note: "Recent imported work-hour records" }
    ],
    invitations: invitations.map((invitation) => ({
      id: invitation.invitation_uuid,
      title: invitation.request.request_position_title ?? "Invitation",
      subtitle: invitation.request.company?.company_name ?? "No company",
      meta: `Status ${invitation.invitation_status ?? 0} · ${formatDate(invitation.invitation_created_at)}`,
      href: `${requestBasePath}/${invitation.request.request_uuid}`
    })),
    workHours: workHours.map((hour) => ({
      id: hour.candidate_working_hour_uuid,
      title: hour.store?.store_name ?? "Work log",
      subtitle: `${hour.total_time ?? 0} minutes`,
      meta: `Status ${hour.status ?? 0} · ${formatDate(hour.date)}`,
      status: hour.status ?? 0
    })),
    histories: histories.map((history) => ({
      id: history.id,
      title: history.company_candidate_work_history_company_idTocompany?.company_name ?? "Assignment",
      subtitle: history.staff?.staff_name ?? "No staff owner",
      meta: `${formatDate(history.start_date)} to ${formatDate(history.end_date)} · ${formatMoney(history.candidate_hourly_rate, candidate?.currency_code ?? "KWD")}`
    })),
    notes: notes.map((note) => ({
      id: note.note_uuid,
      title: note.note_type ?? "Note",
      subtitle: note.note_text?.slice(0, 180) ?? "Empty note",
      meta: formatDate(note.note_created_datetime)
    })),
    skills: skills.map((skill) => ({
      id: skill.candidate_skill_id,
      title: skill.skill,
      subtitle: "Skill",
      meta: formatDate(skill.candidate_skill_created_at)
    })),
    tags: tags.map((tag) => ({
      id: tag.tag_id,
      title: tag.tag,
      subtitle: tag.reason?.slice(0, 180) ?? tag.staff?.staff_name ?? "Candidate tag",
      meta: formatDate(tag.created_at)
    })),
    warnings: warnings.map((warning) => ({
      id: warning.warning_id,
      title: warning.title ?? "Warning",
      subtitle: warning.message.slice(0, 180),
      meta: formatDate(warning.created_at)
    })),
    links: links.map((link) => ({
      id: link.cl_uuid,
      title: link.title ?? "Candidate link",
      subtitle: link.url ?? "No URL",
      meta: formatDate(link.updated_at),
      href: link.url ?? undefined
    })),
    idCards: idCards.map((card) => ({
      id: card.id,
      title: `Civil ID card #${card.id}`,
      subtitle: `Expires ${formatDate(card.expiry_date)}`,
      meta: `Updated ${formatDate(card.updated_at ?? card.created_at)}`
    })),
    applications: applications.map((application) => ({
      id: application.application_uuid,
      title: application.request.request_position_title ?? "Application",
      subtitle: application.request.company?.company_name ?? "No company",
      meta: `Status ${application.status ?? 0} · ${formatDate(application.created_at)}`,
      href: `${requestBasePath}/${application.request.request_uuid}`
    })),
    interviews: interviews.map((interview) => ({
      id: interview.request_interview_uuid,
      title: interview.request.request_position_title ?? "Interview",
      subtitle: interview.request.company?.company_name ?? "No company",
      meta: `Status ${interview.status ?? 0} · ${formatDate(interview.interview_at)}`,
      href: `${requestBasePath}/${interview.request.request_uuid}`
    })),
    suggestions: suggestions.map((suggestion) => ({
      id: suggestion.suggestion_uuid,
      title: suggestion.request.request_position_title ?? "Suggestion",
      subtitle: suggestion.note_suggestion_note_uuidTonote.note_text?.slice(0, 180) ?? suggestion.request.company?.company_name ?? "No note",
      meta: `Status ${suggestion.suggestion_status ?? 0} · ${suggestion.mail_to_company ? "Mailed" : "Not mailed"} · ${formatDate(suggestion.suggestion_datetime)}`,
      href: `${requestBasePath}/${suggestion.request.request_uuid}`
    })),
    education: education.map((item) => ({
      id: item.education_uuid,
      title: item.university.university_name_en ?? "Education",
      subtitle: [item.degree?.degree_name_en, item.major?.major_name_en].filter(Boolean).join(" · ") || "Education",
      meta: `${item.is_currently_studying ? "Currently studying" : "Graduated"}${item.graduation_year ? ` · ${item.graduation_year}` : ""}`
    })),
    educationEntries: education.map((item) => ({
      id: item.education_uuid,
      universityId: item.university_id,
      degreeUuid: item.degree_uuid,
      majorUuid: item.major_uuid,
      graduationYear: item.graduation_year,
      isCurrentlyStudying: item.is_currently_studying ?? false,
      universityLabel: item.university?.university_name_en ?? "",
      degreeLabel: item.degree?.degree_name_en ?? undefined,
      majorLabel: item.major?.major_name_en ?? undefined,
    })),
    experiences: experiences.map((item) => ({
      id: item.candidate_experience_id,
      title: item.experience,
      subtitle: item.employer ?? "Experience",
      meta: [item.start_year, item.end_year].filter(Boolean).join(" to ") || formatDate(item.candidate_experience_created_at)
    })),
    certificates: certificates.map((item) => ({
      id: item.certificate_uuid,
      title: item.company_candidate_certificate_company_idTocompany?.company_name ?? item.store?.store_name ?? "Certificate",
      subtitle: item.certificate_type ? "Experience certificate" : "Certificate",
      meta: `${formatDate(item.start_date)} to ${formatDate(item.end_date)} · ${item.staff?.staff_name ?? "No staff owner"}`
    })),
    languages: languages.map((item) => ({
      id: item.candidate_language_id,
      title: item.language,
      subtitle: item.proficiency,
    })),
    stats: stats
      ? {
          totalRevenue: formatMoney(stats.total_revenue, stats.currency_code ?? candidate?.currency_code ?? "KWD"),
          updated: formatDate(stats.updated_at)
        }
      : null
  };
}

function buildStaffCandidateActionPlan(detail: Awaited<ReturnType<typeof getCandidateDetail>> | null) {
  const candidate = detail?.candidate;
  if (!candidate) return [];

  const actions = [
    candidate.approved === 0
      ? {
          title: "Review approval",
          subtitle: "Candidate is still waiting on a staff decision.",
          priority: "Critical"
        }
      : null,
    candidate.is_incomplete_profile
      ? {
          title: "Complete profile",
          subtitle: "Legacy profile completeness is flagged incomplete.",
          priority: "High"
        }
      : null,
    candidate.candidate_civil_need_verification
      ? {
          title: "Resolve civil ID",
          subtitle: "Civil ID verification is still marked as required.",
          priority: "High"
        }
      : null,
    detail.workHours.length
      ? {
          title: "Audit recent work logs",
          subtitle: `${detail.workHours.length} imported work-log records are visible for review.`,
          priority: "Ops"
        }
      : null,
    detail.invitations.length
      ? {
          title: "Follow up invitations",
          subtitle: `${detail.invitations.length} recent invitations are attached to this profile.`,
          priority: "Pipeline"
        }
      : null,
    detail.warnings.length
      ? {
          title: "Check warnings",
          subtitle: `${detail.warnings.length} warning records were imported from the legacy staff app.`,
          priority: "Risk"
        }
      : null
  ].filter((action): action is { title: string; subtitle: string; priority: string } => Boolean(action));

  return actions.length
    ? actions.slice(0, 6)
    : [
        {
          title: "Keep candidate warm",
          subtitle: "No open profile, approval, civil ID, invitation, or warning action is visible in the current slice.",
          priority: "Clear"
        }
      ];
}

export async function getCompanyDetail(companyId: number) {
  const [company, requests, contacts, stores, notes] = await prisma.$transaction([
    prisma.company.findUnique({
      where: { company_id: companyId },
      select: {
        company_id: true,
        company_name: true,
        company_common_name_en: true,
        company_email: true,
        company_website: true,
        company_approved_to_hire: true,
        company_hourly_rate: true,
        currency_code: true,
        no_of_active_requests: true,
        company_created_at: true,
        company_updated_at: true,
        staff: { select: { staff_name: true, staff_email: true } },
        country: { select: { country_name_en: true } }
      }
    }),
    prisma.request.findMany({
      where: { company_id: companyId },
      orderBy: { request_updated_datetime: "desc" },
      take: 8,
      select: {
        request_uuid: true,
        request_position_title: true,
        request_status: true,
        request_number_of_employees: true,
        request_updated_datetime: true
      }
    }),
    prisma.company_contact.findMany({
      where: { company_id: companyId },
      take: 8,
      select: {
        company_contact_uuid: true,
        contact_position: true,
        allow_access: true,
        contact: { select: { contact_name: true, contact_email: true } }
      }
    }),
    prisma.store.findMany({
      where: { company_id: companyId, deleted: 0 },
      take: 8,
      select: { store_id: true, store_name: true, store_status: true }
    }),
    prisma.note.findMany({
      where: { company_id: companyId },
      orderBy: { note_created_datetime: "desc" },
      take: 6,
      select: { note_uuid: true, note_type: true, note_text: true, note_created_datetime: true }
    })
  ]);

  return {
    company,
    metrics: [
      { label: "Active Requests", value: company?.no_of_active_requests ?? requests.length, note: "Legacy active request count" },
      { label: "Approved", value: company?.company_approved_to_hire ? "Yes" : "No", note: "Approved to hire" },
      { label: "Rate", value: formatMoney(company?.company_hourly_rate, company?.currency_code ?? "KWD"), note: "Company hourly rate" },
      { label: "Owner", value: company?.staff?.staff_name ?? "Unassigned", note: company?.staff?.staff_email ?? "No staff email" }
    ],
    requests: requests.map((request) => ({
      id: request.request_uuid,
      title: request.request_position_title ?? "Untitled request",
      subtitle: `${request.request_number_of_employees ?? 0} seats`,
      meta: `${request.request_status ?? "No status"} · ${formatDate(request.request_updated_datetime)}`
    })),
    contacts: contacts.map((contact) => ({
      id: contact.company_contact_uuid,
      title: contact.contact?.contact_name ?? "Contact",
      subtitle: contact.contact?.contact_email ?? "No email",
      meta: `${contact.contact_position ?? "No position"} · ${contact.allow_access ? "Access allowed" : "Access disabled"}`
    })),
    stores: stores.map((store) => ({
      id: store.store_id,
      title: store.store_name,
      subtitle: `Status ${store.store_status ?? 0}`,
      meta: "Active store"
    })),
    notes: notes.map((note) => ({
      id: note.note_uuid,
      title: note.note_type ?? "Note",
      subtitle: note.note_text?.slice(0, 180) ?? "Empty note",
      meta: formatDate(note.note_created_datetime)
    }))
  };
}

export async function getRequestDetail(
  requestUuid: string,
  staffId?: number,
  options: { candidateHref?: (candidateId: number) => string | undefined } = {}
) {
  const where = staffId ? { request_uuid: requestUuid, staff_id: staffId } : { request_uuid: requestUuid };
  const [request, applications, interviews, invitations, activities, notes, stories, requestSkills, suggestions] = await prisma.$transaction([
    prisma.request.findFirst({
      where,
      select: {
        request_uuid: true,
        request_position_title: true,
        request_job_description: true,
        request_compensation: true,
        request_number_of_employees: true,
        request_location: true,
        request_additional_info: true,
        request_status: true,
        request_priority: true,
        request_created_datetime: true,
        request_updated_datetime: true,
        request_started_at: true,
        request_finished_at: true,
        company: { select: { company_id: true, company_name: true, company_email: true, currency_code: true } },
        contact: { select: { contact_name: true, contact_email: true } },
        staff: { select: { staff_name: true, staff_email: true } }
      }
    }),
    prisma.request_application.findMany({
      where: { request_uuid: requestUuid },
      orderBy: { created_at: "desc" },
      take: 10,
      select: {
        application_uuid: true,
        status: true,
        created_at: true,
        candidate: { select: { candidate_id: true, candidate_name: true, candidate_email: true } }
      }
    }),
    prisma.request_interview.findMany({
      where: { request_uuid: requestUuid },
      orderBy: { interview_at: "desc" },
      take: 10,
      select: {
        request_interview_uuid: true,
        interview_at: true,
        status: true,
        candidate: { select: { candidate_id: true, candidate_name: true, candidate_email: true } }
      }
    }),
    prisma.invitation.findMany({
      where: { request_uuid: requestUuid },
      orderBy: { invitation_created_at: "desc" },
      take: 10,
      select: {
        invitation_uuid: true,
        invitation_status: true,
        invitation_created_at: true,
        candidate: { select: { candidate_id: true, candidate_name: true, candidate_email: true } }
      }
    }),
    prisma.request_activity.findMany({
      where: { request_uuid: requestUuid },
      orderBy: { activity_created_datetime: "desc" },
      take: 8,
      select: {
        activity_uuid: true,
        activity_detail: true,
        activity_created_datetime: true,
        staff: { select: { staff_name: true } }
      }
    }),
    prisma.note.findMany({
      where: { request_uuid: requestUuid },
      orderBy: { note_created_datetime: "desc" },
      take: 8,
      select: { note_uuid: true, note_type: true, note_text: true, note_created_datetime: true }
    }),
    prisma.story.findMany({
      where: { request_uuid: requestUuid },
      orderBy: { story_last_updated_at: "desc" },
      take: 8,
      select: {
        story_uuid: true,
        story_status: true,
        story_last_updated_at: true
      }
    }),
    prisma.request_skill.findMany({
      where: { request_uuid: requestUuid },
      orderBy: { skill: "asc" },
      take: 18,
      select: { skill: true }
    }),
    prisma.suggestion.findMany({
      where: { request_uuid: requestUuid },
      orderBy: { suggestion_datetime: "desc" },
      take: 20,
      select: {
        suggestion_uuid: true,
        suggestion_status: true,
        mail_to_company: true,
        suggestion_datetime: true,
        candidate: {
          select: {
            candidate_id: true,
            candidate_name: true,
            candidate_email: true,
            candidate_hourly_rate: true,
            currency_code: true
          }
        },
        note_suggestion_note_uuidTonote: { select: { note_text: true } }
      }
    })
  ]);
  const requestSkillValues = requestSkills.map((item) => item.skill).filter(Boolean);
  const excludedCandidateIds = [
    ...applications.map((item) => item.candidate?.candidate_id),
    ...interviews.map((item) => item.candidate?.candidate_id),
    ...invitations.map((item) => item.candidate?.candidate_id),
    ...suggestions.map((item) => item.candidate?.candidate_id)
  ].filter((id): id is number => Boolean(id));
  const matchedCandidates = request
    ? await prisma.candidate.findMany({
        where: {
          deleted: 0,
          candidate_status: 10,
          approved: { not: 0 },
          ...(excludedCandidateIds.length ? { candidate_id: { notIn: excludedCandidateIds } } : {}),
          ...(requestSkillValues.length
            ? { candidate_skill: { some: { deleted: 0, skill: { in: requestSkillValues } } } }
            : {})
        },
        orderBy: [{ candidate_updated_at: "desc" }, { candidate_id: "desc" }],
        take: 10,
        select: {
          candidate_id: true,
          candidate_uid: true,
          candidate_name: true,
          candidate_email: true,
          candidate_hourly_rate: true,
          currency_code: true,
          candidate_updated_at: true,
          country: { select: { country_name_en: true } },
          university: { select: { university_name_en: true } },
          candidate_skill: {
            where: requestSkillValues.length ? { deleted: 0, skill: { in: requestSkillValues } } : { deleted: 0 },
            take: 6,
            select: { skill: true }
          }
        }
      })
    : [];
  const suggestedForEmail = suggestions
    .filter((suggestion) => suggestion.candidate)
    .slice(0, 8)
    .map((suggestion) => {
      const candidate = suggestion.candidate;
      return `${candidate?.candidate_name} (${candidate?.candidate_email ?? "no email"}) - ${suggestion.note_suggestion_note_uuidTonote.note_text ?? "Suggested"}`;
    });
  const suggestionEmailHref =
    request?.contact?.contact_email || request?.company?.company_email
      ? `mailto:${request.contact?.contact_email ?? request.company?.company_email}?subject=${encodeURIComponent(
          `Candidates for ${request.request_position_title ?? "your request"}`
        )}&body=${encodeURIComponent(suggestedForEmail.length ? suggestedForEmail.join("\n") : "No suggestions selected yet.")}`
      : null;

  return {
    request,
    requestSkills: requestSkillValues,
    requestSummary: stripHtml(request?.request_job_description || request?.request_additional_info || "No request description imported.").slice(0, 220),
    suggestionEmailHref,
    pipeline: [
      { id: "matches", label: "Matches", value: matchedCandidates.length, note: "Skill-fit candidates" },
      { id: "suggestions", label: "Suggested", value: suggestions.length, note: "Employer-ready candidates" },
      { id: "invited", label: "Invited", value: invitations.length, note: "Candidate outreach" },
      { id: "applications", label: "Applied", value: applications.length, note: "Inbound applications" },
      { id: "interviews", label: "Interviews", value: interviews.length, note: "Evaluation queue" },
      { id: "stories", label: "Stories", value: stories.length, note: "Operational fulfillment" }
    ],
    metrics: [
      { label: "Seats", value: request?.request_number_of_employees ?? 0, note: "Requested employees" },
      { label: "Status", value: request?.request_status ?? "No status", note: `Priority ${request?.request_priority ?? 0}` },
      { label: "Suggestions", value: suggestions.length, note: "Recent suggestions shown" },
      { label: "Invitations", value: invitations.length, note: "Recent invitations shown" }
    ],
    matchedCandidates: matchedCandidates.map((candidate) => {
      const skillMatches = candidate.candidate_skill.map((skill) => skill.skill).filter(Boolean);
      return {
        id: candidate.candidate_id,
        uid: candidate.candidate_uid ?? `#${candidate.candidate_id}`,
        name: candidate.candidate_name,
        email: candidate.candidate_email,
        country: candidate.country?.country_name_en ?? "No country",
        university: candidate.university?.university_name_en ?? "No university",
        rate: formatMoney(candidate.candidate_hourly_rate, candidate.currency_code ?? request?.company?.currency_code ?? "KWD"),
        signal: skillMatches.length ? `${skillMatches.length} skill match${skillMatches.length === 1 ? "" : "es"}` : "Recently active",
        reasons: [
          ...skillMatches.slice(0, 4),
          candidate.country?.country_name_en ? `Country: ${candidate.country.country_name_en}` : null,
          `Updated ${formatDate(candidate.candidate_updated_at)}`
        ].filter((reason): reason is string => Boolean(reason))
      };
    }),
    applications: applications.map((application) => ({
      id: application.application_uuid,
      title: application.candidate?.candidate_name ?? "Unknown candidate",
      subtitle: application.candidate?.candidate_email ?? "No email",
      meta: `Status ${application.status ?? 0} · ${formatDate(application.created_at)}`,
      status: application.status,
      href: application.candidate?.candidate_id
        ? options.candidateHref
          ? options.candidateHref(application.candidate.candidate_id)
          : staffId
            ? `/staff/candidates?candidate=${application.candidate.candidate_id}`
            : `/admin/candidates/${application.candidate.candidate_id}`
        : undefined
    })),
    interviews: interviews.map((interview) => ({
      id: interview.request_interview_uuid,
      title: interview.candidate?.candidate_name ?? "Interview",
      subtitle: interview.candidate?.candidate_email ?? "No email",
      meta: `Status ${interview.status ?? 0} · ${formatDate(interview.interview_at)}`,
      status: interview.status
    })),
    invitations: invitations.map((invitation) => ({
      id: invitation.invitation_uuid,
      title: invitation.candidate?.candidate_name ?? "Invitation",
      subtitle: invitation.candidate?.candidate_email ?? "No email",
      meta: `Status ${invitation.invitation_status ?? 0} · ${formatDate(invitation.invitation_created_at)}`,
      status: invitation.invitation_status
    })),
    suggestions: suggestions.map((suggestion) => ({
      id: suggestion.suggestion_uuid,
      title: suggestion.candidate?.candidate_name ?? "Suggestion",
      subtitle: suggestion.note_suggestion_note_uuidTonote.note_text ?? suggestion.candidate?.candidate_email ?? "No note",
      meta: `Status ${suggestion.suggestion_status ?? 0} · ${suggestion.mail_to_company ? "Mailed" : "Not mailed"} · ${formatDate(suggestion.suggestion_datetime)}`
    })),
    activities: activities.map((activity) => ({
      id: activity.activity_uuid,
      title: activity.staff?.staff_name ?? "Activity",
      subtitle: activity.activity_detail.slice(0, 180),
      meta: formatDate(activity.activity_created_datetime)
    })),
    notes: notes.map((note) => ({
      id: note.note_uuid,
      title: note.note_type ?? "Note",
      subtitle: note.note_text?.slice(0, 180) ?? "Empty note",
      meta: formatDate(note.note_created_datetime)
    })),
    stories: stories.map((story) => ({
      id: story.story_uuid,
      title: `Story ${story.story_uuid.slice(0, 12)}`,
      subtitle: `Status ${story.story_status}`,
      meta: formatDate(story.story_last_updated_at),
      status: story.story_status
    }))
  };
}

function stripHtml(value: string) {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

export async function getStaffWorkspace(staffId: number) {
  const candidateIds = await getCandidateIdsForStaff(staffId);

  const [staff, productionCandidates, productionCompanies, assignedRequests, workHistories, stories, notes, recentRequests, recentStories] =
    await prisma.$transaction([
      prisma.staff.findUnique({
        where: { staff_id: staffId },
        select: {
          staff_name: true,
          staff_email: true,
          staff_job_title: true,
          staff_salary: true,
          staff_salary_currency: true
        }
      }),
      prisma.candidate.count({ where: { deleted: 0, candidate_id: { in: candidateIds.length ? candidateIds : [-1] } } }),
      prisma.company.count({ where: { deleted: 0 } }),
      prisma.request.count({ where: { staff_id: staffId } }),
      prisma.candidate_work_history.count({ where: { staff_id: staffId } }),
      prisma.story.count({ where: { staff_id: staffId } }),
      prisma.note.count({ where: { created_by: staffId } }),
      prisma.request.findMany({
        where: { staff_id: staffId },
        orderBy: { request_created_datetime: "desc" },
        take: 6,
        select: {
          request_uuid: true,
          request_position_title: true,
          request_status: true,
          request_created_datetime: true,
          company: { select: { company_name: true } }
        }
      }),
      prisma.story.findMany({
        where: { staff_id: staffId },
        orderBy: { story_last_updated_at: "desc" },
        take: 6,
        select: {
          story_uuid: true,
          story_status: true,
          story_last_updated_at: true,
          request: { select: { request_position_title: true } }
        }
      })
    ]);

  return {
    staff,
    metrics: [
      { label: "Candidates", value: productionCandidates, note: `${workHistories} assigned to this staff account` },
      { label: "Companies", value: productionCompanies, note: "Employer records in the prod clone" },
      { label: "Assigned Requests", value: assignedRequests, note: "Requests owned by this staff member" },
      { label: "Stories", value: stories, note: `${notes} staff notes · ${formatMoney(staff?.staff_salary, staff?.staff_salary_currency ?? "KWD")}` }
    ],
    requests: recentRequests.map((request) => ({
      id: request.request_uuid,
      title: request.request_position_title ?? "Untitled request",
      subtitle: request.company?.company_name ?? "No company",
      meta: `${request.request_status ?? "No status"} · ${formatDate(request.request_created_datetime)}`
    })),
    stories: recentStories.map((story) => ({
      id: story.story_uuid,
      title: story.request.request_position_title ?? "Story",
      subtitle: `Status ${story.story_status}`,
      meta: formatDate(story.story_last_updated_at)
    }))
  };
}

export async function getCandidateWorkspace(candidateId: number) {
  const [candidate, education, experience, skills, invitations, workingHours, recentInvitations, recentHours] =
    await prisma.$transaction([
      prisma.candidate.findUnique({
        where: { candidate_id: candidateId },
        select: {
          candidate_name: true,
          candidate_email: true,
          candidate_status: true,
          approved: true,
          candidate_hourly_rate: true,
          currency_code: true,
          candidate_created_at: true
        }
      }),
      prisma.candidate_education.count({ where: { candidate_id: candidateId } }),
      prisma.candidate_experience.count({ where: { candidate_id: candidateId } }),
      prisma.candidate_skill.count({ where: { candidate_id: candidateId } }),
      prisma.invitation.count({ where: { candidate_id: candidateId } }),
      prisma.candidate_working_hour.count({ where: { candidate_id: candidateId } }),
      prisma.invitation.findMany({
        where: { candidate_id: candidateId },
        orderBy: { invitation_created_at: "desc" },
        take: 6,
        select: {
          invitation_uuid: true,
          invitation_status: true,
          invitation_created_at: true,
          request: { select: { request_position_title: true, company: { select: { company_name: true } } } }
        }
      }),
      prisma.candidate_working_hour.findMany({
        where: { candidate_id: candidateId },
        orderBy: { date: "desc" },
        take: 6,
        select: {
          candidate_working_hour_uuid: true,
          date: true,
          total_time: true,
          status: true,
          store: { select: { store_name: true } }
        }
      })
    ]);

  return {
    candidate,
    metrics: [
      { label: "Education", value: education, note: "Profile education entries" },
      { label: "Experience", value: experience, note: "Profile experience entries" },
      { label: "Skills", value: skills, note: "Skill tags from the old system" },
      {
        label: "Rate",
        value: formatMoney(candidate?.candidate_hourly_rate, candidate?.currency_code ?? "KWD"),
        note: `${invitations} invitations · ${workingHours} work logs`
      }
    ],
    invitations: recentInvitations.map((invitation) => ({
      id: invitation.invitation_uuid,
      title: invitation.request.request_position_title ?? "Invitation",
      subtitle: invitation.request.company?.company_name ?? "No company",
      meta: `Status ${invitation.invitation_status ?? 0} · ${formatDate(invitation.invitation_created_at)}`
    })),
    hours: recentHours.map((hour) => ({
      id: hour.candidate_working_hour_uuid,
      title: hour.store?.store_name ?? "Work log",
      subtitle: `${hour.total_time ?? 0} minutes`,
      meta: `Status ${hour.status ?? 0} · ${formatDate(hour.date)}`
    }))
  };
}

export async function getCandidateInvitationRows(candidateId: number) {
  const rows = await prisma.invitation.findMany({
    where: { candidate_id: candidateId },
    orderBy: { invitation_created_at: "desc" },
    take: 80,
    select: {
      invitation_uuid: true,
      invitation_status: true,
      invitation_app_seen_at: true,
      invitation_email_seen_at: true,
      invitation_created_at: true,
      request: {
        select: {
          request_position_title: true,
          request_compensation: true,
          company: { select: { company_name: true } }
        }
      }
    }
  });

  return rows.map((row) => ({
    id: row.invitation_uuid,
    role: row.request.request_position_title ?? "Invitation",
    company: row.request.company?.company_name ?? "No company",
    compensation: row.request.request_compensation || "Not set",
    status: `Status ${row.invitation_status ?? 0}`,
    seen: row.invitation_app_seen_at || row.invitation_email_seen_at ? "Seen" : "Unseen",
    created: formatDate(row.invitation_created_at)
  }));
}

export async function getCandidateInvitationDetail(candidateId: number, invitationUuid: string) {
  const [invitation, notes] = await prisma.$transaction([
    prisma.invitation.findFirst({
      where: { invitation_uuid: invitationUuid, candidate_id: candidateId },
      select: {
        invitation_uuid: true,
        invitation_status: true,
        invitation_app_seen_at: true,
        invitation_email_seen_at: true,
        invitation_seen_via: true,
        invitation_created_at: true,
        invitation_updated_at: true,
        request: {
          select: {
            request_uuid: true,
            request_position_title: true,
            request_job_description: true,
            request_compensation: true,
            request_location: true,
            request_number_of_employees: true,
            request_status: true,
            company: { select: { company_name: true, company_email: true } },
            staff: { select: { staff_name: true, staff_email: true } }
          }
        },
        story: {
          select: {
            story_uuid: true,
            story_status: true,
            story_last_updated_at: true
          }
        }
      }
    }),
    prisma.note.findMany({
      where: { invitation_uuid: invitationUuid },
      orderBy: { note_created_datetime: "desc" },
      take: 8,
      select: { note_uuid: true, note_type: true, note_text: true, note_created_datetime: true }
    })
  ]);

  return {
    invitation,
    metrics: [
      { label: "Status", value: invitation ? `Status ${invitation.invitation_status ?? 0}` : "Missing", note: "Legacy invitation status" },
      { label: "Seats", value: invitation?.request.request_number_of_employees ?? 0, note: "Requested headcount" },
      { label: "Seen", value: invitation?.invitation_app_seen_at || invitation?.invitation_email_seen_at ? "Yes" : "No", note: invitation?.invitation_seen_via ?? "No seen source" },
      { label: "Request", value: invitation?.request.request_status ?? "No status", note: "Linked request status" }
    ],
    notes: notes.map((note) => ({
      id: note.note_uuid,
      title: note.note_type ?? "Note",
      subtitle: note.note_text?.slice(0, 180) ?? "Empty note",
      meta: formatDate(note.note_created_datetime)
    }))
  };
}

export async function getCandidateWorkLogRows(candidateId: number) {
  const rows = await prisma.candidate_working_hour.findMany({
    where: { candidate_id: candidateId },
    orderBy: { date: "desc" },
    take: 80,
    select: {
      candidate_working_hour_uuid: true,
      date: true,
      start_time: true,
      end_time: true,
      total_time: true,
      status: true,
      via: true,
      note: true,
      store: { select: { store_name: true, company: { select: { company_name: true } } } }
    }
  });

  return rows.map((row) => ({
    id: row.candidate_working_hour_uuid,
    date: formatDate(row.date),
    store: row.store?.store_name ?? "No store",
    company: row.store?.company?.company_name ?? "No company",
    total: `${row.total_time ?? 0} minutes`,
    status: `Status ${row.status ?? 0}`,
    via: row.via ?? "Not set",
    note: row.note?.slice(0, 120) ?? ""
  }));
}

export async function getCandidateWorkLogDetail(candidateId: number, workLogUuid: string) {
  const [workLog, appeals, feedback] = await prisma.$transaction([
    prisma.candidate_working_hour.findFirst({
      where: { candidate_working_hour_uuid: workLogUuid, candidate_id: candidateId },
      select: {
        candidate_working_hour_uuid: true,
        date: true,
        start_time: true,
        end_time: true,
        total_time: true,
        status: true,
        via: true,
        note: true,
        start_location_lat: true,
        start_location_long: true,
        end_location_lat: true,
        end_location_long: true,
        created_at: true,
        updated_at: true,
        store: { select: { store_name: true, store_location: true, company: { select: { company_name: true } } } }
      }
    }),
    prisma.candidate_working_hour_appeal.findMany({
      where: { candidate_working_hour_uuid: workLogUuid, candidate_id: candidateId },
      orderBy: { created_at: "desc" },
      take: 8,
      select: { appeal_uuid: true, reason: true, status: true, created_at: true }
    }),
    prisma.candidate_work_log_feedback.findMany({
      where: { candidate_working_hour_uuid: workLogUuid, candidate_id: candidateId },
      orderBy: { created_at: "desc" },
      take: 8,
      select: { cwlf_uuid: true, note: true, reason: true, status: true, rating: true, created_at: true }
    })
  ]);

  return {
    workLog,
    metrics: [
      { label: "Total", value: `${workLog?.total_time ?? 0} minutes`, note: "Imported total time" },
      { label: "Status", value: `Status ${workLog?.status ?? 0}`, note: workLog?.via ?? "No source" },
      { label: "Appeals", value: appeals.length, note: "Appeal records linked to this log" },
      { label: "Feedback", value: feedback.length, note: "Feedback records linked to this log" }
    ],
    appeals: appeals.map((appeal) => ({
      id: appeal.appeal_uuid,
      title: `Status ${appeal.status}`,
      subtitle: appeal.reason?.slice(0, 180) ?? "No reason",
      meta: formatDate(appeal.created_at)
    })),
    feedback: feedback.map((item) => ({
      id: item.cwlf_uuid,
      title: item.reason ?? `Status ${item.status ?? 0}`,
      subtitle: item.note?.slice(0, 180) ?? "No note",
      meta: `${item.rating === true ? "Positive" : item.rating === false ? "Negative" : "No rating"} · ${formatDate(item.created_at)}`
    }))
  };
}

export async function getCandidateTransferRows(candidateId: number) {
  const rows = await prisma.transfer_candidate.findMany({
    where: { candidate_id: candidateId, deleted: 0 },
    orderBy: { tc_updated_at: "desc" },
    take: 80,
    select: {
      tc_id: true,
      transfer_id: true,
      candidate_total: true,
      company_total: true,
      transfer_cost: true,
      hours: true,
      minutes: true,
      paid: true,
      currency_code: true,
      tc_updated_at: true,
      company: { select: { company_name: true } },
      store: { select: { store_name: true } },
      transfer: {
        select: {
          transfer_status: true,
          start_date: true,
          end_date: true,
          payment_received_on: true,
          currency_code: true,
        },
      },
    },
  });

  return rows.map((row) => ({
    id: row.tc_id,
    transferId: row.transfer_id,
    company: row.company?.company_name ?? row.store?.store_name ?? "No company",
    period: row.transfer?.start_date
      ? `${formatDate(row.transfer.start_date)} to ${formatDate(row.transfer.end_date)}`
      : "No period",
    hours: `${row.hours ?? 0}h ${row.minutes ?? 0}m`,
    candidateTotal: formatMoney(row.candidate_total, row.currency_code ?? row.transfer?.currency_code ?? "KWD"),
    companyTotal: formatMoney(row.company_total, row.currency_code ?? row.transfer?.currency_code ?? "KWD"),
    cost: formatMoney(row.transfer_cost, row.currency_code ?? row.transfer?.currency_code ?? "KWD"),
    paid: row.paid ? "Paid" : "Unpaid",
    transferStatus: `Transfer status ${row.transfer?.transfer_status ?? 0}`,
    paymentDate: row.transfer?.payment_received_on
      ? formatDate(row.transfer.payment_received_on)
      : "Not received",
    updated: formatDate(row.tc_updated_at),
  }));
}

export async function getCandidateTransferDetail(tcId: number, candidateId: number) {
  const tc = await prisma.transfer_candidate.findFirst({
    where: { tc_id: tcId, deleted: 0 },
    select: {
      tc_id: true,
      candidate_id: true,
      transfer_id: true,
      candidate_total: true,
      company_total: true,
      transfer_cost: true,
      hours: true,
      minutes: true,
      paid: true,
      currency_code: true,
      candidate_hourly_rate: true,
      company_hourly_rate: true,
      bonus: true,
      transfer_benef_name: true,
      transfer_benef_iban: true,
      tc_created_at: true,
      tc_updated_at: true,
      store: { select: { store_name: true } },
      company: { select: { company_name: true } },
      bank: { select: { bank_name: true } },
      transfer: {
        select: {
          transfer_id: true,
          transfer_status: true,
          start_date: true,
          end_date: true,
          payment_received_on: true,
          transfer_created_at: true,
          currency_code: true,
          invoice: {
            where: { deleted: 0 },
            orderBy: { invoice_date: "desc" },
            select: { invoice_id: true, invoice_date: true, invoice_status: true },
          },
        },
      },
    },
  });

  if (!tc || tc.candidate_id !== candidateId) return null;

  const t = tc.transfer;
  const currency = tc.currency_code ?? t?.currency_code ?? "KWD";

  return {
    transferCandidate: {
      id: tc.tc_id,
      transferId: tc.transfer_id,
      company: tc.company?.company_name ?? "No company",
      store: tc.store?.store_name ?? null,
      hours: `${tc.hours ?? 0}h ${tc.minutes ?? 0}m`,
      hourlyRate: formatMoney(tc.candidate_hourly_rate, currency),
      candidateTotal: formatMoney(tc.candidate_total, currency),
      companyTotal: formatMoney(tc.company_total, currency),
      cost: formatMoney(tc.transfer_cost, currency),
      bonus: formatMoney(tc.bonus, currency),
      paid: tc.paid ? "Paid" : "Unpaid",
      beneficiary: tc.transfer_benef_name ?? null,
      iban: tc.transfer_benef_iban ?? null,
      bank: tc.bank?.bank_name ?? null,
      created: formatDate(tc.tc_created_at),
      updated: formatDate(tc.tc_updated_at),
    },
    transfer: t
      ? {
          id: t.transfer_id,
          status: t.transfer_status,
          period: t.start_date
            ? `${formatDate(t.start_date)} to ${formatDate(t.end_date)}`
            : "No period",
          paymentReceived: formatDate(t.payment_received_on),
          created: formatDate(t.transfer_created_at),
        }
      : null,
    invoices: (t?.invoice ?? []).map((inv: { invoice_id: number; invoice_date: Date | null; invoice_status: string | null }) => ({
      id: inv.invoice_id,
      title: `Invoice #${inv.invoice_id}`,
      subtitle: `${inv.invoice_status ?? "No status"}`,
      meta: formatDate(inv.invoice_date),
    })),
  };
}

async function companyIdsForContact(contactUuid: string) {
  const links = await prisma.company_contact.findMany({
    where: { contact_uuid: contactUuid, allow_access: true },
    select: { company_id: true }
  });
  return links.map((link) => link.company_id).filter((id): id is number => Boolean(id));
}

export async function getCompanyWorkspace(contactUuid: string) {
  const contact = await prisma.contact.findUnique({
    where: { contact_uuid: contactUuid },
    select: { contact_name: true, contact_email: true }
  });

  const companyLinks = await prisma.company_contact.findMany({
    where: { contact_uuid: contactUuid },
    take: 20,
    select: {
      company_contact_uuid: true,
      contact_position: true,
      allow_access: true,
      company: {
        select: {
          company_id: true,
          company_name: true,
          company_email: true,
          no_of_active_requests: true,
          company_approved_to_hire: true
        }
      }
    }
  });

  const companyIds = companyLinks.map((link) => link.company?.company_id).filter((id): id is number => Boolean(id));
  const [requests, stores, notes, recentRequests] = await prisma.$transaction([
    prisma.request.count({ where: { company_id: { in: companyIds } } }),
    prisma.store.count({ where: { company_id: { in: companyIds }, deleted: 0 } }),
    prisma.note.count({ where: { company_id: { in: companyIds } } }),
    prisma.request.findMany({
      where: { company_id: { in: companyIds } },
      orderBy: { request_created_datetime: "desc" },
      take: 6,
      select: {
        request_uuid: true,
        request_position_title: true,
        request_status: true,
        request_number_of_employees: true,
        request_created_datetime: true,
        company: { select: { company_name: true } }
      }
    })
  ]);

  return {
    contact,
    metrics: [
      { label: "Companies", value: companyIds.length, note: "Companies linked to this contact" },
      { label: "Requests", value: requests, note: "Hiring requests across linked companies" },
      { label: "Stores", value: stores, note: "Active stores in the account" },
      { label: "Notes", value: notes, note: "Internal/customer notes connected to account" }
    ],
    companies: companyLinks.map((link) => ({
      id: link.company_contact_uuid,
      title: link.company?.company_name ?? "Unknown company",
      subtitle: link.contact_position ?? "Contact",
      meta: link.allow_access ? "Access allowed" : "Access disabled"
    })),
    requests: recentRequests.map((request) => ({
      id: request.request_uuid,
      title: request.request_position_title ?? "Untitled request",
      subtitle: request.company?.company_name ?? "No company",
      meta: `${request.request_status ?? "No status"} · ${request.request_number_of_employees ?? 0} seats`
    }))
  };
}

export async function getCompanyAccountRows(contactUuid: string) {
  const companyIds = await companyIdsForContact(contactUuid);
  const rows = await prisma.company.findMany({
    where: { company_id: { in: companyIds }, deleted: 0 },
    orderBy: { company_updated_at: "desc" },
    take: 80,
    select: {
      company_id: true,
      company_name: true,
      company_email: true,
      no_of_active_requests: true,
      company_approved_to_hire: true,
      company_hourly_rate: true,
      currency_code: true,
      company_updated_at: true,
      country: { select: { country_name_en: true } }
    }
  });

  return rows.map((row) => ({
    id: row.company_id,
    name: row.company_name,
    email: row.company_email ?? "No email",
    country: row.country?.country_name_en ?? "No country",
    requests: row.no_of_active_requests ?? 0,
    status: row.company_approved_to_hire ? "Approved" : "Not approved",
    rate: formatMoney(row.company_hourly_rate, row.currency_code ?? "KWD"),
    updated: formatDate(row.company_updated_at)
  }));
}

export async function getCompanyAccountDetail(contactUuid: string, companyId: number) {
  const companyIds = await companyIdsForContact(contactUuid);
  if (!companyIds.includes(companyId)) {
    return null;
  }

  return getCompanyDetail(companyId);
}

export async function getCompanyRequestRows(contactUuid: string) {
  const companyIds = await companyIdsForContact(contactUuid);
  const rows = await prisma.request.findMany({
    where: { company_id: { in: companyIds } },
    orderBy: { request_updated_datetime: "desc" },
    take: 80,
    select: {
      request_uuid: true,
      request_position_title: true,
      request_status: true,
      request_number_of_employees: true,
      request_compensation: true,
      request_location: true,
      request_updated_datetime: true,
      company: { select: { company_name: true } },
      staff: { select: { staff_name: true } }
    }
  });

  return rows.map((row) => ({
    id: row.request_uuid,
    title: row.request_position_title ?? "Untitled request",
    company: row.company?.company_name ?? "No company",
    owner: row.staff?.staff_name ?? "Unassigned",
    seats: row.request_number_of_employees ?? 0,
    compensation: row.request_compensation || "Not set",
    location: row.request_location ?? "No location",
    status: row.request_status ?? "No status",
    updated: formatDate(row.request_updated_datetime)
  }));
}

export async function getCompanyRequestDetail(contactUuid: string, requestUuid: string) {
  const companyIds = await companyIdsForContact(contactUuid);
  const request = await prisma.request.findFirst({
    where: { request_uuid: requestUuid, company_id: { in: companyIds } },
    select: { request_uuid: true }
  });

  if (!request) {
    return null;
  }

  return getRequestDetail(requestUuid, undefined, { candidateHref: (candidateId) => `/company/requests/${requestUuid}?candidate=${candidateId}` });
}

export async function getInspectorWorkspace(inspectorUuid: string) {
  const [inspector, idRequests, idCards, needsVerification, recentIdRequests] = await prisma.$transaction([
    prisma.inspector.findUnique({
      where: { inspector_uuid: inspectorUuid },
      select: { inspector_name: true, inspector_email: true }
    }),
    prisma.candidate_id_request.count(),
    prisma.candidate_id_card.count({ where: { deleted: 0 } }),
    prisma.candidate.count({ where: { deleted: 0, candidate_civil_need_verification: true } }),
    prisma.candidate_id_request.findMany({
      orderBy: { created_at: "desc" },
      take: 6,
      select: {
        cir_uuid: true,
        status: true,
        candidate_ids: true,
        created_at: true
      }
    })
  ]);

  return {
    inspector,
    metrics: [
      { label: "ID Requests", value: idRequests, note: "Verification request batches" },
      { label: "ID Cards", value: idCards, note: "Stored ID card records" },
      { label: "Needs Verification", value: needsVerification, note: "Candidates flagged for civil ID review" },
      { label: "Mode", value: "Review", note: "Inspector workspace" }
    ],
    requests: recentIdRequests.map((request) => ({
      id: request.cir_uuid,
      title: `Request ${request.cir_uuid.slice(0, 12)}`,
      subtitle: request.candidate_ids ? `${request.candidate_ids.length} chars of candidate ids` : "No candidates",
      meta: `${request.status ?? "pending"} · ${formatDate(request.created_at)}`
    }))
  };
}

export async function getInspectorIdRequestRows() {
  const rows = await prisma.candidate_id_request.findMany({
    orderBy: { created_at: "desc" },
    take: 80,
    select: {
      cir_uuid: true,
      candidate_ids: true,
      status: true,
      rejection_reason: true,
      created_at: true,
      updated_at: true,
      staff_candidate_id_request_created_byTostaff: { select: { staff_name: true } },
      staff_candidate_id_request_updated_byTostaff: { select: { staff_name: true } }
    }
  });

  return rows.map((row) => ({
    id: row.cir_uuid,
    request: row.cir_uuid.slice(0, 18),
    candidates: row.candidate_ids ? row.candidate_ids.split(",").filter(Boolean).length : 0,
    status: row.status ?? "pending",
    createdBy: row.staff_candidate_id_request_created_byTostaff?.staff_name ?? "System",
    updatedBy: row.staff_candidate_id_request_updated_byTostaff?.staff_name ?? "System",
    created: formatDate(row.created_at),
    updated: formatDate(row.updated_at)
  }));
}

function parseCandidateIds(value: string | null | undefined) {
  if (!value) return [];
  return value
    .split(/[^0-9]+/)
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0);
}

export async function getInspectorIdRequestDetail(requestUuid: string) {
  const request = await prisma.candidate_id_request.findUnique({
    where: { cir_uuid: requestUuid },
    select: {
      cir_uuid: true,
      candidate_ids: true,
      status: true,
      rejection_reason: true,
      created_at: true,
      updated_at: true,
      staff_candidate_id_request_created_byTostaff: { select: { staff_name: true, staff_email: true } },
      staff_candidate_id_request_updated_byTostaff: { select: { staff_name: true, staff_email: true } }
    }
  });

  const candidateIds = parseCandidateIds(request?.candidate_ids);
  const candidates = candidateIds.length
    ? await prisma.candidate.findMany({
        where: { candidate_id: { in: candidateIds } },
        select: {
          candidate_id: true,
          candidate_name: true,
          candidate_email: true,
          candidate_civil_need_verification: true,
          candidate_civil_expiry_date: true,
          candidate_status: true,
          approved: true
        }
      })
    : [];

  return {
    request,
    metrics: [
      { label: "Status", value: request?.status ?? "Missing", note: "Legacy ID request status" },
      { label: "Candidates", value: candidateIds.length, note: "IDs included in this batch" },
      { label: "Matched", value: candidates.length, note: "Candidate rows found in prod clone" },
      { label: "Updated", value: formatDate(request?.updated_at), note: request?.staff_candidate_id_request_updated_byTostaff?.staff_name ?? "System" }
    ],
    candidates: candidates.map((candidate) => ({
      id: candidate.candidate_id,
      title: candidate.candidate_name,
      subtitle: candidate.candidate_email,
      meta: `${candidate.candidate_civil_need_verification ? "Needs verification" : "No flag"} · expires ${formatDate(candidate.candidate_civil_expiry_date)}`
    }))
  };
}

export async function getAdminDegreeRows() {
  const rows = await prisma.degree.findMany({
    orderBy: { degree_created_at: "desc" },
    take: 60,
    select: {
      degree_uuid: true,
      degree_name_en: true,
      degree_name_ar: true,
      degree_sort_order: true,
      degree_created_at: true,
      degree_updated_at: true,
      degree_group: { select: { degree_group_name_en: true } }
    }
  });

  return rows.map((row) => ({
    id: row.degree_uuid,
    name_en: row.degree_name_en,
    name_ar: row.degree_name_ar ?? "-",
    group: row.degree_group?.degree_group_name_en ?? "No group",
    sort_order: row.degree_sort_order ?? 0,
    updated: formatDate(row.degree_updated_at)
  }));
}

export async function getAdminExpenseRows() {
  const rows = await prisma.expense.findMany({
    orderBy: { created_at: "desc" },
    take: 60,
    select: {
      expense_uuid: true,
      title: true,
      type: true,
      detail: true,
      amount: true,
      transaction_datetime: true,
      created_at: true,
      updated_at: true,
      admin_expense_created_byToadmin: { select: { admin_name: true } },
      admin_expense_updated_byToadmin: { select: { admin_name: true } }
    }
  });

  return rows.map((row) => ({
    id: row.expense_uuid,
    title: row.title,
    type: row.type,
    detail: row.detail ?? "-",
    amount: row.amount ? Number(row.amount) : 0,
    amount_formatted: formatMoney(row.amount ? Number(row.amount) : 0),
    transaction_datetime: row.transaction_datetime
      ? formatDate(row.transaction_datetime)
      : "-",
    created_by: row.admin_expense_created_byToadmin?.admin_name ?? "-",
    updated_by: row.admin_expense_updated_byToadmin?.admin_name ?? "-",
    created_at: formatDate(row.created_at),
    updated_at: formatDate(row.updated_at)
  }));
}
