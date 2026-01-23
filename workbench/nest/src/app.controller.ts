import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { getHookByToken, getRun, resumeHook, start } from 'workflow/api';
import {
  WorkflowRunFailedError,
  WorkflowRunNotCompletedError,
} from 'workflow/internal/errors';
import { hydrateWorkflowArguments } from 'workflow/internal/serialization';
import { getWorld, healthCheck } from 'workflow/runtime';
import { allWorkflows } from './_workflows.js';

@Controller('api')
export class AppController {
  @Post('hook')
  async resumeWorkflowHook(
    @Body() body: { token: string; data: any } | string,
    @Res() res: Response
  ) {
    // Handle body as string (when Content-Type is not application/json) or object
    const parsedBody = typeof body === 'string' ? JSON.parse(body) : body;
    const { token, data } = parsedBody;

    let hook: Awaited<ReturnType<typeof getHookByToken>>;
    try {
      hook = await getHookByToken(token);
      console.log('hook', hook);
    } catch (error) {
      console.log('error during getHookByToken', error);
      // Return 422 for invalid token with null body (matching other workbench apps)
      return res.status(HttpStatus.UNPROCESSABLE_ENTITY).json(null);
    }

    await resumeHook(hook.token, {
      ...data,
      // @ts-expect-error metadata is not typed
      customData: hook.metadata?.customData,
    });

    return res.status(HttpStatus.OK).json(hook);
  }

  @Post('trigger')
  async startWorkflowRun(
    @Query('workflowFile') workflowFile: string = 'workflows/99_e2e.ts',
    @Query('workflowFn') workflowFn: string = 'simple',
    @Query('args') argsParam: string | undefined,
    @Body() bodyData: any
  ) {
    if (!workflowFile) {
      throw new HttpException(
        'No workflowFile query parameter provided',
        HttpStatus.BAD_REQUEST
      );
    }
    const workflows = allWorkflows[workflowFile as keyof typeof allWorkflows];
    if (!workflows) {
      throw new HttpException(
        `Workflow file "${workflowFile}" not found`,
        HttpStatus.BAD_REQUEST
      );
    }

    if (!workflowFn) {
      throw new HttpException(
        'No workflow query parameter provided',
        HttpStatus.BAD_REQUEST
      );
    }

    // Handle static method lookups (e.g., "Calculator.calculate")
    let workflow: unknown;
    if (workflowFn.includes('.')) {
      const [className, methodName] = workflowFn.split('.');
      const cls = workflows[className as keyof typeof workflows];
      if (cls && typeof cls === 'function') {
        workflow = (cls as Record<string, unknown>)[methodName];
      }
    } else {
      workflow = workflows[workflowFn as keyof typeof workflows];
    }
    if (!workflow) {
      throw new HttpException(
        `Workflow "${workflowFn}" not found`,
        HttpStatus.BAD_REQUEST
      );
    }

    let args: any[] = [];

    // Args from query string
    if (argsParam) {
      args = argsParam.split(',').map((arg) => {
        const num = parseFloat(arg);
        return Number.isNaN(num) ? arg.trim() : num;
      });
    } else if (bodyData && typeof bodyData === 'string') {
      // Body came as string (e.g., no Content-Type header)
      args = hydrateWorkflowArguments(JSON.parse(bodyData), globalThis);
    } else if (bodyData && typeof bodyData === 'object') {
      // Body was parsed as JSON
      if (Array.isArray(bodyData) && bodyData.length > 0) {
        args = hydrateWorkflowArguments(bodyData, globalThis);
      } else if (Object.keys(bodyData).length > 0) {
        args = hydrateWorkflowArguments(bodyData, globalThis);
      } else {
        args = [42];
      }
    } else {
      args = [42];
    }
    console.log(
      `Starting "${workflowFn}" workflow with args: ${JSON.stringify(args)}`
    );

    try {
      const run = await start(workflow as any, args as any);
      console.log('Run:', run);
      return run;
    } catch (err) {
      console.error(`Failed to start!!`, err);
      throw err;
    }
  }

  @Get('trigger')
  async getWorkflowRunResult(
    @Query('runId') runId: string | undefined,
    @Query('output-stream') outputStreamParam: string | undefined,
    @Res() res: Response
  ) {
    if (!runId) {
      throw new HttpException('No runId provided', HttpStatus.BAD_REQUEST);
    }

    if (outputStreamParam) {
      const namespace =
        outputStreamParam === '1' ? undefined : outputStreamParam;
      const run = getRun(runId);
      const stream = run.getReadable({
        namespace,
      });

      res.setHeader('Content-Type', 'application/octet-stream');
      const reader = stream.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // Add JSON framing to each chunk, wrapping binary data in base64
          const data =
            value instanceof Uint8Array
              ? { data: Buffer.from(value).toString('base64') }
              : value;
          res.write(`${JSON.stringify(data)}\n`);
        }
        res.end();
      } catch (error) {
        console.error('Error streaming data:', error);
        res.end();
      }
      return;
    }

    try {
      const run = getRun(runId);
      const returnValue = await run.returnValue;
      console.log('Return value:', returnValue);

      // Include run metadata in headers
      const [createdAt, startedAt, completedAt] = await Promise.all([
        run.createdAt,
        run.startedAt,
        run.completedAt,
      ]);

      res.setHeader(
        'X-Workflow-Run-Created-At',
        createdAt?.toISOString() || ''
      );
      res.setHeader(
        'X-Workflow-Run-Started-At',
        startedAt?.toISOString() || ''
      );
      res.setHeader(
        'X-Workflow-Run-Completed-At',
        completedAt?.toISOString() || ''
      );

      if (returnValue instanceof ReadableStream) {
        res.setHeader('Content-Type', 'application/octet-stream');
        const reader = returnValue.getReader();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
          res.end();
        } catch (streamError) {
          console.error('Error streaming return value:', streamError);
          res.end();
        }
        return;
      }

      return res.json(returnValue);
    } catch (error) {
      if (error instanceof Error) {
        if (WorkflowRunNotCompletedError.is(error)) {
          return res.status(HttpStatus.ACCEPTED).json({
            ...error,
            name: error.name,
            message: error.message,
          });
        }

        if (WorkflowRunFailedError.is(error)) {
          const cause = error.cause as any;
          return res.status(HttpStatus.BAD_REQUEST).json({
            ...error,
            name: error.name,
            message: error.message,
            cause: {
              message: cause.message,
              stack: cause.stack,
              code: cause.code,
            },
          });
        }
      }

      console.error(
        'Unexpected error while getting workflow return value:',
        error
      );
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        error: 'Internal server error',
      });
    }
  }

  @Post('test-health-check')
  @HttpCode(HttpStatus.OK)
  async testHealthCheck(@Body() body: { endpoint?: string; timeout?: number }) {
    // This route tests the queue-based health check functionality
    try {
      const { endpoint = 'workflow', timeout = 30000 } = body;

      console.log(
        `Testing queue-based health check for endpoint: ${endpoint}, timeout: ${timeout}ms`
      );

      const world = getWorld();
      const result = await healthCheck(world, endpoint as 'workflow' | 'step', {
        timeout,
      });

      console.log(`Health check result:`, result);

      return result;
    } catch (error) {
      console.error('Health check test failed:', error);
      throw new HttpException(
        {
          healthy: false,
          error: error instanceof Error ? error.message : String(error),
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Post('test-direct-step-call')
  async invokeStepDirectly(@Body() body: { x: number; y: number }) {
    // This route tests calling step functions directly outside of any workflow context
    // After the SWC compiler changes, step functions in client mode have their directive removed
    // and keep their original implementation, allowing them to be called as regular async functions
    const { add } = await import('./workflows/98_duplicate_case.js');

    const { x, y } = body;

    console.log(`Calling step function directly with x=${x}, y=${y}`);

    // Call step function directly as a regular async function (no workflow context)
    const result = await add(x, y);
    console.log(`add(${x}, ${y}) = ${result}`);

    return { result };
  }
}
