import { c as getWorld, h as hydrateStepArguments, w as waitedUntil, d as WEBHOOK_RESPONSE_WRITABLE, e as WorkflowRuntimeError, E as ERROR_SLUGS, t as trace, f as WorkflowRunId, H as HookId, i as HookToken, j as dehydrateStepReturnValue, k as functionsExports, l as WorkflowName, m as getSpanContextForTraceCarrier, n as HookFound } from './index_ePTMDSOu.mjs';

/**
 * Get the hook by token to find the associated workflow run,
 * and hydrate the `metadata` property if it was set from within
 * the workflow run.
 *
 * @param token - The unique token identifying the hook
 */
async function getHookByToken(token) {
    const world = getWorld();
    const hook = await world.hooks.getByToken(token);
    if (typeof hook.metadata !== 'undefined') {
        hook.metadata = hydrateStepArguments(hook.metadata, [], globalThis);
    }
    return hook;
}
/**
 * Resumes a workflow run by sending a payload to a hook identified by its token.
 *
 * This function is called externally (e.g., from an API route or server action)
 * to send data to a hook and resume the associated workflow run.
 *
 * @param token - The unique token identifying the hook
 * @param payload - The data payload to send to the hook
 * @returns Promise resolving to the hook
 * @throws Error if the hook is not found or if there's an error during the process
 *
 * @example
 *
 * ```ts
 * // In an API route
 * import { resumeHook } from '@workflow/core/runtime';
 *
 * export async function POST(request: Request) {
 *   const { token, data } = await request.json();
 *
 *   try {
 *     const hook = await resumeHook(token, data);
 *     return Response.json({ runId: hook.runId });
 *   } catch (error) {
 *     return new Response('Hook not found', { status: 404 });
 *   }
 * }
 * ```
 */
async function resumeHook(token, payload) {
    return await waitedUntil(() => {
        return trace('HOOK.resume', async (span) => {
            const world = getWorld();
            try {
                const hook = await getHookByToken(token);
                span?.setAttributes({
                    ...HookToken(token),
                    ...HookId(hook.hookId),
                    ...WorkflowRunId(hook.runId),
                });
                // Dehydrate the payload for storage
                const ops = [];
                const dehydratedPayload = dehydrateStepReturnValue(payload, ops, globalThis);
                functionsExports.waitUntil(Promise.all(ops));
                // Create a hook_received event with the payload
                await world.events.create(hook.runId, {
                    eventType: 'hook_received',
                    correlationId: hook.hookId,
                    eventData: {
                        payload: dehydratedPayload,
                    },
                });
                const workflowRun = await world.runs.get(hook.runId);
                span?.setAttributes({
                    ...WorkflowName(workflowRun.workflowName),
                });
                const traceCarrier = workflowRun.executionContext?.traceCarrier;
                if (traceCarrier) {
                    const context = await getSpanContextForTraceCarrier(traceCarrier);
                    if (context) {
                        span?.addLink?.({ context });
                    }
                }
                // Re-trigger the workflow against the deployment ID associated
                // with the workflow run that the hook belongs to
                await world.queue(`__wkf_workflow_${workflowRun.workflowName}`, {
                    runId: hook.runId,
                    // attach the trace carrier from the workflow run
                    traceCarrier: workflowRun.executionContext?.traceCarrier ?? undefined,
                }, {
                    deploymentId: workflowRun.deploymentId,
                });
                return hook;
            }
            catch (err) {
                span?.setAttributes({
                    ...HookToken(token),
                    ...HookFound(false),
                });
                throw err;
            }
        });
    });
}
/**
 * Resumes a webhook by sending a {@link https://developer.mozilla.org/en-US/docs/Web/API/Request | Request}
 * object to a hook identified by its token.
 *
 * This function is called externally (e.g., from an API route or server action)
 * to send a request to a webhook and resume the associated workflow run.
 *
 * @param token - The unique token identifying the hook
 * @param request - The request to send to the hook
 * @returns Promise resolving to the response
 * @throws Error if the hook is not found or if there's an error during the process
 *
 * @example
 *
 * ```ts
 * // In an API route
 * import { resumeWebhook } from '@workflow/core/runtime';
 *
 * export async function POST(request: Request) {
 *   const url = new URL(request.url);
 *   const token = url.searchParams.get('token');
 *
 *   if (!token) {
 *     return new Response('Missing token', { status: 400 });
 *   }
 *
 *   try {
 *     const response = await resumeWebhook(token, request);
 *     return response;
 *   } catch (error) {
 *     return new Response('Webhook not found', { status: 404 });
 *   }
 * }
 * ```
 */
async function resumeWebhook(token, request) {
    const hook = await getHookByToken(token);
    let response;
    let responseReadable;
    if (hook.metadata &&
        typeof hook.metadata === 'object' &&
        'respondWith' in hook.metadata) {
        if (hook.metadata.respondWith === 'manual') {
            const { readable, writable } = new TransformStream();
            responseReadable = readable;
            // The request instance includes the writable stream which will be used
            // to write the response to the client from within the workflow run
            request[WEBHOOK_RESPONSE_WRITABLE] = writable;
        }
        else if (hook.metadata.respondWith instanceof Response) {
            response = hook.metadata.respondWith;
        }
        else {
            throw new WorkflowRuntimeError(`Invalid \`respondWith\` value: ${hook.metadata.respondWith}`, { slug: ERROR_SLUGS.WEBHOOK_INVALID_RESPOND_WITH_VALUE });
        }
    }
    else {
        // No `respondWith` value implies the default behavior of returning a 202
        response = new Response(null, { status: 202 });
    }
    await resumeHook(hook.token, request);
    if (responseReadable) {
        // Wait for the readable stream to emit one chunk,
        // which is the `Response` object
        const reader = responseReadable.getReader();
        const chunk = await reader.read();
        if (chunk.value) {
            response = chunk.value;
        }
        reader.cancel();
    }
    if (!response) {
        throw new WorkflowRuntimeError('Workflow run did not send a response', {
            slug: ERROR_SLUGS.WEBHOOK_RESPONSE_NOT_SENT,
        });
    }
    return response;
}

export { resumeHook as a, getHookByToken as g, resumeWebhook as r };
