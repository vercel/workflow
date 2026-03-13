'use client';

import Editor, { type EditorProps, type OnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { useTheme } from 'next-themes';
import { useCallback, useEffect, useRef, useState } from 'react';

interface CodeEditorProps extends EditorProps {
  label?: string;
  vimMode?: boolean;
}

export function CodeEditor({
  label,
  options,
  vimMode,
  onMount,
  ...props
}: CodeEditorProps) {
  const { theme } = useTheme();
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const vimRef = useRef<{ dispose: () => void } | null>(null);
  const statusBarRef = useRef<HTMLDivElement | null>(null);
  const [editorMounted, setEditorMounted] = useState(false);

  const handleMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;
      setEditorMounted(true);
      onMount?.(editor, monaco);
    },
    [onMount]
  );

  // Handle vim mode toggling
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    if (vimMode) {
      let cancelled = false;

      // Dynamically import monaco-vim to avoid SSR issues
      import('monaco-vim')
        .then(({ initVimMode }) => {
          if (cancelled) return;
          // Clean up any existing vim mode first
          if (vimRef.current) {
            vimRef.current.dispose();
          }
          vimRef.current = initVimMode(editor, statusBarRef.current);
        })
        .catch(() => {
          // Import may fail in non-browser environments
        });

      return () => {
        cancelled = true;
        if (vimRef.current) {
          vimRef.current.dispose();
          vimRef.current = null;
        }
      };
    }

    if (vimRef.current) {
      vimRef.current.dispose();
      vimRef.current = null;
    }
  }, [vimMode, editorMounted]);

  return (
    <div className="flex flex-col h-full overflow-hidden bg-background">
      {label && (
        <div className="bg-muted px-4 py-2 text-sm font-medium border-b flex items-center justify-between">
          <span>{label}</span>
        </div>
      )}
      <div className="flex-1 relative">
        <Editor
          theme={theme === 'dark' ? 'vs-dark' : 'light'}
          options={{
            ...options,
            minimap: { enabled: false },
            fontSize: 14,
            scrollBeyondLastLine: false,
            automaticLayout: true,
            padding: { top: 16, bottom: 16 },
          }}
          onMount={handleMount}
          {...props}
        />
      </div>
      {vimMode && (
        <div
          ref={statusBarRef}
          className="h-6 px-3 text-xs font-mono bg-muted border-t text-muted-foreground flex items-center"
        />
      )}
    </div>
  );
}
