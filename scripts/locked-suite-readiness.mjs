// Check model-authored test fragments against the fixed fixture before locking.
export function validateLockedSuite(source) {
  const issues=[];
  if(typeof source!=="string")return ["missing_suite"];
  const declared=[...source.matchAll(/(?:const\s+|,\s*)([A-Z])\s*=\s*"([^"]+)"/g)];
  const names=Object.fromEntries(declared.map(([,name,value])=>[name,value]));
  const registered=new Set([...(source.match(/\[A,B\]\.map\(requestId/) ? [names.A,names.B] : [])]);
  for(const match of source.matchAll(/\bact\(pilot,\s*(?:"([^"]+)"|([A-Z]))\s*,/g)) {
    const id=match[1]??names[match[2]];
    if(!registered.has(id))issues.push("unregistered_request_id:"+String(id));
  }
  if(/\bcalls\(\)/.test(source.replace(/get\s+calls\(\)/g,""))&&/get calls\(\)/.test(source))issues.push("calls_getter_invoked");
  return [...new Set(issues)];
}
