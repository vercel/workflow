'use client';

import * as jsonColorizer from 'json-colorizer';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface JsonViewProps {
  title?: string;
  data: unknown;
  showCard?: boolean;
}

const MAX_PROPERTY_LENGTH = 512;
const TRUNCATE_PROPERTIES = ['input', 'output', 'eventDetails'];

function shouldTruncate(key: string, value: unknown): boolean {
  if (!TRUNCATE_PROPERTIES.includes(key)) {
    return false;
  }
  const stringified = JSON.stringify(value);
  return stringified.length > MAX_PROPERTY_LENGTH;
}

function truncateData(obj: unknown): unknown {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return obj;
  }

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    result[key] = shouldTruncate(key, value) ? '<truncated>' : value;
  }

  return result;
}

export function JsonView({ title, data, showCard = true }: JsonViewProps) {
  const formatJson = (obj: unknown): string => {
    const truncated = truncateData(obj);
    return JSON.stringify(truncated, null, 2);
  };

  const highlightJson = (json: string): string => {
    // Skip coloring if the JSON is too large
    if (json.length > 10000) {
      return json;
    }
    return jsonColorizer.colorize(json);
  };

  const content = (
    <div className="bg-muted rounded-md p-4 font-mono">
      <pre
        className="text-sm overflow-x-auto whitespace-pre-wrap"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON highlighting
        dangerouslySetInnerHTML={{ __html: highlightJson(formatJson(data)) }}
      />
    </div>
  );

  if (!showCard) {
    return content;
  }

  return (
    <Card>
      {title && (
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
      )}
      <CardContent>{content}</CardContent>
    </Card>
  );
}
