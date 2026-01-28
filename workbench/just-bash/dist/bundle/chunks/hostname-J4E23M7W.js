import {
  __name
} from "./chunk-Y7IWVHJ4.js";

// dist/commands/hostname/hostname.js
async function hostnameExecute(_args, _ctx) {
  return { stdout: "localhost\n", stderr: "", exitCode: 0 };
}
__name(hostnameExecute, "hostnameExecute");
var hostname = {
  name: "hostname",
  execute: hostnameExecute
};
export {
  hostname
};
