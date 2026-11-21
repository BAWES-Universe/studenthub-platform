<?php
// Runs the legacy ABK workbook export block (admin TransferController::actionDownloadPaymentAdviceForAbk,
// the PhpExcel::export([...]) call) verbatim, through the legacy common\components\PhpExcel helper,
// against synthetic in-memory models. No DB, no S3, no real data.
$legacy = $argv[1]; $vendor = $argv[2]; $outDir = $argv[3];
require $vendor . '/autoload.php';
require $vendor . '/yiisoft/yii2/Yii.php';
Yii::setAlias('@common', "$legacy/common");
Yii::setAlias('@admin', "$legacy/admin");
Yii::setAlias('@company', "$legacy/company");
$common = require "$legacy/common/config/main.php";
new yii\console\Application([
  'id' => 'abk-harness', 'basePath' => $outDir, 'vendorPath' => $vendor,
  'language' => $common['language'], 'timeZone' => $common['timeZone'],
  'components' => ['i18n' => $common['components']['i18n'], 'db' => ['class' => 'yii\db\Connection', 'dsn' => 'sqlite::memory:']],
]);

// Synthetic subclasses: only attributes() is overridden so no table schema is read.
class SynBank extends \common\models\Bank { public function attributes() { return ['bank_id','bank_iban_code','bank_swift_code','bank_code_abk']; } }
class SynCandidate extends \admin\models\Candidate { public function attributes() { return ['candidate_id','bank_id','bank_account_name','candidate_iban']; } }
class SynTC extends \admin\models\TransferCandidate { public function attributes() { return ['tc_id','candidate_id','bank_id','transfer_benef_name','transfer_benef_iban','candidate_total','currency_code']; } }

function mk($cls, $a) { $m = new $cls(); foreach ($a as $k => $v) $m->setAttribute($k, $v); $m->setOldAttributes($m->getAttributes()); return $m; }
$banks = [
  'A' => mk('SynBank', ['bank_id'=>901,'bank_iban_code'=>'ABKK','bank_swift_code'=>'SYNAKWKW','bank_code_abk'=>'7']),
  'B' => mk('SynBank', ['bank_id'=>902,'bank_iban_code'=>'SYNB','bank_swift_code'=>'SYNBKWKW','bank_code_abk'=>'42']),
];
// MySQL PDO returns DECIMAL/INT as strings; mirror that.
$rows = [
  // within-bank, extracted account keeps a leading zero
  ['tc'=>['tc_id'=>'101','candidate_id'=>'1','bank_id'=>'901','transfer_benef_name'=>'SYNTHETIC SNAPSHOT A','transfer_benef_iban'=>'KW00ABKK0000000000001234567890','candidate_total'=>'123.450','currency_code'=>'KWD'],
   'c'=>['candidate_id'=>'1','bank_id'=>'901','bank_account_name'=>'SYNTHETIC PERSON A','candidate_iban'=>'KW00ABKK0000000000001234567890'], 'bank'=>'A'],
  // within-bank, extracted account has no leading zero (numeric-looking)
  ['tc'=>['tc_id'=>'102','candidate_id'=>'2','bank_id'=>'901','transfer_benef_name'=>'SYNTHETIC SNAPSHOT B','transfer_benef_iban'=>'KW00ABKK0000000009123456789012','candidate_total'=>'80.000','currency_code'=>'KWD'],
   'c'=>['candidate_id'=>'2','bank_id'=>'901','bank_account_name'=>'SYNTHETIC PERSON B','candidate_iban'=>'KW00ABKK0000000009123456789012'], 'bank'=>'A'],
  // local transfer to another bank, full IBAN, name formula-like
  ['tc'=>['tc_id'=>'103','candidate_id'=>'3','bank_id'=>'902','transfer_benef_name'=>'SYNTHETIC SNAPSHOT C','transfer_benef_iban'=>'KW00SYNB0000000000009876543210','candidate_total'=>'7.5','currency_code'=>'KWD'],
   'c'=>['candidate_id'=>'3','bank_id'=>'902','bank_account_name'=>'=SYNTHETIC+1','candidate_iban'=>'KW00SYNB0000000000009876543210'], 'bank'=>'B'],
];
$payableCandidate = [];
foreach ($rows as $r) {
  $c = mk('SynCandidate', $r['c']); $c->populateRelation('bank', $banks[$r['bank']]);
  $t = mk('SynTC', $r['tc']); $t->populateRelation('candidate', $c); $t->populateRelation('bank', $banks[$r['bank']]);
  $payableCandidate[] = $t;
}
if (($argv[4] ?? '') === 'empty') $payableCandidate = [];

// Extract the export call verbatim from the legacy action.
$src = file_get_contents("$legacy/admin/modules/v1/controllers/TransferController.php");
$a = strpos($src, 'public function actionDownloadPaymentAdviceForAbk()');
$s = strpos($src, '\common\components\PhpExcel::export([', $a);
$e = strpos($src, ']);', strpos($src, '/*[', $s)) + 3;   // closing of export([ ... ]);
$block = substr($src, $s, $e - $s);
$hash = hash('sha256', $block);
// Single substitution: the hard-coded debit account constant is replaced with a synthetic
// value of the same shape (13 digits, leading zero) so no real account leaves the repo.
$block = preg_replace('/(\'DEBIT ACCOUNT\'.*?return ")\d+(";)/s', '${1}0999999999001${2}', $block, 1, $n);
if ($n !== 1) { fwrite(STDERR, "debit constant not found\n"); exit(2); }
$fileName = $argv[5] ?? 'T1V1.xlsx'; $savePath = $outDir;
eval('namespace admin\modules\v1\controllers; use admin\models\TransferCandidate; use Yii; ' . $block);
fwrite(STDERR, "export block sha256 (before substitution): $hash\n");
