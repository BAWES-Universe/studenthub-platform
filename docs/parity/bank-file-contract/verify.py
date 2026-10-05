#!/usr/bin/env python3
"""Read-only source receipt and synthetic document checks. Never runs legacy PHP.
Usage: python verify.py LEGACY_CHECKOUT ADMIN_UI_CHECKOUT
This is not a production serializer/importer, provider conformance test or verdict.
"""
import datetime
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
from decimal import Decimal, InvalidOperation

HERE = Path(__file__).resolve().parent

def require(condition, message):
    if not condition:
        raise ValueError(message)

def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args])

def money(value):
    require(re.fullmatch(r'\d{1,7}\.\d{3}', value) is not None, 'invalid exact payment decimal')
    return Decimal(value)

def main():
    require(len(sys.argv) == 3, 'provide legacy and admin-ui source checkouts')
    evidence = json.loads((HERE/'evidence.json').read_text())
    platform = Path(git(HERE, 'rev-parse', '--show-toplevel').decode().strip())
    roots = {'P': Path(sys.argv[1]), 'U': Path(sys.argv[2]), 'T': platform}
    by_repo = {v['repository']: roots[k] for k,v in evidence['pins'].items()}
    receipts = evidence['receipts']
    ids = [r['id'] for r in receipts]
    require(len(ids) == len(set(ids)) and len(ids) > 0, 'missing/duplicate source receipts')
    for r in receipts:
        data = git(by_repo[r['repository']], 'show', r['revision']+':'+r['path'])
        rows = data.splitlines(keepends=True)
        require(1 <= r['start'] <= r['end'] <= len(rows), 'source range invalid: '+r['id'])
        blob = hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
        excerpt = hashlib.sha256(b''.join(rows[r['start']-1:r['end']])).hexdigest()
        require(blob == r['blob_sha'] and excerpt == r['excerpt_sha256'], 'source changed: '+r['id'])
        require(r['url'] == f"https://github.com/{r['repository']}/blob/{r['revision']}/{r['path']}#L{r['start']}-L{r['end']}", 'incorrect source URL')
    doc = (HERE/'README.md').read_text()
    require(set(re.findall(r'\bE\d{2}\b', doc)) <= set(ids), 'unresolved document citation')
    pack = json.loads((HERE/'fixtures.json').read_text())
    require(
        pack['synthetic_only'] is True
        and pack['source_data_copied'] is False
        and pack['bank_formats_invented'] is False,
        'fixture provenance',
    )
    formats = {f['id']: f for f in pack['formats']}
    require(set(formats) == {'legacy-s123','legacy-hdt-advice','legacy-abk-fhr-apo','legacy-abk-workbook','aub-results','kfh-results','bank-statement','manual-results'}, 'format scope drift')
    lines = pack['input_lines']
    require(len({x['tc_id'] for x in lines}) == len(lines), 'duplicate input line')
    total = sum(money(x['amount']) for x in lines)
    require(total == Decimal('30.130'), 'input totals disagree')
    for f in formats.values():
        require(set(f['evidence']) <= set(ids), 'unresolved fixture source')
        if f['kind'] == 'text':
            data = (HERE/f['file']).read_bytes()
            require(data == f['output'].encode('utf-8'), 'text bytes differ')
            require(hashlib.sha256(data).hexdigest() == f['sha256'], 'text digest differs')
            require(not data.startswith(b'\xef\xbb\xbf') and b'\r' not in data, 'fixture BOM/EOL changed')
            require(len(f['rows']) == f['record_count'] == 2, 'text row count')
            require(all(len(row)==len(f['fields']) for row in f['rows']), 'text field width')
            text = data.decode('utf-8')
            require(not any(c in text for c in ('\v','\f','\x1c','\x1d','\x1e','\x85','\u2028','\u2029')), 'fixture non-LF separator')
            raw = text.removesuffix('\n').split('\n')
            if f['id'] == 'legacy-s123':
                require(len(raw)==4 and len(f['fields'])==33, 'S123 framing')
                require(raw[0]=='S1,00000000,,MXD,M,,29/02/2028,29022028-01', 'S1 date/envelope')
                require(all(raw[i+1] == ','.join(row)+',' for i,row in enumerate(f['rows'])), 'S2 bytes')
                require(raw[-1]=='S3,2,30.130' and not data.endswith(b'\n'), 'S3 totals')
                amount_index=2
            elif f['id'] == 'legacy-hdt-advice':
                require(len(raw)==4 and len(f['fields'])==7, 'HDT framing')
                require(raw[0]=='H,T900001V1,1835395200', 'H frozen clock')
                require(all(raw[i+1]==','.join(row)+',' for i,row in enumerate(f['rows'])), 'D bytes')
                require(raw[-1]=='T,2,30.130' and not data.endswith(b'\n'), 'T totals')
                amount_index=6
            else:
                require(len(raw)==3 and len(f['fields'])==26, 'FHR/APO framing')
                require(raw[0]=='FHR,T900001V1,02/29/2028,2,30.130;', 'FHR totals/date')
                require(all(raw[i+1]==','.join(row)+';' for i,row in enumerate(f['rows'])), 'APO bytes')
                require(data.endswith(b'\n') and 'تجريبي' in data.decode('utf-8'), 'Arabic/final LF')
                require(f['rows'][0][14]=='WIB' and f['rows'][1][14]=='KASIP', 'ABK/local branches')
                amount_index=13
            require(sum(money(row[amount_index]) for row in f['rows'])==total==money(f['total']), 'line/header total mismatch')
            require(f['partial_rejection']['provider_format'] is None and f['partial_rejection']['paid_updates']==[], 'invented provider response')
        elif f['kind'] == 'decoded-import-cells':
            h=f['header_row']; keys=f['rows'][h-1]
            require(len(keys)==len(set(keys)) and all(len(r)==len(keys) for r in f['rows']), 'workbook matrix width/keys')
            require(len(f['rows'])-h==f['record_count'], 'workbook record count')
            require(f['native_workbook_fidelity']=='NOT_ESTABLISHED','false workbook proof')
        else:
            require(len(f['column_attributes'])==17 and all(len(r)==17 for r in f['rows']), 'ABK column count')
            require(f['header_values'] is None, 'invented resolved workbook labels')
            require(sum(money(r[11]) for r in f['rows'])==total, 'ABK workbook totals')
    a=formats['aub-results']; keys=a['rows'][1]
    arows=[dict(zip(keys,r)) for r in a['rows'][2:]]
    require(sum(money(r['Credit Amount']) for r in arows if r['Status']=='SUCCESS')==Decimal('10.125'), 'partial success total')
    require(sum(money(r['Credit Amount']) for r in arows if r['Status']=='FAIL')==Decimal('20.005'), 'partial rejection total')
    require(a['proposed']['accepted_total']=='10.125' and a['proposed']['rejected']==['910002'], 'partial disposition drift')
    s=formats['bank-statement']; rows=s['rows'][8:]
    require(sum(money(r[1]) for r in rows[:2])==Decimal('29.130') and total-Decimal('29.130')==money(s['proposed']['discrepancy']), 'statement mismatch missing')
    for c in pack['money_cases']:
        try: money(c['value']); accepted=True
        except (ValueError,InvalidOperation): accepted=False
        require(accepted==c['proposed'].startswith('ACCEPT_'), 'money boundary: '+c['id'])
    for c in pack['date_cases']:
        try: datetime.date.fromisoformat(c['value']); valid=True
        except ValueError: valid=False
        require(valid==c['valid'], 'date boundary')
    for c in pack['malformed_cases']:
        require(c['format'] in formats and c['proposed'].startswith('HOLD_'), 'malformed disposition')
        if 'output' in c:
            require(c['output'] != formats[c['format']]['output'] and c['input_field'] in c['output'], 'malformed text not materialized')
        else:
            h=formats[c['format']]['header_row']
            require(len(c['rows'][h-1])!=len(c['rows'][h]), 'malformed header not materialized')
    # Source-based structural controls, not production behavior execution.
    legacy=roots['P']; pin=evidence['pins']['P']['revision']
    src=git(legacy,'show',pin+':common/models/TransferCandidate.php').decode().splitlines()
    keys=re.findall(r"'([^']+)'\s*=>",'\n'.join(src[820:855]))
    require(keys==formats['legacy-s123']['fields'], 'S2 source column order mismatch')
    src=git(legacy,'show',pin+':common/models/TransferFile.php').decode().splitlines()
    consumed=set(re.findall(r"\$value\['([^']+)'\]",'\n'.join(src[480:552])))
    require(consumed==set(formats['aub-results']['rows'][1]), 'AUB consumed keys mismatch')
    # Do not print synthetic accounts, row contents, source excerpts or bank responses.
    print(f"Verified {len(receipts)} pinned receipts; 8 fixture shapes; 3 text byte files; {len(pack['malformed_cases'])} malformed, {len(pack['money_cases'])} money, {len(pack['date_cases'])} date cases.")
    print('Static consistency only. Legacy runtime, native workbook fidelity and provider acceptance NOT tested. Independent review pending.')

if __name__ == '__main__':
    main()
