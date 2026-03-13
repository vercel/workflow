'use client';

import type { ReactNode } from 'react';
import { createContext, useContext } from 'react';
import { toast as sonnerToast } from 'sonner';

export interface ToastAdapter {
  success: (message: string, opts?: { description?: string }) => void;
  error: (message: string, opts?: { description?: string }) => void;
  info: (message: string, opts?: { description?: string }) => void;
}

const defaultAdapter: ToastAdapter = {
  success: (msg, opts) => sonnerToast.success(msg, opts),
  error: (msg, opts) => sonnerToast.error(msg, opts),
  info: (msg, opts) => sonnerToast.info(msg, opts),
};

const ToastContext = createContext<ToastAdapter>(defaultAdapter);

/**
 * Provide a custom toast implementation to web-shared components.
 *
 * When not provided, falls back to sonner (works in packages/web).
 * Host apps like vercel-site can supply their own adapter
 * (e.g. Geist useToasts) so toasts render in the host's toast system.
 */
export function ToastProvider({
  toast,
  children,
}: {
  toast: ToastAdapter;
  children: ReactNode;
}): ReactNode {
  return (
    <ToastContext.Provider value={toast}>{children}</ToastContext.Provider>
  );
}

export function useToast(): ToastAdapter {
  return useContext(ToastContext);
}
