'use client';

import type { WorkflowBackendDeprecationNotice } from '@workflow/world-vercel';
import { TriangleAlert } from 'lucide-react';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';

const NOTICE_EVENT = 'workflow-backend-deprecations';
const reportedNotices: WorkflowBackendDeprecationNotice[] = [];

export function publishWorkflowBackendDeprecations(
  notices: WorkflowBackendDeprecationNotice[] | undefined
) {
  if (typeof window === 'undefined' || !notices || notices.length === 0) {
    return;
  }
  for (const notice of notices) {
    if (
      !reportedNotices.some(
        (existing) => noticeKey(existing) === noticeKey(notice)
      )
    ) {
      reportedNotices.push(notice);
    }
  }
  window.dispatchEvent(
    new CustomEvent<WorkflowBackendDeprecationNotice[]>(NOTICE_EVENT, {
      detail: notices,
    })
  );
}

interface DeprecationContextValue {
  notices: WorkflowBackendDeprecationNotice[];
}

const DeprecationContext = createContext<DeprecationContextValue>({
  notices: [],
});

function noticeKey(notice: WorkflowBackendDeprecationNotice) {
  return [
    notice.endpoint,
    notice.preferredEndpoint,
    notice.preferredVersion,
    notice.deprecationDate,
    notice.sunsetDate,
    notice.state,
  ].join('|');
}

export function DeprecationNoticeProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [notices, setNotices] =
    useState<WorkflowBackendDeprecationNotice[]>(reportedNotices);
  const addNotices = useCallback(
    (nextNotices: WorkflowBackendDeprecationNotice[]) => {
      setNotices((current) => {
        const byKey = new Map(
          current.map((notice) => [noticeKey(notice), notice])
        );
        for (const notice of nextNotices) {
          byKey.set(noticeKey(notice), notice);
        }
        return [...byKey.values()];
      });
    },
    []
  );

  useEffect(() => {
    const onNotices = (event: Event) => {
      addNotices(
        (event as CustomEvent<WorkflowBackendDeprecationNotice[]>).detail
      );
    };
    window.addEventListener(NOTICE_EVENT, onNotices);
    return () => window.removeEventListener(NOTICE_EVENT, onNotices);
  }, [addNotices]);

  const value = useMemo(() => ({ notices }), [notices]);
  return (
    <DeprecationContext.Provider value={value}>
      {children}
    </DeprecationContext.Provider>
  );
}

export function WorkflowBackendDeprecationAlerts() {
  const { notices } = useContext(DeprecationContext);
  if (notices.length === 0) return null;

  return (
    <div className="px-6 pt-4 space-y-3">
      {notices.map((notice) => (
        <WorkflowBackendDeprecationAlert
          key={noticeKey(notice)}
          notice={notice}
        />
      ))}
    </div>
  );
}

function WorkflowBackendDeprecationAlert({
  notice,
}: {
  notice: WorkflowBackendDeprecationNotice;
}) {
  const stateMessage = {
    removed: 'has been removed.',
    scheduled: 'is scheduled for deprecation.',
    deprecated: 'is deprecated.',
  }[notice.state];

  return (
    <Alert>
      <TriangleAlert className="h-4 w-4" />
      <AlertTitle>Workflow backend endpoint deprecated</AlertTitle>
      <AlertDescription>
        <p>
          <code>{notice.endpoint}</code> {stateMessage} Update{' '}
          <code>workflow</code> and <code>@workflow/world-vercel</code> to use
          supported backend endpoints.
        </p>
        {notice.preferredEndpoint ? (
          <p>
            Preferred endpoint: <code>{notice.preferredEndpoint}</code>
          </p>
        ) : null}
        {notice.deprecationDate || notice.sunsetDate ? (
          <p>
            {notice.deprecationDate
              ? `Deprecated: ${notice.deprecationDate}. `
              : ''}
            {notice.sunsetDate ? `Removal date: ${notice.sunsetDate}.` : ''}
          </p>
        ) : null}
        {notice.documentationUrl ? (
          <p>
            <a
              href={notice.documentationUrl}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              Migration guide
            </a>
          </p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
