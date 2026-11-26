// Known invalid fixture usages must never masquerade as feature failures.
// These deterministic checks supplement, not replace, executing the tests.
export function fixtureIssues(source) {
  const issues=[];
  if (/["'](?:A|B)["']/.test(source))
    issues.push("literal_fixture_id");
  if (/\bfixture\s*\(\s*test\b/.test(source)) issues.push("wrong_test_context");
  if (/\b(?:calls|modelCalls)\s*\(|\b(?:const|let)\s*\{[^}]*\bcalls\b[^}]*\}/.test(source)) issues.push("wrong_calls_api");
  if (/\.index\b|\.runMayaEnabled\b|\.taskId\b|\bevidence\s*\(.*?\)\.revisions\b/.test(source)) issues.push("invented_fixture_fields");
  if (/\bassert\.rejects\s*\(\s*(?:await\s+)?act\s*\(/.test(source))
    issues.push("wrong_sync_assertion");
  if (/\b(?:test|it)\.(?:skip|todo|only)\b|\b(?:skip|todo)\s*:\s*true/.test(source))
    issues.push("disabled_test");
  return issues;
}
export function baselineQuality(report, evidence) {
  // A regression suite can have existing behavior that passes on baseline.
  // Require evidence of at least one actual missing feature, not broken fixtures.
  if (evidence.exitCode!==1 || evidence.fail<1 || evidence.pass+evidence.fail!==4 ||
      /ERR_MODULE_NOT_FOUND|SyntaxError|ERR_ACCESS_DENIED|Invalid requestId|\b(?:TypeError|ReferenceError)\b|calls is not a function|t\.after is not a function|unknown test context/i.test(report) ||
      /# (?:skipped|todo) [1-9]/.test(report)) return false;
  return /ERR_ASSERTION|Outside pilot scope|Only the synthetic pilot is enabled|A supervised agent is already working/i.test(report);
}
