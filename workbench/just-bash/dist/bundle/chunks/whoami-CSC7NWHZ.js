import {
  __name
} from "./chunk-Y7IWVHJ4.js";

// dist/commands/whoami/whoami.js
async function whoamiExecute(_args, _ctx) {
  return { stdout: "user\n", stderr: "", exitCode: 0 };
}
__name(whoamiExecute, "whoamiExecute");
var whoami = {
  name: "whoami",
  execute: whoamiExecute
};
export {
  whoami
};
