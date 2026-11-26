// Direct source is an artifact, not a model's claim that work was completed.
// The runner binds its validated output to the actual incoming artifact hash.
const fence = /^\x60\x60\x60(?:javascript|js)?[ \t]*\r?\n([\s\S]+)\r?\n\x60\x60\x60$/i;
const reject = issue => ({ receipt: null, issues: [issue] });
export function parseDeliveryResponse(text, inputHash, direct = false) {
  if (typeof text !== "string" || !text.trim()) return reject("missing_source");
  const raw = text.trim();
  if (direct?.kind === "patch" && direct.slots) {
    let edits;
    try { edits=JSON.parse(raw.replace(/^\x60\x60\x60(?:json)?\s*/i,"").replace(/\s*\x60\x60\x60$/,"")); }
    catch { return reject("invalid_json"); }
    const slots=direct.slots;
    if (!edits || typeof edits!=="object" || Array.isArray(edits) ||
        Object.keys(edits).length!==slots.length || slots.some(s=>!Object.hasOwn(edits,s.id)))
      return reject("invalid_edit_slots");
    const ranges=[];
    for(const {id,old} of slots){
      const replacement=edits[id];
      if(typeof replacement!=="string"||!replacement.trim()||replacement===old||
         replacement.length>1200||replacement.split("\n").length>12||
         replacement.endsWith("\n"))return reject("invalid_edit_slots");
      const pos=direct.old.indexOf(old);
      if(pos<0||pos!==direct.old.lastIndexOf(old))return reject("invalid_edit_slots");
      ranges.push({pos,end:pos+old.length,replacement});
    }
    ranges.sort((a,b)=>b.pos-a.pos);
    let source=direct.old, prev=source.length;
    for(const r of ranges){
      if(r.end>prev)return reject("invalid_edit_slots");
      source=source.slice(0,r.pos)+r.replacement+source.slice(r.end);prev=r.pos;
    }
    return {receipt:{inputArtifactHash:inputHash,verdict:"COMPLETE",
      summary:"Runtime applied "+slots.length+" model-authored bounded edits for "+direct.id+". Syntax and tests are separate gates.",
      receiptOrigin:"studio-runtime",editCount:slots.length,source},issues:[]};
  }
  if (direct?.kind === "patch") {
    const match = raw.match(fence);
    if (!match || /(?:^|\n)\x60\x60\x60/.test(match[1])) return reject("invalid_source_frame");
    const source = match[1];
    if (source.trim().length < 20 || source.length > 12000) return reject("source_bounds");
    // This is runner-generated metadata, not a model-written acknowledgement.
    return {receipt:{inputArtifactHash:inputHash,verdict:"COMPLETE",
      summary:"Runtime bound returned source to "+direct.id+" ("+direct.target+"); syntax and tests are separate gates.",
      receiptOrigin:"studio-runtime",source},issues:[]};
  }
  let p;
  try {
    // Accept a plain or fenced receipt and, for criterion authors, a separate
    // source fence. Keep strict hash, verdict and substantive summary checks.
    const framed = direct && raw.match(/^(\{[\s\S]*?\}|\x60\x60\x60json\s*[\s\S]*?\x60\x60\x60)\s*(\x60\x60\x60(?:javascript|js)?\r?\n[\s\S]+\r?\n\x60\x60\x60)$/i);
    const json = (framed?framed[1]:raw).trim().replace(/^\x60\x60\x60(?:json)?\s*/i,"").replace(/\s*\x60\x60\x60$/,"");
    p = JSON.parse(json);
    if (framed) p.source = framed[2].match(fence)?.[1];
  } catch { return reject("invalid_json"); }
  if (p?.inputArtifactHash !== inputHash) return reject("input_hash_mismatch");
  if (!["COMPLETE","APPROVE","CHANGES"].includes(p.verdict)) return reject("invalid_verdict");
  if (typeof p.summary !== "string" || !p.summary.trim()) return reject("missing_summary");
  if (/^REPLACE with evidence, gaps and file names\.?$/i.test(p.summary.trim())) return reject("placeholder_summary");
  if (direct && p.verdict === "COMPLETE") {
    if (typeof p.source !== "string" || p.source.length < 60 || p.source.length > 12000) return reject("source_bounds");
    if (!p.source.includes(direct.id) || !/\btest\s*\(/.test(p.source)) return reject("missing_criterion_test");
  }
  return {receipt:{inputArtifactHash:p.inputArtifactHash,verdict:p.verdict,summary:p.summary,
    ...(direct && p.verdict==="COMPLETE"?{source:p.source}:{})},issues:[]};
}
