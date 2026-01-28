#!/usr/bin/env node
function s(t){let e=`${t.name} - ${t.summary}

`;if(e+=`Usage: ${t.usage}
`,t.description){if(e+=`
Description:
`,typeof t.description=="string")for(let n of t.description.split(`
`))e+=n?`  ${n}
`:`
`;else if(t.description.length>0)for(let n of t.description)e+=n?`  ${n}
`:`
`}if(t.options&&t.options.length>0){e+=`
Options:
`;for(let n of t.options)e+=`  ${n}
`}if(t.examples&&t.examples.length>0){e+=`
Examples:
`;for(let n of t.examples)e+=`  ${n}
`}if(t.notes&&t.notes.length>0){e+=`
Notes:
`;for(let n of t.notes)e+=`  ${n}
`}return{stdout:e,stderr:"",exitCode:0}}function o(t){return t.includes("--help")}function r(t,e){return{stdout:"",stderr:e.startsWith("--")?`${t}: unrecognized option '${e}'
`:`${t}: invalid option -- '${e.replace(/^-/,"")}'
`,exitCode:1}}export{s as a,o as b,r as c};
