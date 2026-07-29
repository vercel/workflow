'use client';

import { track } from '@vercel/analytics';
import { useState } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type UseCase = {
  id: string;
  label: string;
  codeBlock: React.ReactNode;
};

export const UseCasesClient = ({ useCases }: { useCases: UseCase[] }) => {
  const [selectedCase, setSelectedCase] = useState(useCases[0].id);
  const currentCase =
    useCases.find((uc) => uc.id === selectedCase) || useCases[0];

  const handleCaseChange = (value: string) => {
    setSelectedCase(value);
    track('Use case changed', { case: value });
  };

  return (
    <div className="grid md:grid-cols-[1fr_1.5fr] gap-12 md:gap-8 px-4 py-8 sm:px-12 sm:py-12">
      <div className="text-balance flex flex-col gap-2">
        <h2 className="text-heading-20 sm:text-heading-24 md:text-heading-32 lg:text-heading-40 flex flex-wrap sm:block items-center gap-x-2">
          Build anything with
          <Select value={selectedCase} onValueChange={handleCaseChange}>
            <SelectTrigger className="text-heading-20 sm:text-heading-24 md:text-heading-32 lg:text-heading-40 bg-background data-[size=default]:h-auto py-1.5 w-auto sm:mt-1.5 sm:-ml-3">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {useCases.map((useCase) => (
                <SelectItem key={useCase.id} value={useCase.id}>
                  {useCase.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </h2>
        <p className="text-balance text-lg text-muted-foreground mt-2">
          Build reliable, long-running processes with automatic retries, state
          persistence, and observability built in.
        </p>
      </div>
      <div>{currentCase.codeBlock}</div>
    </div>
  );
};
