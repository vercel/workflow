// Stub aliased in place of the `typescript` package in framework server
// bundles. It is only reachable through cosmiconfig's TS-config loader
// (via world packages -> graphile-worker), where `require('typescript')`
// is lazy and never fires at runtime — but bundling converts it into an
// eager top-level evaluation, pulling the entire compiler into the server
// output and executing it at boot.
const typescript = {};

export default typescript;
