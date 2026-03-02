'use client';

import Editor, { type EditorProps } from '@monaco-editor/react';
import { useTheme } from 'next-themes';

interface CodeEditorProps extends EditorProps {
  label?: string;
}

export function CodeEditor({ label, options, ...props }: CodeEditorProps) {
  const { theme } = useTheme();

  return (
    <div className="flex flex-col h-full border rounded-md overflow-hidden bg-background">
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
          {...props}
        />
      </div>
    </div>
  );
}
