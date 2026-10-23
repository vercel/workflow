This PR now advances several parallel agent chains independently by default on the Node.js VM. The default pending limit is 3, so groups of up to four parallel branches can start their next model or tool step without waiting for the slowest sibling. Retrying steps are requeued as soon as their attempt settles, and nested parallel tool calls use the same path.

`WORKFLOW_ADVANCE_ONLY_REPLAY_MAX_PENDING` can opt wider groups in. Once a run exceeds its configured limit, it stays on the ordinary wait-for-siblings path for later chained rounds; this keeps wide fan-outs bounded. `WORKFLOW_ADVANCE_ONLY_REPLAY=0` restores the previous lockstep behavior.

The remaining scope limitation is QuickJS, where branch advancement is unchanged. The single-flight concurrency repair still applies there.
