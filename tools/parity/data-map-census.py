#!/usr/bin/env python3
"""SHU-97 static source census. Never imports PHP or connects to a database.

Usage: python tools/parity/data-map-census.py LEGACY_CHECKOUT OUTPUT_DIRECTORY [PLATFORM_CHECKOUT]
The output is evidence for review, not an executable import specification.
"""
import csv
import hashlib
import json
import pathlib
import re
import subprocess
import sys

PIN = 'c2ce255695eabc7e3a0f23b162f5996274234c63'
PLATFORM_PIN = '9ef9259309505ceab9200a6648bf1036b37e24b6'
if len(sys.argv) not in (3, 4):
    raise SystemExit('usage: data-map-census.py LEGACY_CHECKOUT OUTPUT_DIRECTORY [PLATFORM_CHECKOUT]')
root, out = map(pathlib.Path, sys.argv[1:3])
if subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip() != PIN:
    raise SystemExit('Wrong source revision')
if subprocess.check_output(['git', '-C', str(root), 'status', '--porcelain', '--untracked-files=all'], text=True).strip():
    raise SystemExit('Source has modifications or untracked files')
if len(sys.argv) == 4:
    platform = pathlib.Path(sys.argv[3]).resolve()
else:
    try:
        platform = pathlib.Path(subprocess.check_output(
            ['git', '-C', str(pathlib.Path(__file__).resolve().parent), 'rev-parse', '--show-toplevel'],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip())
    except subprocess.CalledProcessError as error:
        raise SystemExit('Cannot locate platform checkout; pass PLATFORM_CHECKOUT explicitly') from error
appendices = platform / 'docs/parity/ui-journeys'
required_appendices = {'candidate-web.md', 'candidate-mobile.md', 'staff.md', 'admin.md', 'employer.md'}
missing_appendices = sorted(name for name in required_appendices if not (appendices / name).is_file())
if missing_appendices:
    raise SystemExit('Missing frontend appendices: ' + ', '.join(missing_appendices))
platform_sources = {}
platform_frontend_text = {}
for name in sorted(required_appendices):
    relative = pathlib.Path('docs/parity/ui-journeys') / name
    try:
        pinned = subprocess.check_output(
            ['git', '-C', str(platform), 'show', f'{PLATFORM_PIN}:{relative.as_posix()}'],
            stderr=subprocess.DEVNULL,
        )
    except subprocess.CalledProcessError as error:
        raise SystemExit(f'Platform pin or appendix unavailable: {PLATFORM_PIN}:{relative}') from error
    current = (platform / relative).read_bytes()
    if current != pinned:
        raise SystemExit(f'Frontend appendix differs from platform pin: {relative}')
    platform_sources[relative.as_posix()] = hashlib.sha256(pinned).hexdigest()
    platform_frontend_text[relative.as_posix()] = pinned.decode('utf-8')

def pinned_text(relative):
    try:
        return subprocess.check_output(
            ['git', '-C', str(root), 'show', f'{PIN}:{relative}'],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except subprocess.CalledProcessError as error:
        raise SystemExit(f'Pinned source file unavailable: {PIN}:{relative}') from error

def pinned_php(directory):
    names = subprocess.check_output(
        ['git', '-C', str(root), 'ls-tree', '-r', '--name-only', PIN, '--', directory],
        text=True,
    ).splitlines()
    return [(name, pinned_text(name)) for name in names
            if name.startswith(directory + '/') and name.endswith('.php')]

migration_sources = pinned_php('console/migrations')
model_sources = pinned_php('common/models')
controller_sources = pinned_php('console/controllers')
cron_source = pinned_text('cron/cronlist')
out.mkdir(parents=True, exist_ok=True)

def tokens(s):
    # Keep character offsets; remove comments only, preserving quoted strings.
    return re.sub(r"('(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\")|(/\*[\s\S]*?\*/|//[^\n]*|\#[^\n]*)",
                  lambda m: m[1] if m[1] else re.sub(r'[^\n]', ' ', m[0]), s)

def end(s, pos):
    pairs = {'(': ')', '[': ']', '{': '}'}
    stack, quote, esc = [pairs[s[pos]]], None, False
    for i in range(pos + 1, len(s)):
        c = s[i]
        if quote:
            if esc: esc = False
            elif c == '\\': esc = True
            elif c == quote: quote = None
        elif c in "'\"": quote = c
        elif c in pairs: stack.append(pairs[c])
        elif c in ')]}':
            if c != stack.pop(): raise ValueError('Unbalanced source')
            if not stack: return i
    raise ValueError('Unterminated source')

def split(s):
    parts, start, i = [], 0, 0
    while i < len(s):
        if s[i] in "'\"":
            q = s[i]; i += 1
            while i < len(s):
                if s[i] == '\\': i += 2; continue
                if s[i] == q: break
                i += 1
        elif s[i] in '([{': i = end(s, i)
        elif s[i] == ',': parts.append(s[start:i].strip()); start = i + 1
        i += 1
    return parts + [s[start:].strip()]

def lit(s):
    m = re.fullmatch(r"['\"]([A-Za-z0-9_%{}.-]+)['\"]", s.strip())
    return m[1].replace('{{%', '').replace('}}', '') if m else None

def receipt(path, s, offset):
    return f'{path}:{s.count(chr(10), 0, offset) + 1}'

tables, gaps, rels, models, history = {}, [], [], {}, []
ops = 'createTable|addColumn|alterColumn|dropColumn|renameColumn|renameTable|dropTable|addForeignKey|dropForeignKey|addPrimaryKey|dropPrimaryKey|createIndex|dropIndex|execute'
for path, raw in migration_sources:
    s = tokens(raw)
    for fn in re.finditer(r'function\s+(?:safeUp|up)\s*\([^)]*\)\s*\{', s):
        a = s.index('{', fn.start()); b = end(s, a)
        body = s[a + 1:b]
        for call in re.finditer(r'->(createCommand|update|delete|insert|batchInsert)\s*\(', body):
            gaps.append([receipt(path,s,a+1+call.start()), 'data mutation/command: '+call[1]+'; not executed or interpreted'])
        for m in re.finditer(r'\$this->(' + ops + r')\s*\(', body):
            op = m[1]; pos = a + 1 + m.start(); ref = receipt(path, s, pos)
            opening = a + 1 + m.end() - 1
            args = split(s[opening + 1:end(s, opening)])
            t = lit(args[0])
            if op == 'execute':
                gaps.append([ref, 'raw SQL or data transform; not interpreted']); continue
            if t is None:
                gaps.append([ref, op + ': dynamic table/name; not interpreted']); continue
            if op in ('addPrimaryKey','dropPrimaryKey','createIndex','dropIndex'):
                rels.append({'kind':op,'owner':lit(args[1]) if len(args)>1 else '', 'name':t,
                             'target':'','keys':args[2] if len(args)>2 else '',
                             'delete':'constraint history; unique='+str(args[3] if len(args)>3 else 'unspecified'),'source':ref})
                continue
            if op in ('addForeignKey', 'dropForeignKey'):
                rels.append({'kind': op, 'owner': lit(args[1]) if len(args)>1 else '', 'name': t,
                             'target': lit(args[3]) if len(args)>3 else '',
                             'keys': ' -> '.join(args[2:5:2]), 'delete': lit(args[5]) if len(args)>5 else 'unspecified', 'source': ref})
                continue
            table = tables.setdefault(t, {})
            if op == 'createTable':
                if not args[1].startswith('['): gaps.append([ref, 'nonliteral column array']); continue
                for entry in split(args[1][1:end(args[1], 0)]):
                    kv = re.match(r"\s*(['\"][^'\"]+['\"])\s*=>\s*([\s\S]+)", entry)
                    if not kv:
                        if entry: gaps.append([ref, 'table constraint/expression; not a column'])
                        continue
                    name = lit(kv[1])
                    if name: table[name] = {'ddl': kv[2], 'source': ref, 'state': 'declared'}
            elif op in ('addColumn', 'alterColumn'):
                name = lit(args[1])
                if name: table[name] = {'ddl': args[2], 'source': ref, 'state': 'declared'}
                else: gaps.append([ref, 'dynamic column'])
            elif op == 'dropColumn':
                name = lit(args[1]); history.append([t, name, ref, 'dropColumn'])
                table.pop(name, None)
            elif op == 'renameColumn':
                old, new = lit(args[1]), lit(args[2]); history.append([t, old, ref, 'rename to '+str(new)])
                if old in table and new: table[new] = table.pop(old); table[new]['source'] = ref
                else: gaps.append([ref, 'rename without known source column'])
            elif op == 'dropTable':
                history.extend([t, name, ref, 'dropTable'] for name in table); tables.pop(t, None)
            elif op == 'renameTable':
                new = lit(args[1])
                if new: tables[new] = tables.pop(t)
                else: gaps.append([ref, 'dynamic rename table'])

for path, raw in model_sources:
    s = tokens(raw)
    stem = pathlib.PurePosixPath(path).stem
    m = re.search(r'function\s+tableName\s*\([^)]*\)\s*\{\s*return\s+([\'\"][^\'\"]+[\'\"])', s)
    if not m: continue
    t = lit(m[1])
    # These models override getDb(): identical table names are NOT identical entities.
    if stem in ('WalletUser','WalletBank','WalletTransfer','BalanceAccount','BalanceTransaction'):
        t = 'wallet.' + t
    models[stem] = t
    if not t: gaps.append([path, 'dynamic model table']); continue
    table = tables.setdefault(t, {})
    for method in re.finditer(r'function\s+(get[A-Z]\w*|beforeDelete|afterDelete|delete|beforeSave|afterSave)\s*\(', s):
        # Method receipts explicitly expose computed fields and side-effect hooks.
        if method[1] in ('beforeDelete','afterDelete','delete','beforeSave','afterSave'):
            gaps.append([receipt(path,s,method.start()),t+': lifecycle hook '+method[1]+' requires semantic review'])
    for prop in re.finditer(r'@property\s+(\S+)\s+\$([A-Za-z_][A-Za-z0-9_]*)', raw):
        typ, name = prop.groups()
        if typ.split('|')[0] not in ('int','integer','string','bool','boolean','float','double','decimal','number','date','datetime','mixed','array'): continue
        row = table.setdefault(name, {'ddl': '', 'source': '', 'state': 'annotation-only'})
        row['annotation'] = typ; row['model_source'] = receipt(path, raw, prop.start())
    for rel in re.finditer(r'\$this->(hasOne|hasMany)\s*\(', s):
        opening = rel.end()-1; args = split(s[opening+1:end(s, opening)])
        rels.append({'kind': rel[1], 'owner': t, 'name': '', 'target': args[0], 'keys': args[1] if len(args)>1 else '',
                     'delete': 'ORM cardinality, not FK/delete guarantee', 'source': receipt(path,s,rel.start())})

clusters = {
 'identity': 'admin admin_token staff staff_token candidate_token company_token contact_token inspector inspector_token manager_token store_manager permission_section permission_sub_section permission_user candidate_email_verify_attempt contact_email_verify_attempt blocked_ip',
 'profile': 'candidate candidate_certificate candidate_education candidate_experience candidate_id_card candidate_id_request candidate_link candidate_skill candidate_tag candidate_video_log candidate_warning degree degree_group major university tag',
 'organizations': 'company store company_contact contact contact_email contact_phone contact_invitation country area mall brand currency company_request',
 'work': 'candidate_work_history candidate_working_date candidate_working_hour candidate_working_hour_appeal candidate_working_hour_appeal_updates candidate_work_log_feedback store_assignment_request staff_work_session staff_leave firing_hitmap',
 'recruitment': 'job job_interest job_skills request request_application request_checklist request_interview request_skill invitation suggestion candidate_eval_dept_ques candidate_eval_ques candidate_evaluation candidate_evaluation_answer interview_evaluation interview_evaluation_note interview_evaluation_note_version exam exam_question exam_question_answer exam_question_choice fulltimer fulltimer_experience fulltimer_skill fulltimer_tags',
 'finance': 'balance_account balance_transaction bank bank_transaction bank_transaction_contact bank_transaction_line_item contract fixed_price_contract hourly_contract monthly_salary_contract transfer transfer_bank_advice transfer_candidate transfer_cost transfer_file transfer_file_entry transfer_rate_excel invoice expense staff_expenses staff_salary staff_salary_process wallet_bank wallet_transfer wallet_user discount discount_category',
 'communication': 'attachment file chat chat_message ticket ticket_attachment ticket_comment ticket_comment_attachment candidate_notification staff_notification mobile_notification email_campaign email_campaign_filter campaign note candidate_note request_activity story story_activity webhook daily_standup_answer daily_standup_question',
 'reporting': 'candidate_stats company_stats',
 'operations': 'setting cron_log mail_log',
}
by_table = {t:c for c, names in clusters.items() for t in names.split()}
by_table.update({t:'finance' for t in tables if t.startswith('wallet.')})

relationship_keys = set()
for relation in rels:
    if relation['kind'] == 'addForeignKey':
        values = re.findall(r"['\"]([^'\"]+)['\"]", relation['keys'].split('->', 1)[0])
    elif relation['kind'] in ('hasOne', 'hasMany'):
        values = re.findall(r"=>\s*['\"]([^'\"]+)['\"]", relation['keys'])
    elif relation['kind'] == 'addPrimaryKey':
        values = re.findall(r"['\"]([^'\"]+)['\"]", relation['keys'])
    else:
        values = []
    relationship_keys.update((relation['owner'], value) for value in values)

def mapping(t, f, row):
    c = by_table.get(t, 'UNVERIFIED-cluster')
    ddl, annotation = row.get('ddl',''), row.get('annotation','')
    base = re.search(r'\$this->(\w+)\(([^)]*)\)', ddl)
    literal_type = re.fullmatch(r"['\"]([A-Za-z0-9_(), .]+)['\"]", ddl)
    typ = base[1] + '(' + base[2] + ')' if base else (literal_type[1] if literal_type else 'literal-or-annotation:' + annotation)
    sensitive = re.search(r'password|auth_key|access_token|refresh_token|reset_token|secret|verification_token|verification_code|(^|_)otp$', f) or t.endswith('_token') or (t.endswith('_verify_attempt') and f=='code')
    protected_identifier = re.search(r'(^|_)civil_id$', f)
    key = re.search(r'(^id$|_id$|_uuid$|^uuid$|^currency_code$)', f)
    unverified_id_reference = f.endswith('_id') and 'primaryKey' not in ddl and (t, f) not in relationship_keys
    if sensitive: target, policy = 'ExcludedCredential', 'DROP; synthetic auth only'
    elif protected_identifier: target, policy = 'ProtectedIdentifier', 'replace with dataset-local synthetic value; never use for identity joins or public hashes'
    elif unverified_id_reference: target, policy = 'UnverifiedReference', 'name-shaped reference only; no PK/FK/ORM evidence; HOLD before joining'
    elif key: target, policy = 'SourceRef', 'namespace by system/table; exact join; no email matching'
    elif f in ('candidateUnreadCount','contactUnreadCount','staffUnreadCount','company_status'): target, policy = 'DerivedValue', 'recompute from target facts; not an imported scalar'
    elif f in ('total_time','total_approved','total_pending','total_rejected') and t.startswith('candidate_working'): target, policy = 'DurationSeconds', 'integer seconds; preserve null/open; recompute aggregates separately'
    elif f in ('hours','minutes','seconds') and t=='transfer_candidate': target, policy = 'ExactDecimal', 'preserve original unit; convert to exact duration; no float multiplication'
    elif f in ('candidate_hourly_rate','company_hourly_rate','candidate_total','company_total','transfer_cost','total','amount','balance','sub_total','total_tax','unit_amount','tax_amount','line_amount','candidate_bonus') and by_table.get(t)=='finance': target, policy = 'MoneyDecimal', 'exact coefficient/scale and currency; snapshots immutable; unresolved currency HOLD'
    elif f in ('candidate_hourly_rate','company_hourly_rate','staff_hourly_rate','fulltimer_current_salary','fulltimer_expected_salary'): target, policy = 'MoneyDecimal', 'exact rate/amount with explicit currency and effective period'
    elif f in ('total_candidate','no_of_active_requests','no_of_signups','no_of_clicks') or f.endswith('UnreadCount'): target, policy = 'DerivedCount', 'recompute from imported canonical rows; compare to source separately'
    elif re.search(r'photo|resume|licence|license_file|file_path|file_s3_path|pdf_cv|logo|^image$|^file$|^candidate_video$|thumbnail', f): target, policy = 'DocumentReference', 'substitute bytes; private owner/type/version; unsupported type HOLD'
    elif re.search(r'email|phone|name|iban|address|intro|objective|note|detail|message|description|comment|answer|recording|website|payload|output|^ip_|^data$|^from$|^to$|(^|_)url(_|$)', f): target, policy = 'SensitiveText', 'replace; never copy free text or destination; no identity joins'
    elif re.search(r'lat|long', f): target, policy = 'Coordinate', 'synthetic coordinates; preserve paired start/end and valid/missing classes'
    elif re.search(r'birth|expiry|^date$|_date$|_on$', f) or 'date()' == typ: target, policy = 'LocalDate', 'preserve relative dates with coherent synthetic calendar; invalid date HOLD'
    elif re.search(r'_at$|datetime|_time$', f) or 'datetime' in typ.lower(): target, policy = 'TemporalValue', 'preserve source unit/zone; zero/ambiguous value HOLD; see time overrides'
    elif re.search(r'amount|total|cost|rate|salary|price|balance|commission|bonus|deduction|expense', f): target, policy = 'ExactDecimal', 'synthetic balanced amounts; currency/scale validation; counter overrides apply'
    elif re.search(r'status|type|^via$|gender|flag|deleted|approved|is_|has_', f): target, policy = 'SourceEnum', 'explicit per-domain mapping; unknown value HOLD; never grants'
    elif any(x in typ.lower() for x in ('integer','primarykey','int','boolean')): target, policy = 'ExactInteger', 'synthetic bounded values; range and null checks'
    elif any(x in typ.lower() for x in ('decimal','float','double','number')): target, policy = 'ExactDecimal', 'preserve decimal string; reject loss of precision'
    else: target, policy = 'SourceText', 'synthetic replacement; semantic review before import'
    # These are proposals, not a claim that a business-domain package exists.
    contract = c + '.' + ''.join(x.title() for x in t.split('_')) + '.' + f
    return c, typ, contract, target, policy

rows = []
for t, fields in sorted(tables.items()):
    for f, r in sorted(fields.items()):
        c, typ, contract, target, policy = mapping(t,f,r)
        rows.append([c,t,f,r['state'],typ,'notNull' in r.get('ddl',''),'primaryKey' in r.get('ddl',''),'unique' in r.get('ddl',''),r['source'],r.get('model_source',''),contract,target,policy,'PROPOSED; runtime schema and semantic acceptance unverified'])

def write_csv(name, header, rows):
    with (out/name).open('w',newline='') as f:
        w=csv.writer(f, lineterminator='\n');w.writerow(header);w.writerows(rows)

write_csv('fields.csv', ['cluster','source_entity','source_field','evidence_status','declared_type','declared_not_null','inline_primary_key','inline_unique','ddl_receipt','annotation_receipt','proposed_contract_field','proposed_type','handling','target_status'], rows)
write_csv('relationships.csv', ['kind','owner','name','target','keys','delete','source'], [[r[k] for k in ('kind','owner','name','target','keys','delete','source')] for r in rels])
write_csv('source-gaps.csv', ['receipt','limitation'], gaps)
write_csv('retired-fields.csv', ['entity','field','receipt','operation'], history)
jobs=[]
cron=cron_source.splitlines()
for path, raw in controller_sources:
    s=tokens(raw)
    controller=pathlib.PurePosixPath(path).stem.removesuffix('Controller')
    for m in re.finditer(r'public\s+function\s+(action\w+)\s*\(',s):
        route=re.sub(r'(?<!^)([A-Z])',r'-\1',controller).lower()+'/'+re.sub(r'(?<!^)([A-Z])',r'-\1',m[1][6:]).lower()
        schedules=[f'cron/cronlist:{i+1}' for i,line in enumerate(cron) if not line.lstrip().startswith('#') and (route in line or (route=='algolia/index' and 'yii algolia ' in line))]
        jobs.append([route,receipt(path,s,m.start()),';'.join(schedules) or 'not in checked cron file','DISABLED in all fixture/import runs; semantic disposition in README'])
write_csv('jobs.csv',['console_route','source','schedule_receipts','plan'],jobs)
frontend=[]
for name in sorted(required_appendices):
    p = appendices / name
    relative = p.relative_to(platform).as_posix()
    for i,line in enumerate(platform_frontend_text[relative].splitlines()):
        if not line.startswith('|'):continue
        cells=re.split(r'(?<!\\)\|',line)[1:-1]
        if not cells:continue
        ids=re.findall(r'(?:CAND|STAFF|ADMIN|EMP|MOB)-(?:FO|GAP|G)-\d+',cells[0])
        for id_ in ids:
            frontend.append([p.stem,id_,str(p.relative_to(platform))+':'+str(i+1),cells[1].strip() if len(cells)>1 else '',cells[2].strip() if len(cells)>2 else '',
                             'INVENTORY-ONLY unless explicitly reverified in README; no draft claim promoted to fact',
                             'synthetic scenario with fresh server authorization; replace PII/objects; no cached-token or provider-state import'])
if not frontend:
    raise SystemExit('Frontend census is empty; refusing a vacuous manifest')
frontend_keys = [(row[0], row[1]) for row in frontend]
if len(frontend_keys) != len(set(frontend_keys)):
    raise SystemExit('Duplicate frontend inventory row ID within one appendix')
write_csv('frontend-effects.csv',['app','inventory_row','inventory_receipt','reported_area','reported_effect','evidence_status','test_data_plan'],frontend)
manifest = {'source': PIN, 'platform_source': PLATFORM_PIN, 'platform_frontend_sources': platform_sources,
            'method':'lexical literal Yii up/safeUp migration census plus scalar model annotations; no execution',
            'entities':len(tables),'fields':len(rows),'annotation_only':sum(r[3]=='annotation-only' for r in rows),
            'relationship_receipts':len(rels),'source_gaps':len(gaps),'console_actions':len(jobs),'frontend_inventory_rows':len(frontend),
            'unassigned_entities':sorted(set(tables)-set(by_table)),
            'cluster_fields':{c:sum(r[0]==c for r in rows) for c in sorted(clusters)},
            'files':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(out.glob('*.csv'))}}
(out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps(manifest,indent=2))
