// Read-only revision-bound view. Never infer credentials, quota, runtime or approval from configuration.
const defaultHandbook = {repo:'appsworld2027/parent-plus-ai-org',ref:'main'};
const model = (v, provider) => typeof v === 'string' && v.startsWith(provider + '/') && /^[a-z0-9][a-z0-9._/-]+$/i.test(v.slice(provider.length+1));
const unique = v => Array.isArray(v) && v.length > 0 && new Set(v).size === v.length;
function locate(readManifest) {
 let manifest;
 try { manifest = JSON.parse(readManifest()); }
 catch (err) { if (err.code === 'ENOENT') return defaultHandbook; throw err; }
 if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw Error('Invalid product manifest');
 const h = manifest.handbook ?? {};
 if (!h || typeof h !== 'object' || Array.isArray(h)) throw Error('Invalid handbook');
 const repo = h.repo ?? defaultHandbook.repo, ref = h.ref ?? defaultHandbook.ref;
 if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo) || typeof ref !== 'string' || !ref.trim()) throw Error('Invalid handbook location');
 return {repo,ref};
}
export async function readWorkerPolicy({ghJson,readManifest}) {
 try {
  const {repo,ref} = locate(readManifest);
  const commit = await ghJson('repos/'+repo+'/commits/'+encodeURIComponent(ref));
  const sha = commit?.sha;
  if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)) throw Error('Revision not verified');
  const file = await ghJson('repos/'+repo+'/contents/governance/AUTONOMY_POLICY.json?ref='+sha);
  if (file?.encoding !== 'base64' || typeof file.content !== 'string') throw Error('Policy content unavailable');
  const e = JSON.parse(Buffer.from(file.content,'base64').toString('utf8'))?.execution, p = e?.providerPolicy;
  const builders = p?.builderPreference, evaluation = p?.evaluationBuilderPreference, reviewer = p?.independentReviewer;
  if (e?.allowPaidFallback !== false || e?.allowedEngines?.length !== 1 || e.allowedEngines[0] !== 'free' ||
      p?.mode !== 'free-only' || p.paidFallback !== false || p.subscriptionAuthentication !== false ||
      p.nvidiaReviewerEnabled !== false || p.nvidiaMode !== 'supervised-synthetic-evaluation-only' ||
      p.reviewerModelFamilyMustDifferFromBuilder !== true ||
      !unique(builders) || !builders.every(m=>model(m,'groq')) ||
      !unique(evaluation) || !evaluation.every(m=>model(m,'groq')||model(m,'nvidia')) ||
      !model(reviewer,'groq') || evaluation.includes(reviewer) || builders.includes(reviewer) ||
      !builders.every(m=>evaluation.includes(m)) || e.freeModels?.builder !== builders[0] ||
      e.freeModels?.builderPreferred !== builders[0] || e.freeModels?.reviewer !== reviewer ||
      !model(e.freeModels?.nvidiaEvaluationBuilder,'nvidia') || !evaluation.includes(e.freeModels.nvidiaEvaluationBuilder)) {
   throw Error('Unsupported worker policy');
  }
  return {status:'configured-unverified',repo,ref,sha,engine:'free',builders:[...builders],reviewer,evaluation:[...evaluation],nvidiaMode:p.nvidiaMode};
 } catch { return {status:'unavailable'}; }
}
export function workerPolicyNote(p) {
 if (p.status !== 'configured-unverified') return 'Authoritative worker policy unavailable; background routes are unknown. Local Team recommendations do not substitute for it.';
 return 'Configured background worker (not verified at runtime): engine '+p.engine+'; builder preference '+p.builders.join(', ')+'; independent reviewer '+p.reviewer+'; supervised evaluation only '+p.evaluation.join(', ')+'. Source '+p.repo+' @ '+p.sha+' ('+p.ref+'). Credentials, quota, qualification and execution are not verified.';
}
